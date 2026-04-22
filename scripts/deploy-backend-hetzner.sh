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
  # Enable + restart every city that has a config on disk. This is
  # idempotent so newly-added cities (Memphis, Detroit, Orlando,
  # Miami, LA, Las Vegas, ...) come up automatically on next deploy
  # without needing a manual setup-multi-city.sh run.
  for cfg in cities/*/config.yaml; do
    [ -f "$cfg" ] || continue
    city="$(basename "$(dirname "$cfg")")"
    if ! systemctl is-enabled "pulse-live@${city}" &>/dev/null; then
      echo "Enabling new city: pulse-live@${city}"
      systemctl enable "pulse-live@${city}" || {
        echo "WARNING: failed to enable pulse-live@${city}, skipping"
        continue
      }
    fi
    systemctl restart "pulse-live@${city}"
    sleep 1
    systemctl is-active "pulse-live@${city}" || echo "WARNING: pulse-live@${city} failed to start"
  done
else
  # Legacy single-city service
  systemctl restart philly-pulse-live
  sleep 2
  systemctl is-active philly-pulse-live || echo "WARNING: philly-pulse-live failed to start"
fi

echo "Deploy complete at $(date)"
