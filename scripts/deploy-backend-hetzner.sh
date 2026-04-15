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

# Restart transcriber services so they pick up updated bridge.py / config
for svc in $(systemctl list-units --type=service --state=running --plain --no-legend 2>/dev/null \
             | awk '/pulse-transcriber/{print $1}'); do
  echo "Restarting transcriber: $svc"
  systemctl restart "$svc"
  sleep 2
  systemctl is-active "$svc" || echo "WARNING: $svc failed to start"
done

echo "Deploy complete at $(date)"
