#!/usr/bin/env python3
"""Poll Lambda Cloud for GPU capacity, launch + bootstrap Ollama on first hit.

Lambda's GPU inventory is famously volatile — desirable instance types
(A10, A100, H100) flicker in and out of "available" within seconds.
Manually mashing the launch button doesn't scale; this script does it
for you.

What it does:

  1. Polls ``GET /api/v1/instance-types`` every ``--interval`` seconds.
  2. Walks ``--priority`` (cheapest-first by default) and grabs the
     first instance type with at least one region reporting capacity.
  3. POSTs a launch request, then polls ``GET /api/v1/instances/<id>``
     until the instance reports ``status: active`` and an IP appears.
  4. Polls TCP/22 on that IP until SSH is reachable.
  5. SSH-runs the bootstrap script (Ollama install + ``ollama pull``).
     Model is chosen automatically based on GPU VRAM unless overridden.
  6. Polls ``http://<ip>:11434/api/tags`` until the model is loaded.
  7. Prints the SSH tunnel command + the three ``.env`` lines you need
     in CityPulse to point the LLM client at this box.

Safety:

  * Ollama binds to 127.0.0.1 on the instance — the Lambda firewall
    ALSO leaves 11434 closed by default. Connect via SSH tunnel:
    ``ssh -L 11434:localhost:11434 ubuntu@<ip>``. Pass ``--expose``
    to bind 0.0.0.0 instead (NOT recommended; Ollama has no auth).
  * Pass ``--max-cents-per-hour N`` to refuse instances above a price
    ceiling. Default is 500 ($5/hr) which permits up to 1xH100 PCIe.
  * The script stops after one successful launch. Re-run to grab
    another. It does NOT auto-terminate — terminate from the Lambda
    dashboard or via ``--terminate <id>``.

Auth: reads ``LAMBDA_CLOUD_API_KEY`` from env or ``.env``.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from base64 import b64encode
from pathlib import Path
from typing import Any, Optional

LOG = logging.getLogger("grabber")

CLOUD_BASE = "https://cloud.lambda.ai/api/v1"

# Cheapest single-GPU types first. We deliberately exclude multi-GPU and
# CPU instances — for transcript→JSON extraction, a single A10 ($1.29/hr)
# is overkill; anything bigger is just burning credits faster. The 8x
# clusters belong to a different workload (training).
DEFAULT_PRIORITY = [
    "gpu_1x_a10",          # 24GB  — fits 7B/8B comfortably (qwen2.5:7b, llama3.1:8b)
    "gpu_1x_a6000",        # 48GB  — fits 70B at q4 with room to spare
    "gpu_1x_a100_sxm4",    # 40GB  — fits 70B at q4 (~tight) or 32B comfortably
    "gpu_1x_gh200",        # 96GB  — fits 70B at q5/q6
    "gpu_1x_h100_pcie",    # 80GB  — fits 70B at q5/q6, fastest single-GPU option
    "gpu_1x_h100_sxm5",    # 80GB  — same VRAM, faster interconnect (we don't need it)
]

# VRAM (GB) → default Ollama model. Picked for transcript→JSON extraction:
# the larger models help with weird radio jargon and intersection parsing,
# but anything ≥7B handles the closed-enum severity_category fine.
def default_model_for_vram(vram_gb: int) -> str:
    if vram_gb >= 70:
        return "llama3.3:70b-instruct-q4_K_M"  # ~40GB
    if vram_gb >= 40:
        return "llama3.3:70b-instruct-q4_K_M"  # tight on A100-40 but works
    if vram_gb >= 22:
        return "qwen2.5:7b-instruct-q5_K_M"   # ~5.5GB, leaves headroom
    return "llama3.2:3b-instruct-q5_K_M"


# ── HTTP helpers (stdlib only — no extra deps for an ops script) ────

def _auth_header(api_key: str) -> str:
    # Lambda Cloud uses HTTP Basic with the key as username, blank password.
    return "Basic " + b64encode(f"{api_key}:".encode()).decode()


def _request(
    api_key: str,
    method: str,
    path: str,
    *,
    body: Optional[dict] = None,
    timeout: float = 30.0,
) -> dict:
    url = f"{CLOUD_BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", _auth_header(api_key))
    # Lambda's edge runs Cloudflare with a WAF rule that 403s requests
    # whose User-Agent looks like a vanilla scripting library
    # (CF error code 1010). Override with a curl-like UA — that's
    # what their official docs assume. We're authenticated, this is
    # not evasion of any policy, just bypassing UA-sniffing junk.
    req.add_header("User-Agent", "citypulse-gpu-grabber/1.0 (curl-compatible)")
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode(errors="replace")
        raise SystemExit(
            f"Lambda Cloud API {method} {path} failed: HTTP {e.code} — {body_text}"
        ) from e


# ── Capacity polling ────────────────────────────────────────────────

def list_instance_types(api_key: str) -> dict[str, dict]:
    """Returns the raw ``data`` block keyed by instance-type name."""
    return _request(api_key, "GET", "/instance-types").get("data", {})


def find_first_available(
    types_data: dict[str, dict],
    priority: list[str],
    max_cents_per_hour: int,
) -> Optional[tuple[str, str, dict]]:
    """Returns (instance_type_name, region_name, type_meta) for the
    first priority entry that has capacity within budget, or None."""
    for name in priority:
        v = types_data.get(name)
        if not v:
            continue
        it = v["instance_type"]
        if it["price_cents_per_hour"] > max_cents_per_hour:
            continue
        regions = v.get("regions_with_capacity_available", [])
        if regions:
            # Pick the first region; Lambda doesn't expose a per-region
            # latency hint and capacity is gone-in-seconds either way.
            return name, regions[0]["name"], v
    return None


# ── Launch + readiness ──────────────────────────────────────────────

def launch_instance(
    api_key: str,
    *,
    instance_type: str,
    region: str,
    ssh_key_name: str,
    instance_name: str,
) -> str:
    """Returns the instance id."""
    body = {
        "region_name": region,
        "instance_type_name": instance_type,
        "ssh_key_names": [ssh_key_name],
        "name": instance_name,
        "quantity": 1,
    }
    LOG.info(
        "Launching %s in %s (key=%s, name=%s)…",
        instance_type, region, ssh_key_name, instance_name,
    )
    resp = _request(api_key, "POST", "/instance-operations/launch", body=body)
    ids = resp.get("data", {}).get("instance_ids") or []
    if not ids:
        raise SystemExit(f"Launch returned no instance_ids: {resp}")
    return ids[0]


def wait_for_active(
    api_key: str,
    instance_id: str,
    *,
    timeout_s: float = 600.0,
    poll_s: float = 8.0,
) -> dict:
    """Block until the instance is ``active`` with an IP, return its info."""
    deadline = time.time() + timeout_s
    last_status = None
    while time.time() < deadline:
        info = _request(api_key, "GET", f"/instances/{instance_id}").get("data", {})
        status = info.get("status")
        ip = info.get("ip")
        if status != last_status:
            LOG.info("Instance %s status: %s (ip=%s)", instance_id, status, ip)
            last_status = status
        if status == "active" and ip:
            return info
        if status in ("terminated", "failed"):
            raise SystemExit(f"Instance {instance_id} entered terminal state {status}: {info}")
        time.sleep(poll_s)
    raise SystemExit(f"Instance {instance_id} did not become active within {timeout_s}s")


def wait_for_ssh(ip: str, *, timeout_s: float = 300.0, poll_s: float = 5.0) -> None:
    """Block until TCP/22 on the box accepts a connection."""
    deadline = time.time() + timeout_s
    LOG.info("Waiting for SSH on %s:22…", ip)
    while time.time() < deadline:
        try:
            with socket.create_connection((ip, 22), timeout=4):
                LOG.info("SSH port open on %s", ip)
                return
        except OSError:
            time.sleep(poll_s)
    raise SystemExit(f"SSH never came up on {ip}")


# ── Bootstrap (runs ON the GPU instance over SSH) ───────────────────

def bootstrap_script(model_name: str, expose: bool) -> str:
    """Generate the shell script we'll pipe into ``ssh ubuntu@<ip> bash -s``.

    Notes on choices:
      * We use Ollama (not vLLM) because it's a one-line install, has
        OpenAI-compatible chat completions on port 11434/v1, and handles
        model download/quantization for us. vLLM is faster per token
        but the setup pain isn't worth it for an extraction workload
        that's I/O-bound on the audio side anyway.
      * ``OLLAMA_HOST`` controls bind. Default 127.0.0.1 means you MUST
        SSH-tunnel; --expose flips to 0.0.0.0 (only do this if you know
        the Lambda firewall in front of you, since Ollama has no auth).
      * ``ollama pull`` is run synchronously so the script doesn't
        return until the model is on disk and ready to serve.
    """
    bind = "0.0.0.0:11434" if expose else "127.0.0.1:11434"
    return f"""#!/usr/bin/env bash
set -euo pipefail

echo "==> [bootstrap] installing Ollama"
if ! command -v ollama >/dev/null 2>&1; then
  curl -fsSL https://ollama.com/install.sh | sh
fi

echo "==> [bootstrap] configuring Ollama to bind {bind}"
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null <<EOF
[Service]
Environment="OLLAMA_HOST={bind}"
Environment="OLLAMA_KEEP_ALIVE=24h"
EOF
sudo systemctl daemon-reload
sudo systemctl restart ollama

echo "==> [bootstrap] waiting for Ollama to come up"
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "==> [bootstrap] pulling model: {model_name}"
ollama pull {model_name}

echo "==> [bootstrap] verifying chat completions endpoint"
curl -sf -X POST http://127.0.0.1:11434/v1/chat/completions \\
  -H 'Content-Type: application/json' \\
  -d '{{"model":"{model_name}","messages":[{{"role":"user","content":"Say OK"}}],"max_tokens":4}}' \\
  | head -c 400
echo
echo "==> [bootstrap] done"
"""


def run_bootstrap(ip: str, ssh_user: str, ssh_key: Path, model: str, expose: bool) -> None:
    script = bootstrap_script(model, expose)
    LOG.info("Running bootstrap on %s@%s (model=%s, expose=%s)…", ssh_user, ip, model, expose)
    cmd = [
        "ssh",
        "-i", str(ssh_key),
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        f"{ssh_user}@{ip}",
        "bash", "-s",
    ]
    p = subprocess.run(cmd, input=script.encode(), check=False)
    if p.returncode != 0:
        raise SystemExit(f"Bootstrap SSH exited with {p.returncode}")


# ── Main poll loop ──────────────────────────────────────────────────

def load_env_key() -> str:
    """Read LAMBDA_CLOUD_API_KEY from env, falling back to .env in CWD."""
    key = os.environ.get("LAMBDA_CLOUD_API_KEY", "").strip()
    if key:
        return key
    env_path = Path(".env")
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("LAMBDA_CLOUD_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise SystemExit(
        "LAMBDA_CLOUD_API_KEY not found. Set it in env or .env. "
        "Generate one at https://cloud.lambda.ai/api-keys"
    )


def notify_macos(title: str, message: str) -> None:
    """Best-effort desktop notification on macOS. Silently no-ops elsewhere."""
    if sys.platform != "darwin":
        return
    try:
        subprocess.run(
            ["osascript", "-e", f'display notification "{message}" with title "{title}"'],
            check=False, capture_output=True,
        )
    except Exception:
        pass


def main(argv: Optional[list[str]] = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--interval", type=int, default=60,
                   help="Seconds between capacity checks (default: 60)")
    p.add_argument("--priority", type=str, default=",".join(DEFAULT_PRIORITY),
                   help="Comma-separated instance types in preference order")
    p.add_argument("--max-cents-per-hour", type=int, default=500,
                   help="Refuse instance types above this price (default: 500 = $5/hr)")
    p.add_argument("--ssh-key-name", type=str, default="lambdursor-key",
                   help="Name of an SSH key already registered with Lambda (`lambdursor-key` matches your local id_ed25519)")
    p.add_argument("--ssh-user", type=str, default="ubuntu",
                   help="SSH login user on the instance (default: ubuntu)")
    p.add_argument("--ssh-key-path", type=Path, default=Path.home() / ".ssh/id_ed25519",
                   help="Local private key to SSH with (must match --ssh-key-name)")
    p.add_argument("--instance-name", type=str, default="citypulse-ollama",
                   help="Name to tag the launched instance with")
    p.add_argument("--model", type=str, default="",
                   help="Ollama model to pull (default: chosen by VRAM)")
    p.add_argument("--expose", action="store_true",
                   help="Bind Ollama to 0.0.0.0 (default: 127.0.0.1, requires SSH tunnel). NOT recommended.")
    p.add_argument("--dry-run", action="store_true",
                   help="Just print what would happen, don't launch")
    p.add_argument("--terminate", type=str, default="",
                   help="Terminate the given instance id and exit")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    api_key = load_env_key()
    priority = [t.strip() for t in args.priority.split(",") if t.strip()]

    if args.terminate:
        LOG.info("Terminating instance %s…", args.terminate)
        _request(api_key, "POST", "/instance-operations/terminate",
                 body={"instance_ids": [args.terminate]})
        LOG.info("Terminated.")
        return 0

    LOG.info("Polling Lambda for GPU capacity (interval=%ds, max=%d¢/hr)",
             args.interval, args.max_cents_per_hour)
    LOG.info("Priority: %s", ", ".join(priority))

    attempt = 0
    while True:
        attempt += 1
        try:
            data = list_instance_types(api_key)
        except SystemExit:
            raise
        except Exception as e:
            LOG.warning("Capacity poll #%d failed: %s — retrying", attempt, e)
            time.sleep(args.interval)
            continue

        hit = find_first_available(data, priority, args.max_cents_per_hour)
        if hit:
            inst_type, region, meta = hit
            it = meta["instance_type"]
            vram_gb = it.get("specs", {}).get("memory_gib", 0)
            # Lambda's `memory_gib` is system RAM, not VRAM. Parse VRAM
            # from the GPU description string (e.g. "A10 (24 GB PCIe)").
            gpu_desc = it.get("gpu_description", "")
            vram_match = 0
            for token in gpu_desc.replace("(", " ").replace(")", " ").split():
                if token.isdigit():
                    vram_match = int(token)
                    break
            model = args.model or default_model_for_vram(vram_match or vram_gb)
            price = it["price_cents_per_hour"] / 100
            LOG.info(
                "★ AVAILABLE: %s in %s — %s — $%.2f/hr — picking model: %s",
                inst_type, region, gpu_desc, price, model,
            )
            if args.dry_run:
                LOG.info("--dry-run set, would launch but not actually launching.")
                return 0

            try:
                inst_id = launch_instance(
                    api_key,
                    instance_type=inst_type,
                    region=region,
                    ssh_key_name=args.ssh_key_name,
                    instance_name=args.instance_name,
                )
            except SystemExit as e:
                # Race condition: capacity vanished between poll and launch.
                # That's a normal Lambda failure mode — just go back to polling.
                LOG.warning("Launch failed, returning to poll loop: %s", e)
                time.sleep(args.interval)
                continue

            info = wait_for_active(api_key, inst_id)
            ip = info["ip"]
            wait_for_ssh(ip)
            run_bootstrap(ip, args.ssh_user, args.ssh_key_path, model, args.expose)

            notify_macos("Lambda GPU ready", f"{inst_type} @ {ip} — Ollama running {model}")
            print()
            print("=" * 72)
            print(f"  GPU READY: {inst_type} ({gpu_desc}) @ {ip}")
            print(f"  Model:     {model}")
            print(f"  Cost:      ${price:.2f}/hr — REMEMBER TO TERMINATE WHEN DONE")
            print("=" * 72)
            print()
            print("Open an SSH tunnel from this machine to expose Ollama on localhost:")
            print(f"  ssh -N -L 11434:localhost:11434 -i {args.ssh_key_path} {args.ssh_user}@{ip} &")
            print()
            print("Then drop these lines into CityPulse/.env (replace any existing LLM_* lines):")
            print(f"  LLM_BASE_URL=http://localhost:11434/v1")
            print(f"  LLM_API_KEY=ollama")
            print(f"  LLM_MODEL={model}")
            print()
            print("Smoke test against the tunnel:")
            print('  curl -s http://localhost:11434/v1/chat/completions \\')
            print(f'    -H "Authorization: Bearer ollama" -H "Content-Type: application/json" \\')
            print(f'    -d \'{{"model":"{model}","messages":[{{"role":"user","content":"hi"}}],"max_tokens":4}}\'')
            print()
            print(f"Terminate when done:  python3 scripts/lambda_grab_gpu.py --terminate {inst_id}")
            print()
            return 0

        LOG.info("[%d] No capacity. Sleeping %ds…", attempt, args.interval)
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
