#!/usr/bin/env bash
# scripts/install_hetzner_downloader.sh
#
# Run on Hetzner (root@87.99.157.115) — installs the split-pipeline
# downloader half. The transcriber half lives on Lambda; install with
# scripts/install_lambda_transcriber.sh from a separate workflow step.
#
# Pre-reqs (already true on prod, listed for the next dev who reads
# this):
#   * /root/PhillyPulse is the deployed checkout (this script reads
#     scripts/hetzner_archive_downloader.py from there).
#   * /root/.ssh/lambda_tunnel_key exists with chmod 600 and the matching
#     pubkey is in ubuntu@LAMBDA's authorized_keys (set up by
#     scripts/prod_setup_lambda_ollama.sh — we reuse the same key).
#
# Idempotent. Re-run after pulling a new revision to pick up python deps
# or systemd unit changes.
#
# Uninstall:
#   systemctl disable --now citypulse-downloader
#   rm /etc/systemd/system/citypulse-downloader.service /etc/citypulse-downloader.env
#   rm -rf /var/lib/citypulse-downloader
#   systemctl daemon-reload

set -euo pipefail

REPO_DIR="${REPO_DIR:-/root/PhillyPulse}"
ENV_FILE="${ENV_FILE:-/etc/citypulse-downloader.env}"
SERVICE_FILE="/etc/systemd/system/citypulse-downloader.service"
HEARTBEAT="${HEARTBEAT:-/var/log/citypulse-downloader.heartbeat}"
LOG_FILE="${LOG_FILE:-/var/log/citypulse-downloader.log}"
PROGRESS_DIR="${PROGRESS_DIR:-/var/lib/citypulse-downloader/progress}"
LAMBDA_USER="${LAMBDA_USER:-ubuntu}"
LAMBDA_HOST="${LAMBDA_HOST:-150.230.182.19}"
LAMBDA_INCOMING_DIR="${LAMBDA_INCOMING_DIR:-/var/spool/citypulse-incoming}"
LAMBDA_SSH_KEY="${LAMBDA_SSH_KEY:-/root/.ssh/lambda_tunnel_key}"

if [[ ! -d "$REPO_DIR" ]]; then
  echo "[FATAL] $REPO_DIR does not exist — deploy the repo there first" >&2
  exit 1
fi

if [[ ! -f "$LAMBDA_SSH_KEY" ]]; then
  echo "[FATAL] Lambda SSH key missing at $LAMBDA_SSH_KEY" >&2
  echo "        Re-run scripts/prod_setup_lambda_ollama.sh first" >&2
  exit 1
fi

echo "==> 1. apt deps"
DEBIAN_FRONTEND=noninteractive apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    python3-venv python3-pip openssh-client rsync curl >/dev/null

echo "==> 2. Python venv at $REPO_DIR/.venv-downloader (isolated from the API)"
# We do NOT reuse philly-pulse-api's venv. The downloader's deps are
# lightweight (requests, pyyaml) and we'd rather a stray pip upgrade not
# tip the API over. Memory cost: ~30MB vs sharing.
if [[ ! -d "$REPO_DIR/.venv-downloader" ]]; then
  python3 -m venv "$REPO_DIR/.venv-downloader"
fi
"$REPO_DIR/.venv-downloader/bin/pip" install -q --upgrade pip
"$REPO_DIR/.venv-downloader/bin/pip" install -q requests pyyaml

echo "==> 3. State + log paths"
mkdir -p "$PROGRESS_DIR"
touch "$HEARTBEAT" "$LOG_FILE"
chmod 644 "$HEARTBEAT" "$LOG_FILE"

echo "==> 4. Pre-trust Lambda host key"
mkdir -p /root/.ssh && chmod 700 /root/.ssh
ssh-keygen -R "$LAMBDA_HOST" >/dev/null 2>&1 || true
ssh-keyscan -H "$LAMBDA_HOST" >>/root/.ssh/known_hosts 2>/dev/null

echo "==> 5. Env file at $ENV_FILE"
# Source-of-truth for Broadcastify creds in this stack is
# /etc/citypulse-backfill.env on Lambda (laid down by the original
# install_lambda_backfill.sh). Hetzner doesn't have those creds locally,
# so we ssh over the lambda_tunnel_key — already installed in step 4 —
# and pull them. Falls back to local /etc/* env files for hosts where
# Lambda is unreachable (testing, future cutover).
BC_USER=""
BC_PASS=""
echo "    fetching Broadcastify creds from Lambda over $LAMBDA_SSH_KEY"
LAMBDA_ENV_OUT="$(ssh -i "$LAMBDA_SSH_KEY" \
    -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=10 \
    "${LAMBDA_USER}@${LAMBDA_HOST}" \
    'sudo grep -E "^BROADCASTIFY_(USERNAME|PASSWORD)=" /etc/citypulse-backfill.env 2>/dev/null' \
    2>/dev/null || true)"
if [[ -n "$LAMBDA_ENV_OUT" ]]; then
  BC_USER="$(printf '%s\n' "$LAMBDA_ENV_OUT" | awk -F= '/^BROADCASTIFY_USERNAME=/{print $2; exit}')"
  BC_PASS="$(printf '%s\n' "$LAMBDA_ENV_OUT" | awk -F= '/^BROADCASTIFY_PASSWORD=/{print $2; exit}')"
fi
if [[ -z "$BC_USER" ]]; then
  for src in /etc/citypulse-backfill.env /etc/philly-pulse.env; do
    if [[ -f "$src" ]]; then
      BC_USER="$(awk -F= '/^BROADCASTIFY_USERNAME=/{print $2; exit}' "$src" || true)"
      BC_PASS="$(awk -F= '/^BROADCASTIFY_PASSWORD=/{print $2; exit}' "$src" || true)"
      [[ -n "$BC_USER" ]] && break
    fi
  done
fi
[[ -n "$BC_USER" ]] && echo "    found creds (user=${BC_USER:0:3}***)" || echo "    no creds found in any source"

if [[ ! -f "$ENV_FILE" ]]; then
  cat >"$ENV_FILE" <<EOF
# /etc/citypulse-downloader.env — consumed by citypulse-downloader.service
BROADCASTIFY_USERNAME=${BC_USER}
BROADCASTIFY_PASSWORD=${BC_PASS}

# Lambda transport
LAMBDA_USER=${LAMBDA_USER}
LAMBDA_HOST=${LAMBDA_HOST}
LAMBDA_SSH_KEY=${LAMBDA_SSH_KEY}
LAMBDA_INCOMING_DIR=${LAMBDA_INCOMING_DIR}

# Same allowlist the old monolithic backfill used — keeps both pipelines
# in sync on which cities are active.
BACKFILL_CITY_GLOB="philly chattanooga nyc sf"
BACKFILL_DAY_LIMIT=150

# Hetzner IP isn't throttled the way Lambda was, so we can be a bit more
# aggressive on pacing. If Broadcastify ever starts rate-limiting us
# anyway, bump these (or extend DOWNLOADER_BACKOFF_*).
DOWNLOADER_DELAY_BASE=5
DOWNLOADER_DELAY_JITTER=2
DOWNLOADER_BACKOFF_BASE=30
DOWNLOADER_BACKOFF_MULT=2
DOWNLOADER_BACKOFF_MAX=900
DOWNLOADER_429_ABORT=10
DOWNLOADER_COOLDOWN_AFTER_429=3600
DOWNLOADER_CYCLE_SLEEP_S=600

# Backpressure: stop downloading once Lambda has more than this many
# unprocessed sidecars in /var/spool/citypulse-incoming/. ~40 segments
# at ~5MB each is ~200MB of buffered MP3 — harmless but Whisper will
# keep up easily.
DOWNLOADER_MAX_QUEUE_DEPTH=40

DOWNLOADER_PROGRESS_DIR=${PROGRESS_DIR}
DOWNLOADER_HEARTBEAT=${HEARTBEAT}

PYTHONUNBUFFERED=1
EOF
  chmod 640 "$ENV_FILE"
  if [[ -z "$BC_USER" ]]; then
    echo "    !! $ENV_FILE has empty Broadcastify creds; fill in before starting"
  fi
else
  # Idempotent backfill: if the file already exists but its creds are
  # blank (e.g. a previous run failed to fetch from Lambda), rewrite
  # just the BROADCASTIFY_* lines. Don't touch anything else the
  # operator may have edited.
  EXISTING_USER="$(awk -F= '/^BROADCASTIFY_USERNAME=/{print $2; exit}' "$ENV_FILE" || true)"
  if [[ -z "$EXISTING_USER" && -n "$BC_USER" ]]; then
    echo "    backfilling Broadcastify creds into existing $ENV_FILE"
    sed -i \
        -e "s|^BROADCASTIFY_USERNAME=.*|BROADCASTIFY_USERNAME=${BC_USER}|" \
        -e "s|^BROADCASTIFY_PASSWORD=.*|BROADCASTIFY_PASSWORD=${BC_PASS}|" \
        "$ENV_FILE"
  else
    echo "    Keeping existing $ENV_FILE (edit by hand if creds need updating)"
  fi
fi

echo "==> 6. systemd unit at $SERVICE_FILE"
cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=CityPulse Broadcastify downloader (Hetzner side of split-pipeline)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${REPO_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${REPO_DIR}/.venv-downloader/bin/python -u ${REPO_DIR}/scripts/hetzner_archive_downloader.py
Restart=on-failure
RestartSec=30
# Keep the journal+log file in sync; useful when debugging via either.
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}
StartLimitIntervalSec=600
StartLimitBurst=10

# Polite resource limits — the box is 2GB RAM and the downloader is
# trivial (requests + scp), but hard caps prevent a runaway from
# starving philly-pulse-api.
MemoryMax=512M
CPUQuota=50%

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload

echo
echo "==> Install complete."
if grep -q '^BROADCASTIFY_USERNAME=$' "$ENV_FILE" 2>/dev/null; then
  echo "    NEXT: fill in $ENV_FILE then run:"
  echo "      systemctl enable --now citypulse-downloader"
else
  echo "    NEXT: systemctl enable --now citypulse-downloader"
fi
echo "    Watch:    journalctl -fu citypulse-downloader  (or)  tail -f ${LOG_FILE}"
echo "    Heartbeat: cat ${HEARTBEAT}"
