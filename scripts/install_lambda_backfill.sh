#!/usr/bin/env bash
# scripts/install_lambda_backfill.sh
#
# Run on the Lambda A10 (ubuntu@<lambda_ip>). Idempotent. Sets up:
#   1. ffmpeg + faster-whisper + python deps
#   2. /opt/citypulse-backfill checkout (rsynced from your laptop in the
#      one-shot launcher; see scripts/deploy_lambda_backfill.sh)
#   3. /etc/citypulse-backfill.env with Broadcastify creds + bridge URL
#   4. systemd unit citypulse-backfill.service — auto-restart on crash,
#      writes heartbeat to /var/log/lambda_backfill.heartbeat for the
#      laptop-side auto-terminator to monitor.
#
# Pre-req on Lambda: scripts/prod_setup_lambda_ollama.sh equivalent is
# NOT needed here — the backfill on Lambda POSTs transcripts to prod's
# /api/ingest, and prod is the one that calls Ollama through the
# already-existing tunnel.
#
# To uninstall:
#   systemctl disable --now citypulse-backfill
#   rm /etc/systemd/system/citypulse-backfill.service /etc/citypulse-backfill.env
#   rm -rf /opt/citypulse-backfill
#   systemctl daemon-reload

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/citypulse-backfill}"
ENV_FILE="${ENV_FILE:-/etc/citypulse-backfill.env}"
HEARTBEAT="${HEARTBEAT:-/var/log/lambda_backfill.heartbeat}"
SERVICE_FILE="/etc/systemd/system/citypulse-backfill.service"
PYTHON="${PYTHON:-/usr/bin/python3}"

echo "==> 1. apt deps (ffmpeg, python3-venv, build deps for faster-whisper)"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    ffmpeg python3-venv python3-pip git rsync curl >/dev/null

echo "==> 2. Python venv at $REPO_DIR/.venv"
sudo mkdir -p "$REPO_DIR"
sudo chown -R "$(id -un):$(id -gn)" "$REPO_DIR"
if [[ ! -d "$REPO_DIR/.venv" ]]; then
    "$PYTHON" -m venv "$REPO_DIR/.venv"
fi
# shellcheck disable=SC1091
source "$REPO_DIR/.venv/bin/activate"
pip install -q --upgrade pip
# faster-whisper bundles ctranslate2 with CUDA support; the rest are
# pinned loosely (any recent version works). nvidia-cudnn-cu12 is what
# faster-whisper needs at runtime; on Lambda's stock image it's missing.
pip install -q \
    "faster-whisper>=1.0.3" \
    "ctranslate2>=4.4.0" \
    requests pyyaml numpy scipy \
    "nvidia-cudnn-cu12==9.*"

# faster-whisper looks for libcudnn at runtime; symlink it onto the
# loader path so we don't have to set LD_LIBRARY_PATH everywhere.
CUDNN_LIB_DIR=$(python3 -c "import nvidia.cudnn, os; print(os.path.dirname(nvidia.cudnn.__file__) + '/lib')" 2>/dev/null || true)
if [[ -d "$CUDNN_LIB_DIR" ]]; then
    sudo ln -sfn "$CUDNN_LIB_DIR" /opt/nvidia-cudnn-lib
fi

echo "==> 3. Heartbeat log file"
sudo touch "$HEARTBEAT"
sudo chown "$(id -un)" "$HEARTBEAT"

echo "==> 4. Env file at $ENV_FILE"
if [[ ! -f "$ENV_FILE" ]]; then
    sudo tee "$ENV_FILE" >/dev/null <<EOF
# /etc/citypulse-backfill.env -- consumed by citypulse-backfill.service
# Edit BROADCASTIFY_USERNAME/PASSWORD before starting the service.
BROADCASTIFY_USERNAME=
BROADCASTIFY_PASSWORD=
PP_BRIDGE_URL=https://api.phlpulse.com/api/ingest
WHISPER_MODEL_SIZE=large-v3-turbo
BACKFILL_DAY_LIMIT=150
BACKFILL_HEARTBEAT=$HEARTBEAT
# Active cities. Anything not in this allowlist is skipped by the
# runner even if cities/<slug>/config.yaml exists. Edit + restart
# (sudo systemctl restart citypulse-backfill) to add/remove.
BACKFILL_CITY_GLOB="philly chattanooga nyc sf"
# Premium account: aggressive defaults are fine. Drop these back if you
# ever switch back to free tier.
BACKFILL_DELAY_BASE=8
BACKFILL_DELAY_JITTER=3
BACKFILL_BACKOFF_BASE=60
COOLDOWN_AFTER_QUOTA=7200
CYCLE_SLEEP_S=600
PYTHONUNBUFFERED=1
EOF
    sudo chmod 640 "$ENV_FILE"
    echo "    !! $ENV_FILE has empty creds. Fill in BROADCASTIFY_USERNAME/PASSWORD before starting."
else
    echo "    Keeping existing $ENV_FILE (edit by hand if creds need updating)."
fi

echo "==> 5. systemd unit at $SERVICE_FILE"
sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=CityPulse backfill runner (Lambda)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$REPO_DIR
EnvironmentFile=$ENV_FILE
# faster-whisper picks up libcudnn from the venv via this LD path.
Environment=LD_LIBRARY_PATH=/opt/nvidia-cudnn-lib:$REPO_DIR/.venv/lib/python3.10/site-packages/nvidia/cudnn/lib
ExecStart=$REPO_DIR/.venv/bin/python $REPO_DIR/scripts/lambda_backfill_runner.py
Restart=on-failure
RestartSec=30
# Don't fight Ollama for VRAM; if Whisper OOMs, restart and try again.
# Whisper large-v3-turbo (~3-5 GB) + qwen2.5:7b (~5.6 GB) should both
# fit comfortably in 24 GB. If it doesn't, swap WHISPER_MODEL_SIZE to
# "small" or "medium" in the env file.
StandardOutput=append:/var/log/citypulse-backfill.log
StandardError=append:/var/log/citypulse-backfill.log
StartLimitIntervalSec=600
StartLimitBurst=10

[Install]
WantedBy=multi-user.target
EOF
sudo touch /var/log/citypulse-backfill.log
sudo chown "$(id -un)" /var/log/citypulse-backfill.log
sudo systemctl daemon-reload

echo
echo "==> Install complete."
echo
if grep -q '^BROADCASTIFY_USERNAME=$' "$ENV_FILE" 2>/dev/null; then
    echo "    NEXT: fill in $ENV_FILE then run:"
    echo "      sudo systemctl enable --now citypulse-backfill"
else
    echo "    NEXT: sudo systemctl enable --now citypulse-backfill"
fi
echo "    Watch:    journalctl -fu citypulse-backfill   (or)   tail -f /var/log/citypulse-backfill.log"
echo "    Heartbeat: cat $HEARTBEAT"
