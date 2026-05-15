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
ACTIVE_CITIES="${ACTIVE_CITIES:-sf nyc philly chattanooga}"

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

echo "==> Restart pulse-live@ ($ACTIVE_CITIES)"
for city in $ACTIVE_CITIES; do
  ssh "${SSH_OPTS[@]}" "$LAMBDA_USER@$LAMBDA_IP" \
    "sudo systemctl restart pulse-live@${city}.service" || true
done

sleep 5
for city in $ACTIVE_CITIES; do
  echo -n "  pulse-live@${city}: "
  ssh "${SSH_OPTS[@]}" "$LAMBDA_USER@$LAMBDA_IP" \
    "sudo systemctl is-active pulse-live@${city}.service" || true
  echo ""
done

echo "Lambda transcriber sync done."
