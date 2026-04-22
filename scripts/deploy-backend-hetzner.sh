#!/bin/bash
# Reference script for /root/deploy.sh on the Hetzner API host.
# GitHub Actions SSH runs the copy on the server — keep them in sync.
set -e
cd /root/PhillyPulse

if [ -n "$GITHUB_TOKEN" ]; then
  git remote set-url origin "https://x-access-token:${GITHUB_TOKEN}@github.com/EYoung21/PhillyPulse.git"
fi

git reset --hard HEAD
git clean -fd
git pull origin main
git remote set-url origin https://github.com/EYoung21/PhillyPulse.git

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

# Restart the live transcribers (multi-city or legacy single-city)
if systemctl list-unit-files 'pulse-live@.service' &>/dev/null; then
  for city in sf nyc philly chattanooga memphis detroit orlando miami la lasvegas; do
    if systemctl is-enabled "pulse-live@${city}" &>/dev/null; then
      systemctl restart "pulse-live@${city}"
      sleep 1
      systemctl is-active "pulse-live@${city}" || echo "WARNING: pulse-live@${city} failed to start"
    fi
  done
else
  # Legacy single-city service
  systemctl restart philly-pulse-live
  sleep 2
  systemctl is-active philly-pulse-live || echo "WARNING: philly-pulse-live failed to start"
fi

echo "Deploy complete at $(date)"
