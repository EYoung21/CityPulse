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

# Broadcastify audio and Lambda GPU ingestion are retired. Stop every known
# unit before starting the structured public-source poller so a stale machine
# cannot reconnect to the blocked provider or a future Lambda instance.
for legacy in \
  pulse-backfill.timer \
  pulse-backfill.service \
  citypulse-downloader.service \
  citypulse-backfill.service \
  citypulse-backfill.timer \
  citypulse-audio-regen.service \
  citypulse-audio-regen.timer \
  lambda-ollama-tunnel.service \
  citypulse-ollama-watchdog.service \
  citypulse-ollama-watchdog.timer \
  pulse-live@philly.service \
  pulse-live@philly2.service \
  pulse-live@sf.service \
  pulse-live@nyc.service \
  pulse-live@chattanooga.service; do
  if systemctl list-unit-files "$legacy" >/dev/null 2>&1; then
    echo "Disabling retired unit: $legacy"
    systemctl stop "$legacy" 2>/dev/null || true
    systemctl disable "$legacy" 2>/dev/null || true
  fi
done

install -m 0644 \
  /root/PhillyPulse/systemd/citypulse-public-sources.service \
  /etc/systemd/system/citypulse-public-sources.service
systemctl daemon-reload
systemctl enable citypulse-public-sources.service
systemctl restart citypulse-public-sources.service
sleep 3
systemctl is-active citypulse-public-sources.service

echo "Deploy complete at $(date)"
