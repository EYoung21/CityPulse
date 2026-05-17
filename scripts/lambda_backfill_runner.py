#!/usr/bin/env python3
"""Lambda-side backfill orchestrator.

Runs ``backfill_archives.py`` for every active Pulse city sequentially.
Designed to be the *only* backfill process in the project; the previous
Firebird/SLURM fan-out has been retired (see commit history). It is
intentionally single-process so we cooperate with Broadcastify's
per-account quota even when their Premium tier raises the ceiling.

Why a wrapper instead of just looping in shell:
    * Heartbeat file (``/var/log/lambda_backfill.heartbeat``) that the
      auto-terminator on the laptop can poll to decide "are we still
      making forward progress, or burning $1.29/hr to do nothing?"
      The heartbeat is JSON: ``{"ts": …, "city": …, "feed": …,
      "transcripts_total": …}``.
    * Restart-on-failure with capped backoff. ``backfill_archives.py``
      can crash (faster-whisper OOM, ffmpeg pipe error, transient
      network), and on Lambda we don't want a single OOM to permanently
      kill the run. systemd would restart the whole process; this
      wrapper restarts the *current city* and continues.
    * Per-city skip on QUOTA EXHAUSTED: if Broadcastify daily quota
      trips during one city, we skip that city for COOLDOWN_AFTER_QUOTA
      seconds rather than burning forever on retries.
    * Stable cycle: after all cities finish (or skip), the wrapper
      sleeps ``CYCLE_SLEEP_S`` and starts the next pass. So an
      indefinitely-running systemd unit eventually picks up new
      Broadcastify archives as days roll over.

Env vars consumed by the wrapper itself (the underlying
``backfill_archives.py`` reads its own; see that file):
    BACKFILL_CITY_GLOB     space-separated city slugs to include
                           (default: every cities/<slug>/config.yaml)
    BACKFILL_DAY_LIMIT     int days back to process per city
                           (default: 150 ≈ 5 months)
    BACKFILL_HEARTBEAT     path for the heartbeat JSON (default
                           /var/log/lambda_backfill.heartbeat)
    COOLDOWN_AFTER_QUOTA   seconds to wait before retrying a city
                           that hit the daily Broadcastify quota
                           (default 7200 = 2h, well past the
                           midnight-ET reset)
    CYCLE_SLEEP_S          seconds between full passes over all
                           cities (default 600 = 10min)
"""

from __future__ import annotations

import argparse
import datetime
import glob
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
HEARTBEAT_PATH = Path(os.environ.get("BACKFILL_HEARTBEAT", "/var/log/lambda_backfill.heartbeat"))
COOLDOWN_AFTER_QUOTA = int(os.environ.get("COOLDOWN_AFTER_QUOTA", "7200"))
CYCLE_SLEEP_S = int(os.environ.get("CYCLE_SLEEP_S", "600"))
DAY_LIMIT = int(os.environ.get("BACKFILL_DAY_LIMIT", "150"))


def heartbeat(state: dict) -> None:
    """Write a JSON heartbeat. Tolerant of permission errors so the
    process doesn't die just because /var/log is restricted."""
    try:
        HEARTBEAT_PATH.parent.mkdir(parents=True, exist_ok=True)
        with HEARTBEAT_PATH.open("w") as f:
            json.dump({"ts": datetime.datetime.now(datetime.timezone.utc).isoformat(), **state}, f)
    except OSError as e:
        print(f"[heartbeat] couldn't write {HEARTBEAT_PATH}: {e}", flush=True)


def discover_cities() -> list[Path]:
    """Resolve which cities/<slug>/config.yaml files to process and in
    what order.

    When BACKFILL_CITY_GLOB is set, the listed order is preserved as
    the run order. That matters because Broadcastify enforces a daily
    download quota per account: whichever city goes first gets the
    freshest quota window after each midnight-ET reset. Cities later in
    the rotation can find the quota already drained and 429 out of an
    entire pass before producing a single segment. Putting the most-
    sensitive city first lets operators give it priority without
    rebuilding the wrapper.

    When unset, fall back to alphabetical for deterministic ordering
    across restarts."""
    glob_filter = os.environ.get("BACKFILL_CITY_GLOB", "").split()
    if glob_filter:
        all_cfgs = {c.parent.name: c for c in REPO_ROOT.glob("cities/*/config.yaml")}
        # Preserve the BACKFILL_CITY_GLOB order; silently skip slugs
        # that don't have a config file (typo / removed city) so a
        # stale env var doesn't crash the whole run.
        return [all_cfgs[slug] for slug in glob_filter if slug in all_cfgs]
    return sorted(REPO_ROOT.glob("cities/*/config.yaml"))


def run_one_city(cfg: Path) -> tuple[int, int]:
    """Return (exit_code, transcripts_observed). transcripts_observed
    is parsed best-effort from the child's stdout 'Total: N transcripts'
    summary line so the heartbeat reflects real progress.

    Heartbeat strategy: a daemon thread ticks every HEARTBEAT_INTERVAL_S
    seconds with the most recent state, INDEPENDENTLY of child stdout
    activity. This matters because backfill_archives.py spends long
    stretches sleeping inside requests.get / time.sleep (Broadcastify
    backoff can be 60-1800s) without writing to stdout. Without the
    timer, the auto-terminator would see a stale heartbeat and kill the
    GPU even though the child is healthy and waiting on the network.
    """
    print(f"\n{'='*60}\n=== City: {cfg.parent.name}  ({cfg})\n{'='*60}", flush=True)
    heartbeat({"city": cfg.parent.name, "phase": "starting", "feed": None})

    cmd = [
        sys.executable,
        str(REPO_ROOT / "backfill_archives.py"),
        "--config", str(cfg),
        "--days", str(DAY_LIMIT),
        "--skip-existing",
    ]
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")

    # Mutable state shared with the heartbeat thread. Updated by the
    # stdout reader in this same thread (no lock needed: dict mutations
    # in CPython are atomic at the slot granularity, and we only read
    # whole values from the heartbeat thread).
    state = {
        "city": cfg.parent.name,
        "phase": "starting",
        "feed": None,
        "transcripts_so_far": 0,
        "quota_exhausted": False,
        "last_stdout_at": time.time(),
    }
    stop_heartbeat = threading.Event()

    def _heartbeat_ticker():
        # Ticks roughly every 20s regardless of child stdout activity.
        # 20s is well below the auto-terminator's default
        # max-heartbeat-age-minutes=15 so we have huge headroom even if
        # the box is briefly swapped out under load.
        while not stop_heartbeat.is_set():
            silent_for = int(time.time() - state["last_stdout_at"])
            heartbeat({
                "city": state["city"],
                "phase": state["phase"],
                "feed": state["feed"],
                "transcripts_so_far": state["transcripts_so_far"],
                "quota_exhausted": state["quota_exhausted"],
                "stdout_silent_for_s": silent_for,
            })
            stop_heartbeat.wait(20)

    hb_thread = threading.Thread(target=_heartbeat_ticker, daemon=True)
    hb_thread.start()

    proc = subprocess.Popen(
        cmd, cwd=REPO_ROOT, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        bufsize=1,
    )
    assert proc.stdout is not None
    state["phase"] = "running"

    try:
        for line in proc.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            state["last_stdout_at"] = time.time()
            stripped = line.strip()

            # Parse interesting markers from backfill_archives.py output.
            if stripped.startswith("[") and "] Fetching archives" in stripped:
                # "[2026-04-22] [PPD Citywide] Fetching archives..."
                bracket_parts = stripped.split("]")
                if len(bracket_parts) >= 3:
                    state["feed"] = bracket_parts[1].strip(" [")
            elif "QUOTA EXHAUSTED" in stripped:
                state["quota_exhausted"] = True
            elif stripped.startswith("Total:"):
                # "Total: 123 transcripts from 45 archive segments"
                tokens = stripped.split()
                if len(tokens) >= 2 and tokens[1].isdigit():
                    state["transcripts_so_far"] = int(tokens[1])
    except KeyboardInterrupt:
        stop_heartbeat.set()
        proc.terminate()
        raise

    rc = proc.wait()
    stop_heartbeat.set()
    hb_thread.join(timeout=2)

    heartbeat({
        "city": cfg.parent.name,
        "phase": "done",
        "feed": state["feed"],
        "transcripts_total": state["transcripts_so_far"],
        "quota_exhausted": state["quota_exhausted"],
        "exit_code": rc,
    })
    return rc, state["transcripts_so_far"]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--once", action="store_true",
                   help="Run a single pass over all cities and exit (default: loop forever)")
    args = p.parse_args(argv)

    cfgs = discover_cities()
    if not cfgs:
        print("No cities/<slug>/config.yaml found, aborting.", file=sys.stderr)
        return 2

    print(f"Lambda backfill runner: {len(cfgs)} cities, day-limit={DAY_LIMIT}", flush=True)
    print(f"  Cities: {', '.join(c.parent.name for c in cfgs)}", flush=True)
    print(f"  Heartbeat: {HEARTBEAT_PATH}", flush=True)
    print(f"  PP_BRIDGE_URL: {os.environ.get('PP_BRIDGE_URL', '(default)')}", flush=True)

    # On clean shutdown (systemctl stop), write a final heartbeat
    # so the auto-terminator can tell us apart from a crash.
    def _on_term(_sig, _frm):
        heartbeat({"phase": "shutdown_clean"})
        sys.exit(0)
    signal.signal(signal.SIGTERM, _on_term)
    signal.signal(signal.SIGINT, _on_term)

    quota_cooldown_until: dict[str, float] = {}
    cycle = 0
    while True:
        cycle += 1
        print(f"\n###### CYCLE {cycle} starting ######", flush=True)
        for cfg in cfgs:
            slug = cfg.parent.name
            now = time.time()
            if quota_cooldown_until.get(slug, 0) > now:
                wait = int(quota_cooldown_until[slug] - now)
                print(f"[skip] {slug}: in quota cooldown for {wait}s more", flush=True)
                continue
            try:
                rc, _t = run_one_city(cfg)
            except KeyboardInterrupt:
                print("Interrupted; exiting.", flush=True)
                return 130
            except Exception as e:
                print(f"[city {slug}] WRAPPER ERROR: {e}; sleeping 60s and continuing", flush=True)
                time.sleep(60)
                continue

            # If the child exited with the QUOTA EXHAUSTED summary having
            # appeared, park this city until cooldown elapses. The child
            # itself exits 0 on quota exhaustion (it's a graceful stop),
            # so we use the heartbeat we just wrote to detect it.
            try:
                hb = json.loads(HEARTBEAT_PATH.read_text())
            except (OSError, ValueError):
                hb = {}
            if hb.get("quota_exhausted"):
                quota_cooldown_until[slug] = time.time() + COOLDOWN_AFTER_QUOTA
                print(
                    f"[quota] {slug}: parking for {COOLDOWN_AFTER_QUOTA}s "
                    f"(until {datetime.datetime.fromtimestamp(quota_cooldown_until[slug]).isoformat()})",
                    flush=True,
                )
            elif rc != 0:
                print(f"[city {slug}] backfill_archives exited rc={rc}; will retry next cycle", flush=True)

        if args.once:
            print("--once set; exiting after one cycle.", flush=True)
            return 0
        print(f"\n###### CYCLE {cycle} done; sleeping {CYCLE_SLEEP_S}s ######", flush=True)
        time.sleep(CYCLE_SLEEP_S)


if __name__ == "__main__":
    sys.exit(main())
