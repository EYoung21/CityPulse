#!/usr/bin/env bash
# scripts/deploy_lambda_backfill.sh
#
# One-shot deployer: rsyncs this repo to ubuntu@$LAMBDA_IP:/opt/citypulse-backfill,
# pushes Broadcastify creds from local config.yaml into the remote env
# file, runs the installer, and starts the systemd unit.
#
# Idempotent. Re-run after editing backfill_archives.py or
# scripts/lambda_backfill_runner.py to redeploy in <5s.
#
# Usage:
#   LAMBDA_IP=150.230.182.19 ./scripts/deploy_lambda_backfill.sh
#   # or:
#   ./scripts/deploy_lambda_backfill.sh 150.230.182.19

set -euo pipefail

LAMBDA_IP="${1:-${LAMBDA_IP:-150.230.182.19}}"
LAMBDA_USER="${LAMBDA_USER:-ubuntu}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
if [[ ! -f "$SSH_KEY" && -f "$ROOT/.secrets/prod_lambda_tunnel_key" ]]; then
    SSH_KEY="$ROOT/.secrets/prod_lambda_tunnel_key"
fi
REPO_DIR_REMOTE="${REPO_DIR_REMOTE:-/opt/citypulse-backfill}"
ENV_FILE_REMOTE="${ENV_FILE_REMOTE:-/etc/citypulse-backfill.env}"
FIREBASE_LOCAL=""
if [[ -f "$ROOT/.secrets/firebase-service-account.json" ]]; then
    FIREBASE_LOCAL="$ROOT/.secrets/firebase-service-account.json"
elif compgen -G "$ROOT"/phlpulse-firebase-adminsdk-*.json >/dev/null 2>&1; then
    FIREBASE_LOCAL=$(compgen -G "$ROOT"/phlpulse-firebase-adminsdk-*.json | head -1)
fi

echo "==> Target: ${LAMBDA_USER}@${LAMBDA_IP}"

# Pull Broadcastify creds out of the local config.yaml so we don't have
# to ask the user. config.yaml is gitignored so this stays local.
if [[ -f "$ROOT/config.yaml" ]]; then
    BCFY_USER=$(python3 -c "import yaml; print(yaml.safe_load(open('$ROOT/config.yaml'))['credentials']['username'])")
    BCFY_PASS=$(python3 -c "import yaml; print(yaml.safe_load(open('$ROOT/config.yaml'))['credentials']['password'])")
else
    echo "ERROR: $ROOT/config.yaml not found; can't extract Broadcastify creds." >&2
    echo "       Set BROADCASTIFY_USERNAME and BROADCASTIFY_PASSWORD in env to skip the auto-pull." >&2
    BCFY_USER="${BROADCASTIFY_USERNAME:-}"
    BCFY_PASS="${BROADCASTIFY_PASSWORD:-}"
    if [[ -z "$BCFY_USER" || -z "$BCFY_PASS" ]]; then
        exit 1
    fi
fi

echo "==> 1. rsync repo to ${REPO_DIR_REMOTE} (excluding heavy/local stuff)"
ssh -i "$SSH_KEY" "${LAMBDA_USER}@${LAMBDA_IP}" "sudo mkdir -p $REPO_DIR_REMOTE && sudo chown -R ${LAMBDA_USER} $REPO_DIR_REMOTE"
rsync -az --delete \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude 'frontend/' \
    --exclude '.next/' \
    --exclude '__pycache__/' \
    --exclude '*.pyc' \
    --exclude 'audio_clips/' \
    --exclude 'audio_clips_raw/' \
    --exclude 'backfill_progress/' \
    --exclude 'logs/' \
    --exclude '*.mp3' \
    --exclude '*.wav' \
    --exclude '*.db' \
    --exclude '*.sqlite*' \
    --exclude '.venv/' \
    --exclude '.secrets/' \
    -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new" \
    "$ROOT/" "${LAMBDA_USER}@${LAMBDA_IP}:${REPO_DIR_REMOTE}/"

if [[ -n "$FIREBASE_LOCAL" ]]; then
    echo "==> 1b. Push Firebase service account to $REPO_DIR_REMOTE/.secrets/"
    ssh -i "$SSH_KEY" "${LAMBDA_USER}@${LAMBDA_IP}" "mkdir -p ${REPO_DIR_REMOTE}/.secrets && chmod 700 ${REPO_DIR_REMOTE}/.secrets"
    scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new \
        "$FIREBASE_LOCAL" "${LAMBDA_USER}@${LAMBDA_IP}:${REPO_DIR_REMOTE}/.secrets/firebase-service-account.json"
    ssh -i "$SSH_KEY" "${LAMBDA_USER}@${LAMBDA_IP}" "chmod 600 ${REPO_DIR_REMOTE}/.secrets/firebase-service-account.json"
else
    echo "==> 1b. No local Firebase JSON found (.secrets/firebase-service-account.json or phlpulse-firebase-adminsdk-*.json); skip push"
fi

echo "==> 2. Run installer (apt deps, venv, systemd units)"
ssh -i "$SSH_KEY" "${LAMBDA_USER}@${LAMBDA_IP}" "bash $REPO_DIR_REMOTE/scripts/install_lambda_backfill.sh"

echo "==> 3. Patch creds into ${ENV_FILE_REMOTE}"
ssh -i "$SSH_KEY" "${LAMBDA_USER}@${LAMBDA_IP}" "
    sudo sed -i 's|^BROADCASTIFY_USERNAME=.*|BROADCASTIFY_USERNAME=${BCFY_USER//|/\\|}|' ${ENV_FILE_REMOTE}
    sudo sed -i 's|^BROADCASTIFY_PASSWORD=.*|BROADCASTIFY_PASSWORD=${BCFY_PASS//|/\\|}|' ${ENV_FILE_REMOTE}
    echo '  creds patched, env file now has:'
    sudo grep -E '^(BROADCASTIFY_|PP_BRIDGE_|WHISPER_|BACKFILL_)' ${ENV_FILE_REMOTE} | \
        sed -E 's|(PASSWORD=).*|\1<set>|; s|(USERNAME=).+|\1<set>|'
"

START_BACKFILL="${START_BACKFILL:-0}"

echo "==> 4. Start (or restart) loopback ingest API"
ssh -i "$SSH_KEY" "${LAMBDA_USER}@${LAMBDA_IP}" "
    sudo systemctl enable citypulse-ingest-api
    sudo systemctl restart citypulse-ingest-api
    sleep 2
    sudo systemctl status citypulse-ingest-api --no-pager -l | head -18
"

if [[ "$START_BACKFILL" == "1" ]]; then
    echo "==> 5. START_BACKFILL=1: starting archive backfill"
    ssh -i "$SSH_KEY" "${LAMBDA_USER}@${LAMBDA_IP}" "
        sudo systemctl enable citypulse-backfill
        sudo systemctl restart citypulse-backfill
        sleep 2
        sudo systemctl status citypulse-backfill --no-pager -l | head -18
    "
else
    echo "==> 5. Leaving archive backfill stopped/disabled to protect realtime live streams"
    ssh -i "$SSH_KEY" "${LAMBDA_USER}@${LAMBDA_IP}" "
        sudo systemctl disable --now citypulse-backfill 2>/dev/null || true
        sudo systemctl is-active citypulse-backfill || true
    "
fi

echo
echo "==> Deployed. Tail logs:"
echo "    ssh -i $SSH_KEY ${LAMBDA_USER}@${LAMBDA_IP} 'tail -f /var/log/citypulse-ingest-api.log /var/log/citypulse-backfill.log'"
echo "==> Heartbeat (poll from your laptop):"
echo "    ssh -i $SSH_KEY ${LAMBDA_USER}@${LAMBDA_IP} 'cat /var/log/lambda_backfill.heartbeat'"
