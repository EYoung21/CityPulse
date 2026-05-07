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
# Lambda layout:
#   * citypulse-ingest-api.service — FastAPI on 127.0.0.1 (see
#     CITYPULSE_LOCAL_INGEST_PORT) with PHILLY_PULSE_LLM_AUTO=1, Firestore,
#     and LLM_* pointing at local Ollama (:11434). Backfill POSTs here so
#     Hetzner is not in the critical path (avoids OOM/502/timeouts).
#   * citypulse-backfill.service — Whisper + POSTs to the local ingest URL.
#
# To uninstall:
#   systemctl disable --now citypulse-backfill citypulse-ingest-api
#   rm /etc/systemd/system/citypulse-backfill.service \
#      /etc/systemd/system/citypulse-ingest-api.service \
#      /etc/citypulse-backfill.env
#   rm -rf /opt/citypulse-backfill
#   systemctl daemon-reload

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/citypulse-backfill}"
ENV_FILE="${ENV_FILE:-/etc/citypulse-backfill.env}"
HEARTBEAT="${HEARTBEAT:-/var/log/lambda_backfill.heartbeat}"
SERVICE_FILE="/etc/systemd/system/citypulse-backfill.service"
INGEST_API_SERVICE_FILE="/etc/systemd/system/citypulse-ingest-api.service"
PYTHON="${PYTHON:-/usr/bin/python3}"

echo "==> 1. apt deps (ffmpeg, python3-venv, build deps for faster-whisper)"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    ffmpeg python3-venv python3-pip git rsync curl >/dev/null

echo "==> 2. Python venv at $REPO_DIR/.venv"
sudo mkdir -p "$REPO_DIR"
sudo chown -R "$(id -un):$(id -gn)" "$REPO_DIR"
mkdir -p "$REPO_DIR/.secrets"
chmod 700 "$REPO_DIR/.secrets"
if [[ ! -d "$REPO_DIR/.venv" ]]; then
    "$PYTHON" -m venv "$REPO_DIR/.venv"
fi
# shellcheck disable=SC1091
source "$REPO_DIR/.venv/bin/activate"
pip install -q --upgrade pip
# faster-whisper bundles ctranslate2 with CUDA support; the rest are
# pinned loosely (any recent version works). nvidia-cudnn-cu12 is what
# faster-whisper needs at runtime; on Lambda's stock image it's missing.
# webrtcvad is required by philly_pulse.preprocess._vad_segment; without
# it, every chunk in backfill_archives.py raises
# "No module named 'webrtcvad'" and produces 0 transcripts (the box
# burns $1.29/hr doing nothing, and Firestore stops getting incidents).
pip install -q \
    "faster-whisper>=1.0.3" \
    "ctranslate2>=4.4.0" \
    requests pyyaml numpy scipy \
    webrtcvad \
    "nvidia-cudnn-cu12==9.*"
# FastAPI stack for the loopback ingest service (same as Hetzner prod).
if [[ -f "$REPO_DIR/requirements-philly-pulse.txt" ]]; then
    pip install -q -r "$REPO_DIR/requirements-philly-pulse.txt"
else
    echo "    WARNING: $REPO_DIR/requirements-philly-pulse.txt missing; local ingest API may fail to import."
fi

VENV_PY_MINOR=$("$REPO_DIR/.venv/bin/python" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
VENV_CUDNN_LIB="$REPO_DIR/.venv/lib/python${VENV_PY_MINOR}/site-packages/nvidia/cudnn/lib"

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
# /etc/citypulse-backfill.env — shared by citypulse-ingest-api + citypulse-backfill
# Edit BROADCASTIFY_USERNAME/PASSWORD before starting.
BROADCASTIFY_USERNAME=
BROADCASTIFY_PASSWORD=
# Loopback ingest (Whisper posts here; avoids Hetzner OOM/502 on backfill).
CITYPULSE_LOCAL_INGEST_PORT=18080
PP_BRIDGE_URL=http://127.0.0.1:18080/api/ingest
PHILLY_PULSE_LLM_AUTO=1
PHILLY_PULSE_STORE=firestore
GOOGLE_APPLICATION_CREDENTIALS=$REPO_DIR/.secrets/firebase-service-account.json
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_API_KEY=ollama
LLM_MODEL=qwen2.5:7b-instruct-q5_K_M
LLM_PROVIDER_NAME=ollama-local
WHISPER_MODEL_SIZE=large-v3-turbo
BACKFILL_DAY_LIMIT=150
BACKFILL_HEARTBEAT=$HEARTBEAT
BACKFILL_CITY_GLOB="philly chattanooga nyc sf"
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
    echo "    Keeping existing $ENV_FILE (merge step below adds any missing keys)."
fi

echo "==> 4b. Ensure loopback ingest + Firestore + LLM keys exist"
sudo touch "$ENV_FILE"
# Migrate off prod HTTPS bridge (Hetzner OOM + timeouts under backfill).
if sudo grep -qE '^PP_BRIDGE_URL=https://(api\.)?phlpulse\.com' "$ENV_FILE" 2>/dev/null; then
    echo "    Migrating PP_BRIDGE_URL -> http://127.0.0.1:18080/api/ingest"
    sudo sed -i 's|^PP_BRIDGE_URL=.*|PP_BRIDGE_URL=http://127.0.0.1:18080/api/ingest|' "$ENV_FILE"
fi

append_if_missing() {
    local key="$1"
    local val="$2"
    if sudo grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
        return 0
    fi
    echo "${key}=${val}" | sudo tee -a "$ENV_FILE" >/dev/null
}

append_if_missing CITYPULSE_LOCAL_INGEST_PORT 18080
append_if_missing PP_BRIDGE_URL http://127.0.0.1:18080/api/ingest
append_if_missing PHILLY_PULSE_LLM_AUTO 1
append_if_missing PHILLY_PULSE_STORE firestore
append_if_missing GOOGLE_APPLICATION_CREDENTIALS "$REPO_DIR/.secrets/firebase-service-account.json"
append_if_missing LLM_BASE_URL http://127.0.0.1:11434/v1
append_if_missing LLM_API_KEY ollama
append_if_missing LLM_MODEL qwen2.5:7b-instruct-q5_K_M
append_if_missing LLM_PROVIDER_NAME ollama-local

echo "==> 5. systemd: local ingest API ($INGEST_API_SERVICE_FILE)"
sudo tee "$INGEST_API_SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=CityPulse local ingest API (Lambda loopback)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$REPO_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$REPO_DIR/scripts/run_lambda_ingest_api.sh
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/citypulse-ingest-api.log
StandardError=append:/var/log/citypulse-ingest-api.log

[Install]
WantedBy=multi-user.target
EOF

echo "==> 6. systemd: backfill runner ($SERVICE_FILE)"
sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=CityPulse backfill runner (Lambda)
After=network-online.target citypulse-ingest-api.service
Wants=network-online.target citypulse-ingest-api.service
StartLimitIntervalSec=600
StartLimitBurst=10

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$REPO_DIR
EnvironmentFile=$ENV_FILE
Environment=LD_LIBRARY_PATH=/opt/nvidia-cudnn-lib:$VENV_CUDNN_LIB
ExecStart=$REPO_DIR/.venv/bin/python $REPO_DIR/scripts/lambda_backfill_runner.py
Restart=on-failure
RestartSec=30
StandardOutput=append:/var/log/citypulse-backfill.log
StandardError=append:/var/log/citypulse-backfill.log

[Install]
WantedBy=multi-user.target
EOF

sudo chmod +x "$REPO_DIR/scripts/run_lambda_ingest_api.sh"
sudo touch /var/log/citypulse-backfill.log /var/log/citypulse-ingest-api.log
sudo chown "$(id -un)" /var/log/citypulse-backfill.log /var/log/citypulse-ingest-api.log
sudo systemctl daemon-reload

echo
echo "==> Install complete."
echo
if [[ ! -f "$REPO_DIR/.secrets/firebase-service-account.json" ]]; then
    echo "    REQUIRED: copy Firebase service account JSON to:"
    echo "      $REPO_DIR/.secrets/firebase-service-account.json"
    echo "    (deploy_lambda_backfill.sh does this automatically when the file exists locally.)"
fi
if grep -q '^BROADCASTIFY_USERNAME=$' "$ENV_FILE" 2>/dev/null; then
    echo "    NEXT: fill in $ENV_FILE then run:"
    echo "      sudo systemctl enable --now citypulse-ingest-api citypulse-backfill"
else
    echo "    NEXT: sudo systemctl enable --now citypulse-ingest-api citypulse-backfill"
fi
echo "    Logs: tail -f /var/log/citypulse-ingest-api.log /var/log/citypulse-backfill.log"
echo "    Heartbeat: cat $HEARTBEAT"
