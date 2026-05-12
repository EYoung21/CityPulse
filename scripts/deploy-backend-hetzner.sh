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

# Active realtime cities. Anything in cities/<slug>/config.yaml that is
# NOT in this list gets stopped + disabled below. Keep in sync with
# scripts/setup-multi-city.sh and .github/workflows/server-setup-multi-city.yml.
ACTIVE_CITIES=(sf nyc philly chattanooga)

is_active_city() {
  local target="$1"
  for c in "${ACTIVE_CITIES[@]}"; do
    [ "$c" = "$target" ] && return 0
  done
  return 1
}

  # Transcribers run on Lambda now. Do not start them on Hetzner.

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
else
  # Legacy single-city service
  systemctl restart philly-pulse-live
  sleep 2
  systemctl is-active philly-pulse-live || echo "WARNING: philly-pulse-live failed to start"
fi

echo "Deploy complete at $(date)"
