#!/usr/bin/env python3
"""Watch a backfill run and terminate the Lambda GPU instance the moment
it goes idle. Designed to be set-and-forget: paired with
``scripts/lambda_grab_gpu.py`` (which spins the box up), this is the
"safely turn it back off" half of the loop.

Default signal source is the SLURM queue on ``firebird.swarthmore.edu``:
the daily backfill cycle submits jobs named ``bp-*``, and the box is
considered idle when no such job has been seen for ``--idle-minutes``
consecutive minutes. Other signals (Ollama prompt-rate, Firestore write
rate, a sentinel file) can be wired in later if firebird ever changes.

Lifecycle (state machine):

    WAITING_FOR_ACTIVITY
        no bp-* jobs ever seen this run
        do nothing for up to --startup-grace-minutes (default 360 = 6h)
        seeing any bp-* job  →  ACTIVE
        startup grace expires →  exit 2 (failsafe; user clearly forgot
                                 to launch the backfill — DO NOT
                                 silently kill the GPU)

    ACTIVE
        at least one bp-* job has been observed at some point
        seeing zero jobs    →  IDLE_PENDING (start countdown)
        seeing any job      →  stay ACTIVE

    IDLE_PENDING
        countdown to termination
        seeing any job      →  ACTIVE  (reset countdown)
        --idle-minutes elapse →  TERMINATE

    TERMINATE
        call Lambda Cloud terminate API for --instance-id
        kill the local SSH tunnel (best-effort, by port match)
        macOS notification
        exit 0

Safety rails:
  * ``--max-runtime-hours`` hard-stop. Default 48h. Even if the queue
    looks busy, at this point we terminate so a stuck job doesn't burn
    your credits indefinitely. Set high enough to comfortably cover the
    real backfill — the 5-month archive run should fit in ~10-30h on
    Broadcastify's quota-throttled cadence, but the point is having ANY
    upper bound.
  * ``--keep-alive-file`` (default: ``/tmp/ollama_keep_alive``). If
    present, the script logs and skips termination on every tick.
    ``touch /tmp/ollama_keep_alive`` from anywhere to pause the
    auto-terminator, ``rm`` it to resume.
  * ``--dry-run`` flag prints the terminate call but doesn't execute.

Auth: same key file as ``lambda_grab_gpu.py`` (``LAMBDA_CLOUD_API_KEY``
in env or ``.env``). SSH to firebird uses your usual key — pass
``--firebird-host`` if your ``~/.ssh/config`` alias differs.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import shlex
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from base64 import b64encode
from pathlib import Path
from typing import Optional

LOG = logging.getLogger("auto-terminate")
CLOUD_BASE = "https://cloud.lambda.ai/api/v1"


# ── Lambda Cloud helpers ────────────────────────────────────────────


def _auth_header(api_key: str) -> str:
    return "Basic " + b64encode(f"{api_key}:".encode()).decode()


def lambda_terminate(api_key: str, instance_id: str) -> dict:
    """Issue terminate. Raises on non-200 so the caller can report and
    keep trying — Lambda's API can flake with 5xx during high load."""
    body = json.dumps({"instance_ids": [instance_id]}).encode()
    req = urllib.request.Request(
        f"{CLOUD_BASE}/instance-operations/terminate",
        data=body,
        method="POST",
    )
    req.add_header("Authorization", _auth_header(api_key))
    req.add_header("Content-Type", "application/json")
    # Lambda's edge runs Cloudflare with WAF rules that 1010 vanilla
    # urllib UAs (same gotcha lambda_grab_gpu.py works around).
    req.add_header("User-Agent", "citypulse-auto-terminate/1.0 (curl-compatible)")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def lambda_instance_status(api_key: str, instance_id: str) -> Optional[str]:
    """Return the instance's current status string, or None on 404 (which
    means it's already gone — treated as success at the caller)."""
    req = urllib.request.Request(
        f"{CLOUD_BASE}/instances/{instance_id}",
        method="GET",
    )
    req.add_header("Authorization", _auth_header(api_key))
    req.add_header("User-Agent", "citypulse-auto-terminate/1.0 (curl-compatible)")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode()).get("data", {})
            return data.get("status")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def load_env_key() -> str:
    """Read LAMBDA_CLOUD_API_KEY from env, falling back to the repo .env."""
    key = os.environ.get("LAMBDA_CLOUD_API_KEY", "").strip()
    if key:
        return key
    # Look in CWD .env, then in the repo root (script lives in scripts/).
    candidates = [Path(".env"), Path(__file__).resolve().parent.parent / ".env"]
    for env_path in candidates:
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                if line.startswith("LAMBDA_CLOUD_API_KEY="):
                    return line.split("=", 1)[1].strip()
    raise SystemExit(
        "LAMBDA_CLOUD_API_KEY not found in env or .env. "
        "It's the same key lambda_grab_gpu.py uses."
    )


# ── Activity probe ──────────────────────────────────────────────────


def count_backfill_jobs(firebird_host: str, job_prefix: str) -> Optional[int]:
    """SSH to firebird and count SLURM jobs whose name starts with
    ``job_prefix`` (default ``bp-``). Returns ``None`` on transient SSH
    failure so the caller can retry rather than declaring idle.
    """
    cmd = [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=15",
        "-o", "ServerAliveInterval=10",
        "-o", "StrictHostKeyChecking=accept-new",
        firebird_host,
        # `--noheader` keeps the count clean; `%j` is job name.
        f"squeue -u $USER --noheader --format='%j' 2>/dev/null | "
        f"grep -c '^{shlex.quote(job_prefix)}' || true",
    ]
    try:
        out = subprocess.run(
            cmd, check=False, capture_output=True, text=True, timeout=45,
        )
    except subprocess.TimeoutExpired:
        LOG.warning("SSH to %s timed out", firebird_host)
        return None
    if out.returncode != 0:
        LOG.warning(
            "SSH to %s exit=%d stderr=%s",
            firebird_host, out.returncode, out.stderr.strip()[:200],
        )
        return None
    try:
        return int(out.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        LOG.warning("Could not parse job count from %r", out.stdout)
        return None


# ── Tunnel cleanup ──────────────────────────────────────────────────


def kill_local_tunnel(local_port: int) -> None:
    """Kill any local ssh process listening on ``local_port``. Best-
    effort — failure here is fine because the box is gone anyway."""
    try:
        out = subprocess.run(
            ["lsof", "-nP", "-iTCP:%d" % local_port, "-sTCP:LISTEN", "-t"],
            check=False, capture_output=True, text=True, timeout=5,
        )
    except Exception as e:
        LOG.debug("lsof failed: %s", e)
        return
    pids = [int(p) for p in out.stdout.split() if p.isdigit()]
    for pid in pids:
        try:
            os.kill(pid, 15)
            LOG.info("Killed local tunnel PID %d on port %d", pid, local_port)
        except OSError as e:
            LOG.warning("Could not kill PID %d: %s", pid, e)


# ── macOS notification ─────────────────────────────────────────────


def notify_macos(title: str, message: str) -> None:
    if sys.platform != "darwin":
        return
    try:
        subprocess.run(
            ["osascript", "-e",
             f'display notification "{message}" with title "{title}"'],
            check=False, capture_output=True,
        )
    except Exception:
        pass


# ── Main loop ───────────────────────────────────────────────────────


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--instance-id", required=True,
                   help="Lambda instance id to terminate (the one printed by lambda_grab_gpu.py)")
    p.add_argument("--local-port", type=int, default=11435,
                   help="Local port the SSH tunnel is bound to (default: 11435 — matches .env)")
    p.add_argument("--firebird-host", default="firebird",
                   help="SSH alias or user@host for the SLURM submit node (default: firebird)")
    p.add_argument("--job-prefix", default="bp-",
                   help="SLURM job-name prefix that signals 'backfill is active' (default: bp-)")
    p.add_argument("--poll-interval-seconds", type=int, default=300,
                   help="How often to poll SLURM (default: 300 = every 5 min)")
    p.add_argument("--idle-minutes", type=int, default=45,
                   help="Consecutive minutes of zero bp-* jobs before terminating (default: 45)")
    p.add_argument("--startup-grace-minutes", type=int, default=360,
                   help="If no bp-* job is EVER seen within this window, exit 2 instead of terminating (default: 360 = 6h). Protects against starting the watcher before the user actually launches the backfill.")
    p.add_argument("--max-runtime-hours", type=float, default=48.0,
                   help="Hard upper bound on watcher runtime — terminate the GPU at this point regardless (default: 48h, ≈ $62 max spend)")
    p.add_argument("--keep-alive-file", default="/tmp/ollama_keep_alive",
                   help="If this file exists at termination time, skip and keep polling. `touch` it to pause auto-terminate. (default: /tmp/ollama_keep_alive)")
    p.add_argument("--dry-run", action="store_true",
                   help="Log the terminate call but don't execute (handy for testing the state machine)")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    api_key = load_env_key()

    # Fail fast if we can't even reach the instance metadata.
    initial_status = lambda_instance_status(api_key, args.instance_id)
    if initial_status is None:
        LOG.error("Instance %s does not exist (404). Nothing to terminate.",
                  args.instance_id)
        return 1
    LOG.info("Watching instance %s (status=%s) → terminate when SLURM idle "
             "for %d min", args.instance_id, initial_status, args.idle_minutes)

    started_at = time.time()
    state = "WAITING_FOR_ACTIVITY"
    seen_active_at: Optional[float] = None  # when we last saw any bp-* job
    idle_since: Optional[float] = None      # when the queue first went empty in ACTIVE

    while True:
        runtime_h = (time.time() - started_at) / 3600.0
        if runtime_h >= args.max_runtime_hours:
            LOG.warning(
                "Hit max-runtime-hours (%.1fh ≥ %.1fh). Forcing terminate.",
                runtime_h, args.max_runtime_hours,
            )
            state = "TERMINATE"

        if state != "TERMINATE":
            count = count_backfill_jobs(args.firebird_host, args.job_prefix)
            if count is None:
                # SSH flake — don't change state, just retry next tick.
                LOG.info("[poll] SSH probe failed; retrying in %ds",
                         args.poll_interval_seconds)
                time.sleep(args.poll_interval_seconds)
                continue

            now = time.time()
            if state == "WAITING_FOR_ACTIVITY":
                if count > 0:
                    LOG.info("[poll] First activity: %d %s* jobs queued. → ACTIVE",
                             count, args.job_prefix)
                    state = "ACTIVE"
                    seen_active_at = now
                else:
                    grace_min = (now - started_at) / 60.0
                    if grace_min >= args.startup_grace_minutes:
                        LOG.error(
                            "Startup grace exhausted (%dm) without ever "
                            "seeing a %s* job. Bailing out (exit 2) so the "
                            "GPU keeps running — looks like backfill was "
                            "never launched.",
                            args.startup_grace_minutes, args.job_prefix,
                        )
                        return 2
                    LOG.info("[poll] WAITING (%.1fm / %dm grace) — 0 %s* jobs",
                             grace_min, args.startup_grace_minutes, args.job_prefix)

            elif state == "ACTIVE":
                if count > 0:
                    seen_active_at = now
                    idle_since = None
                    LOG.info("[poll] ACTIVE — %d %s* jobs queued",
                             count, args.job_prefix)
                else:
                    idle_since = now
                    state = "IDLE_PENDING"
                    LOG.info("[poll] Queue empty → IDLE_PENDING (will terminate "
                             "after %dm of continued idleness)", args.idle_minutes)

            elif state == "IDLE_PENDING":
                if count > 0:
                    LOG.info("[poll] %d %s* jobs reappeared → ACTIVE (reset idle timer)",
                             count, args.job_prefix)
                    state = "ACTIVE"
                    seen_active_at = now
                    idle_since = None
                else:
                    idle_min = (now - (idle_since or now)) / 60.0
                    LOG.info("[poll] IDLE_PENDING — %.1fm / %dm idle",
                             idle_min, args.idle_minutes)
                    if idle_min >= args.idle_minutes:
                        state = "TERMINATE"

        if state == "TERMINATE":
            if os.path.exists(args.keep_alive_file):
                LOG.warning(
                    "Keep-alive file %s present — skipping terminate, will "
                    "re-check next tick. `rm %s` to allow termination.",
                    args.keep_alive_file, args.keep_alive_file,
                )
                # Drop back to IDLE_PENDING so we re-evaluate fresh next tick.
                state = "IDLE_PENDING"
                idle_since = time.time() - args.idle_minutes * 60  # already at threshold
                time.sleep(args.poll_interval_seconds)
                continue

            LOG.info("Terminating instance %s", args.instance_id)
            if args.dry_run:
                LOG.info("--dry-run set; would call POST /instance-operations/terminate")
            else:
                # Lambda's terminate occasionally 5xx's; retry briefly.
                terminated = False
                for attempt in range(5):
                    try:
                        resp = lambda_terminate(api_key, args.instance_id)
                        LOG.info("Terminate response: %s", json.dumps(resp)[:300])
                        terminated = True
                        break
                    except Exception as e:
                        wait = min(2 ** attempt * 5, 60)
                        LOG.warning("Terminate attempt %d failed: %s — retrying in %ds",
                                    attempt + 1, e, wait)
                        time.sleep(wait)
                if not terminated:
                    LOG.error("Failed to terminate after 5 attempts. The GPU "
                              "is still running — terminate manually from the "
                              "Lambda dashboard or rerun this script.")
                    notify_macos("Lambda auto-terminate FAILED",
                                 f"Could not terminate {args.instance_id} — manual action required")
                    return 3

            kill_local_tunnel(args.local_port)
            notify_macos(
                "Lambda GPU terminated",
                f"Backfill done; killed instance {args.instance_id} after "
                f"{runtime_h:.1f}h of runtime",
            )
            LOG.info("Done. Total watcher runtime: %.2fh", runtime_h)
            return 0

        time.sleep(args.poll_interval_seconds)


if __name__ == "__main__":
    sys.exit(main())
