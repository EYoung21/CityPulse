#!/usr/bin/env bash
# scripts/install_lambda_live_transcribers.sh
#
# Run on the Lambda A10. Installs the templated systemd unit
# `pulse-live@<city>.service` and enables it for each city the caller
# names. Mirrors install_lambda_transcriber.sh's pattern (same venv at
# /opt/citypulse-backfill/.venv, same cuDNN paths) so live + archive
# share their Whisper dependency stack.
#
# Why this exists: the Hetzner 2 GB VPS was OOM-killing the API every
# time the 4 pulse-live@<city> services peaked. Lambda has GPU + plenty
# of RAM, the code already supports `device="cuda"`, and Broadcastify's
# 429 rate-limit is only on archive downloads — live streams (single
# persistent ffmpeg connection per feed) aren't affected by it.
#
# Idempotent. Re-run after rsyncing a new revision.
#
# Caller is expected to have rsynced (from Hetzner):
#   - multi_transcriber.py            → /opt/citypulse-backfill/
#   - philly_pulse/ (bridge.py et al) → /opt/citypulse-backfill/philly_pulse/
#   - cities/<slug>/config.yaml       → /opt/citypulse-backfill/cities/<slug>/
#   - config.yaml                      → /opt/citypulse-backfill/config.yaml
#
# Uninstall (per city):
#   sudo systemctl disable --now pulse-live@<city>.service
#   sudo rm /etc/systemd/system/pulse-live@.service
#   sudo systemctl daemon-reload

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/citypulse-backfill}"
SERVICE_FILE="/etc/systemd/system/pulse-live@.service"
LOG_DIR="${LOG_DIR:-/var/log}"
PYTHON="${PYTHON:-/usr/bin/python3}"
# Default: post to the production API. Override via env if testing
# against a staging host.
BRIDGE_URL="${BRIDGE_URL:-https://api.phlpulse.com/api/ingest}"
# Space-separated list of city slugs to enable. Matches the Hetzner
# ACTIVE_CITIES set in deploy-backend-hetzner.sh.
#
# philly + philly2 are two systemd services that share one Firestore slug
# ("philly"). Philly's 24 feeds wouldn't fit a single Whisper worker pool
# (queue grew to 2800+, freshness lagged 2h), so the suburb half lives in
# cities/philly2/config.yaml under the same slug. The transcriber treats
# them as separate units; philly_pulse/city_registry.py merges the feed
# lists so the API/admin see one combined inventory.
ACTIVE_CITIES="${ACTIVE_CITIES:-sf nyc philly philly2 chattanooga}"

echo "==> 0. Sanity: repo exists at $REPO_DIR"
test -f "$REPO_DIR/multi_transcriber.py" \
  || { echo "FATAL: $REPO_DIR/multi_transcriber.py missing — rsync it first"; exit 1; }
test -d "$REPO_DIR/philly_pulse" \
  || { echo "FATAL: $REPO_DIR/philly_pulse/ missing — rsync it first"; exit 1; }
test -d "$REPO_DIR/cities" \
  || { echo "FATAL: $REPO_DIR/cities/ missing — rsync it first"; exit 1; }
test -f "$REPO_DIR/config.yaml" \
  || { echo "FATAL: $REPO_DIR/config.yaml missing (Broadcastify creds source)"; exit 1; }

echo "==> 1. apt deps (ffmpeg for the live stream demux)"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    ffmpeg python3-venv python3-pip >/dev/null

echo "==> 2. Python venv at $REPO_DIR/.venv (shared with archive transcriber)"
if [[ ! -d "$REPO_DIR/.venv" ]]; then
  "$PYTHON" -m venv "$REPO_DIR/.venv"
fi
# shellcheck disable=SC1091
source "$REPO_DIR/.venv/bin/activate"
pip install -q --upgrade pip
# Same deps as the archive transcriber + extras multi_transcriber.py
# needs (the live path uses webrtcvad on raw PCM frames).
pip install -q \
    "faster-whisper>=1.0.3" \
    "ctranslate2>=4.4.0" \
    requests pyyaml numpy scipy \
    webrtcvad \
    "nvidia-cudnn-cu12==9.*"

# Mirror the archive installer's cuDNN symlink so LD_LIBRARY_PATH below
# resolves at runtime without venv-version coupling.
CUDNN_LIB_DIR=$(python3 -c "import nvidia.cudnn, os; print(os.path.dirname(nvidia.cudnn.__file__) + '/lib')" 2>/dev/null || true)
if [[ -d "$CUDNN_LIB_DIR" ]]; then
  sudo ln -sfn "$CUDNN_LIB_DIR" /opt/nvidia-cudnn-lib
fi

echo "==> 3. Patch $REPO_DIR/config.yaml — set philly_pulse.bridge_url"
# multi_transcriber.py reads philly_pulse.bridge_url from the root
# config; on Hetzner that's localhost. On Lambda the API isn't local,
# so we rewrite to the public DNS. PyYAML rewrites the file safely
# (preserves the rest of the structure).
"$REPO_DIR/.venv/bin/python" - "$REPO_DIR/config.yaml" "$BRIDGE_URL" <<'PYEOF'
import sys, yaml
path, bridge_url = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as f:
    cfg = yaml.safe_load(f) or {}
pp = cfg.setdefault("philly_pulse", {})
pp["enabled"] = True
pp["bridge_url"] = bridge_url
with open(path, "w", encoding="utf-8") as f:
    yaml.safe_dump(cfg, f, sort_keys=False)
print(f"  set philly_pulse.bridge_url = {bridge_url}")
PYEOF

echo "==> 4. Log/heartbeat dirs"
sudo touch "$LOG_DIR/pulse-live.log"
sudo chown "$(id -un)" "$LOG_DIR/pulse-live.log"

echo "==> 4b. Audio clip dirs (multi_transcriber writes WAVs here; the"
echo "    bridge base64-encodes them into the /api/ingest payload)"
# Without these, _save_wav() raises ENOENT, the inline try/except sets
# clip_id=None, the bridge has no clips to ship, and incidents arrive
# at the API with audio_clip=null → "Audio not available" in the UI.
mkdir -p "$REPO_DIR/audio_clips" "$REPO_DIR/audio_clips_raw"
chmod 755 "$REPO_DIR/audio_clips" "$REPO_DIR/audio_clips_raw"

echo "==> 5. systemd template unit at $SERVICE_FILE"
# Note vs Hetzner unit:
#   - User=<lambda_user>      (Hetzner ran as root)
#   - WorkingDirectory=$REPO_DIR (was /root/PhillyPulse)
#   - NO After=philly-pulse-api (API lives on Hetzner now)
#   - LD_LIBRARY_PATH for cuDNN so faster-whisper finds the GPU stack
#   - NO MemoryMax — Lambda has 60 GB+ RAM, no point capping
sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=Pulse Live Transcriber — %I  (Lambda GPU)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=${REPO_DIR}
Environment=LD_LIBRARY_PATH=/opt/nvidia-cudnn-lib:${REPO_DIR}/.venv/lib/python3.10/site-packages/nvidia/cudnn/lib
Environment=PYTHONUNBUFFERED=1
ExecStart=${REPO_DIR}/.venv/bin/python -u ${REPO_DIR}/multi_transcriber.py --config cities/%i/config.yaml
Restart=always
RestartSec=10
StandardOutput=append:${LOG_DIR}/pulse-live.log
StandardError=append:${LOG_DIR}/pulse-live.log
# Generous start-throttle since the GPU model load takes a few seconds
# on cold start; don't want a transient ffmpeg blip to disable the unit.
StartLimitIntervalSec=600
StartLimitBurst=15

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload

echo "==> 6. Enable + start pulse-live@<city> for: $ACTIVE_CITIES"
for city in $ACTIVE_CITIES; do
  if [[ ! -f "$REPO_DIR/cities/$city/config.yaml" ]]; then
    echo "    WARN: no cities/$city/config.yaml — skipping"
    continue
  fi
  echo "    enabling pulse-live@${city}"
  sudo systemctl enable "pulse-live@${city}.service" >/dev/null
  sudo systemctl restart "pulse-live@${city}.service"
done

echo
echo "==> Install complete."
echo "    Watch:   journalctl -fu pulse-live@philly  (or other city)"
echo "    Logs:    tail -f $LOG_DIR/pulse-live.log"
echo "    Status:  systemctl status pulse-live@philly --no-pager -l"
