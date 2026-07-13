#!/usr/bin/env bash
# scripts/install_lambda_transcriber.sh
#
# Run on the Lambda A10 — installs the transcriber half of the
# split-pipeline backfill. Hetzner runs scripts/install_hetzner_downloader.sh
# and ships MP3s into /var/spool/citypulse-incoming/; this daemon picks
# them up, runs Whisper on the GPU, and POSTs to api.phlpulse.com/api/ingest.
#
# Companion to (and replacement for) the old monolithic backfill that
# install_lambda_backfill.sh set up. We DISABLE that service here so
# it doesn't keep retrying Broadcastify (which has rate-limited the
# Lambda IP into uselessness).
#
# Idempotent. Re-run after rsyncing a new revision.
#
# Uninstall:
#   systemctl disable --now citypulse-archive-transcriber
#   rm /etc/systemd/system/citypulse-archive-transcriber.service
#   rm /etc/citypulse-archive-transcriber.env
#   rm -rf /var/spool/citypulse-incoming /var/spool/citypulse-failed
#   systemctl daemon-reload

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/citypulse-backfill}"
ENV_FILE="${ENV_FILE:-/etc/citypulse-archive-transcriber.env}"
SERVICE_FILE="/etc/systemd/system/citypulse-archive-transcriber.service"
HEARTBEAT="${HEARTBEAT:-/var/log/citypulse-transcriber.heartbeat}"
LOG_FILE="${LOG_FILE:-/var/log/citypulse-transcriber.log}"
INCOMING_DIR="${INCOMING_DIR:-/var/spool/citypulse-incoming}"
FAILED_DIR="${FAILED_DIR:-/var/spool/citypulse-failed}"
PYTHON="${PYTHON:-/usr/bin/python3}"

echo "==> 1. apt deps"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    ffmpeg python3-venv python3-pip git rsync curl >/dev/null

echo "==> 2. Python venv at $REPO_DIR/.venv (reusing the backfill venv if present)"
sudo mkdir -p "$REPO_DIR"
sudo chown -R "$(id -un):$(id -gn)" "$REPO_DIR"
if [[ ! -d "$REPO_DIR/.venv" ]]; then
  "$PYTHON" -m venv "$REPO_DIR/.venv"
fi
# shellcheck disable=SC1091
source "$REPO_DIR/.venv/bin/activate"
pip install -q --upgrade pip
# Same deps as install_lambda_backfill.sh — the transcriber imports
# faster_whisper / preprocess / etc.
pip install -q \
    "faster-whisper>=1.0.3" \
    "ctranslate2>=4.4.0" \
    requests pyyaml numpy scipy \
    webrtcvad \
    "nvidia-cudnn-cu12==9.*"

CUDNN_LIB_DIR=$(python3 -c "import nvidia.cudnn, os; print(os.path.dirname(nvidia.cudnn.__file__) + '/lib')" 2>/dev/null || true)
if [[ -d "$CUDNN_LIB_DIR" ]]; then
  sudo ln -sfn "$CUDNN_LIB_DIR" /opt/nvidia-cudnn-lib
fi

echo "==> 3. Spool dirs ($INCOMING_DIR, $FAILED_DIR)"
sudo mkdir -p "$INCOMING_DIR" "$FAILED_DIR" "$FAILED_DIR/orphans"
# Hetzner ships in as ubuntu (whatever LAMBDA_USER is). Make ubuntu own
# the dir so scp doesn't fight permissions on every job.
sudo chown -R "$(id -un):$(id -gn)" "$INCOMING_DIR" "$FAILED_DIR"

echo "==> 4. Heartbeat / log files"
sudo touch "$HEARTBEAT" "$LOG_FILE"
sudo chown "$(id -un)" "$HEARTBEAT" "$LOG_FILE"

echo "==> 5. Env file at $ENV_FILE"
# Reuse the live-ingest secret drop-in when present (same Bearer the
# pulse-live@ units use). Falls back to an existing transcriber env.
INGEST_SECRET=""
if [[ -f /etc/systemd/system/pulse-live@.service.d/ingest-secret.conf ]]; then
  INGEST_SECRET="$(sudo sed -n 's/^.*PULSE_INGEST_SECRET=//p' /etc/systemd/system/pulse-live@.service.d/ingest-secret.conf | tr -d '\n')"
fi
if [[ -z "$INGEST_SECRET" && -f "$ENV_FILE" ]]; then
  INGEST_SECRET="$(awk -F= '/^PULSE_INGEST_SECRET=/{print $2; exit}' "$ENV_FILE" || true)"
fi
if [[ ! -f "$ENV_FILE" ]]; then
  sudo tee "$ENV_FILE" >/dev/null <<EOF
# /etc/citypulse-archive-transcriber.env — consumed by
# citypulse-archive-transcriber.service.

# Where to POST extracted incidents. Same endpoint the live ingest path
# uses; the server tells transcripts apart from live audio by source
# (raw_audio_clip ID conventions).
PP_BRIDGE_URL=https://api.phlpulse.com/api/ingest

# Spool dirs Hetzner scp's into / failures move to.
INCOMING_DIR=${INCOMING_DIR}
FAILED_DIR=${FAILED_DIR}

# Whisper model (same as old monolith). large-v3-turbo + qwen2.5:7b
# both fit comfortably in 24GB on A10.
WHISPER_MODEL_SIZE=large-v3-turbo

TRANSCRIBER_HEARTBEAT=${HEARTBEAT}
TRANSCRIBER_POLL_INTERVAL_S=5
# Sweep orphan .mp3 (no sidecar) older than 1h to /failed/orphans.
TRANSCRIBER_ORPHAN_AGE_S=3600
# Sweep cycle.
TRANSCRIBER_JANITOR_INTERVAL_S=600

PULSE_INGEST_SECRET=${INGEST_SECRET}

PYTHONUNBUFFERED=1
EOF
  sudo chmod 640 "$ENV_FILE"
else
  echo "    Keeping existing $ENV_FILE"
  if [[ -n "$INGEST_SECRET" ]]; then
    if grep -q '^PULSE_INGEST_SECRET=' "$ENV_FILE" 2>/dev/null; then
      sudo sed -i "s|^PULSE_INGEST_SECRET=.*|PULSE_INGEST_SECRET=${INGEST_SECRET}|" "$ENV_FILE"
    else
      echo "PULSE_INGEST_SECRET=${INGEST_SECRET}" | sudo tee -a "$ENV_FILE" >/dev/null
    fi
    echo "    synced PULSE_INGEST_SECRET from pulse-live drop-in"
  fi
fi

echo "==> 6. systemd unit at $SERVICE_FILE"
sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=CityPulse archive transcriber (Lambda side of split-pipeline)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=${REPO_DIR}
EnvironmentFile=${ENV_FILE}
# faster-whisper picks up libcudnn from the venv via this LD path
# (mirrors install_lambda_backfill.sh).
Environment=LD_LIBRARY_PATH=/opt/nvidia-cudnn-lib:${REPO_DIR}/.venv/lib/python3.10/site-packages/nvidia/cudnn/lib
ExecStart=${REPO_DIR}/.venv/bin/python -u ${REPO_DIR}/scripts/lambda_archive_transcriber.py
Restart=on-failure
RestartSec=30
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}
StartLimitIntervalSec=600
StartLimitBurst=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload

echo "==> 7. Disable old monolithic backfill (Broadcastify rate-limited it)"
# The old service still exists from install_lambda_backfill.sh — it's
# stuck in 60-1800s 429 backoffs producing nothing. Stop it so it
# doesn't fight the new transcriber for VRAM and so we can tell the
# split pipeline apart from leftover monolith activity in the logs.
if systemctl list-unit-files | grep -q '^citypulse-backfill.service'; then
  sudo systemctl disable --now citypulse-backfill.service || true
  echo "    (citypulse-backfill stopped + disabled)"
else
  echo "    (no old citypulse-backfill present, skipping)"
fi

echo
echo "==> Install complete."
echo "    NEXT: sudo systemctl enable --now citypulse-archive-transcriber"
echo "    Watch:    journalctl -fu citypulse-archive-transcriber  (or)  tail -f ${LOG_FILE}"
echo "    Heartbeat: cat ${HEARTBEAT}"
echo "    Queue:     ls ${INCOMING_DIR} | wc -l"
