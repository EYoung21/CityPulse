#!/usr/bin/env bash
# Run on Hetzner after `git pull` — rsyncs live transcriber bits to Lambda and
# restarts pulse-live@* so VAD/tuning changes in cities/<slug>/config.yaml apply.
# Requires /root/.ssh/lambda_tunnel_key and Lambda reachable (same as GitHub Actions).

set -euo pipefail
REPO="${REPO:-/root/PhillyPulse}"
LAMBDA_USER="${LAMBDA_USER:-ubuntu}"
LAMBDA_IP="${LAMBDA_IP:-150.230.182.19}"
DEST="${DEST:-/opt/citypulse-backfill}"
SSH_KEY="${SSH_KEY:-/root/.ssh/lambda_tunnel_key}"

if [[ ! -f "$SSH_KEY" ]]; then
  echo "No $SSH_KEY — skipping Lambda transcriber sync."
  exit 0
fi

SSH_OPTS=(-i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
# philly2 is a shard of Philly (same slug, suburb feeds only) so two
# Whisper worker pools can drain the metro's 24-feed firehose. Keep in
# sync with install_lambda_live_transcribers.sh + deploy-backend-hetzner.sh.
ACTIVE_CITIES="${ACTIVE_CITIES:-sf nyc philly philly2 chattanooga}"

echo "==> Rsync transcriber + city configs → $LAMBDA_USER@$LAMBDA_IP:$DEST"
rsync -az -e "ssh ${SSH_OPTS[*]}" \
  "$REPO/multi_transcriber.py" \
  "$LAMBDA_USER@$LAMBDA_IP:$DEST/multi_transcriber.py"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  "$REPO/cities/" \
  "$LAMBDA_USER@$LAMBDA_IP:$DEST/cities/"
rsync -az -e "ssh ${SSH_OPTS[*]}" \
  "$REPO/philly_pulse/preprocess.py" \
  "$REPO/philly_pulse/bridge.py" \
  "$LAMBDA_USER@$LAMBDA_IP:$DEST/philly_pulse/"

echo "==> Enable + restart pulse-live@ ($ACTIVE_CITIES)"
# `enable` is idempotent and a no-op for cities already enabled; pairing
# it with `restart` here means a brand-new city slug (e.g. when we shard
# Philly into philly + philly2) starts on the next sync without anyone
# having to SSH and run install_lambda_live_transcribers.sh by hand.
# pulse-live@.service is a template, so no new unit file is needed for
# new instances — only the enable + restart pair.
for city in $ACTIVE_CITIES; do
  ssh "${SSH_OPTS[@]}" "$LAMBDA_USER@$LAMBDA_IP" \
    "sudo systemctl enable pulse-live@${city}.service 2>&1 | tail -1 ; sudo systemctl restart pulse-live@${city}.service" || true
done

sleep 5
for city in $ACTIVE_CITIES; do
  echo -n "  pulse-live@${city}: "
  ssh "${SSH_OPTS[@]}" "$LAMBDA_USER@$LAMBDA_IP" \
    "sudo systemctl is-active pulse-live@${city}.service" || true
  echo ""
done

echo "Lambda transcriber sync done."
