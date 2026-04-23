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
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
REPO_DIR_REMOTE="${REPO_DIR_REMOTE:-/opt/citypulse-backfill}"
ENV_FILE_REMOTE="${ENV_FILE_REMOTE:-/etc/citypulse-backfill.env}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

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

echo "==> 2. Run installer (apt deps, venv, systemd unit)"
ssh -i "$SSH_KEY" "${LAMBDA_USER}@${LAMBDA_IP}" "bash $REPO_DIR_REMOTE/scripts/install_lambda_backfill.sh"

echo "==> 3. Patch creds into ${ENV_FILE_REMOTE}"
ssh -i "$SSH_KEY" "${LAMBDA_USER}@${LAMBDA_IP}" "
    sudo sed -i 's|^BROADCASTIFY_USERNAME=.*|BROADCASTIFY_USERNAME=${BCFY_USER//|/\\|}|' ${ENV_FILE_REMOTE}
    sudo sed -i 's|^BROADCASTIFY_PASSWORD=.*|BROADCASTIFY_PASSWORD=${BCFY_PASS//|/\\|}|' ${ENV_FILE_REMOTE}
    echo '  creds patched, env file now has:'
    sudo grep -E '^(BROADCASTIFY_|PP_BRIDGE_|WHISPER_|BACKFILL_)' ${ENV_FILE_REMOTE} | \
        sed -E 's|(PASSWORD=).*|\1<set>|; s|(USERNAME=).+|\1<set>|'
"

echo "==> 4. Start (or restart) citypulse-backfill.service"
ssh -i "$SSH_KEY" "${LAMBDA_USER}@${LAMBDA_IP}" "
    sudo systemctl enable citypulse-backfill
    sudo systemctl restart citypulse-backfill
    sleep 3
    sudo systemctl status citypulse-backfill --no-pager -l | head -25
"

echo
echo "==> Deployed. Tail logs:"
echo "    ssh -i $SSH_KEY ${LAMBDA_USER}@${LAMBDA_IP} 'sudo journalctl -fu citypulse-backfill'"
echo "==> Heartbeat (poll from your laptop):"
echo "    ssh -i $SSH_KEY ${LAMBDA_USER}@${LAMBDA_IP} 'cat /var/log/lambda_backfill.heartbeat'"
