#!/bin/bash
# Reference script for /root/deploy.sh on the Hetzner API host.
# GitHub Actions SSH runs the copy on the server — keep them in sync.
set -e
cd /root/PhillyPulse

if [ -n "$GITHUB_TOKEN" ]; then
  git remote set-url origin "https://x-access-token:${GITHUB_TOKEN}@github.com/EYoung21/CityPulse.git"
fi

git reset --hard HEAD
git clean -fd
git pull origin main
git remote set-url origin https://github.com/EYoung21/CityPulse.git

mkdir -p .secrets
cp /root/firebase-sa.json .secrets/firebase-service-account.json
cp /root/config.yaml config.yaml

source venv/bin/activate
pip install -q -r requirements-philly-pulse.txt

# systemd loads EnvironmentFile=/etc/philly-pulse.env (API keys, PHILLY_PULSE_LLM_AUTO, etc.).
# Bare `nohup uvicorn` skips that file → LLM pipeline off → only extractions, no map incidents.
systemctl restart philly-pulse-api
sleep 2
systemctl is-active philly-pulse-api

# Hetzner-side backfill is retired. Backfill is Lambda-only now.
for legacy in pulse-backfill.timer pulse-backfill.service; do
  if systemctl list-unit-files "$legacy" >/dev/null 2>&1; then
    echo "Removing legacy unit: $legacy"
    systemctl stop "$legacy" 2>/dev/null || true
    systemctl disable "$legacy" 2>/dev/null || true
    rm -f "/etc/systemd/system/${legacy}"
  fi
done
systemctl daemon-reload

# Live transcribers run on Lambda — sync multi_transcriber + cities/ so
# per-city VAD/tuning changes ship with every API deploy.
if [ -x /root/PhillyPulse/scripts/sync_lambda_live_transcribers.sh ]; then
  bash /root/PhillyPulse/scripts/sync_lambda_live_transcribers.sh || echo "WARNING: Lambda transcriber sync failed (non-fatal for API)"
fi

echo "Deploy complete at $(date)"
