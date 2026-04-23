#!/usr/bin/env bash
# scripts/prod_setup_lambda_ollama.sh
#
# RUN ON PROD ONLY. Paste this whole file (or scp + bash it) onto the
# Hetzner backend at root@87.99.157.115. It sets up a persistent
# systemd-managed SSH tunnel from prod → Lambda A10 (instance
# 28d76b2c9eb249e9bd1d02354a34b04e at 150.230.182.19) so the
# `philly-pulse-api` service can hit Ollama at http://localhost:11435/v1.
#
# Idempotent: safe to re-run after the Lambda IP changes (just edit the
# LAMBDA_IP variable below) or to re-issue the tunnel key (replace
# /root/.ssh/lambda_tunnel_key + matching pubkey on the Lambda box).
#
# What it does, in order:
#   1. Installs the dedicated tunnel private key at /root/.ssh/lambda_tunnel_key
#      (you must supply the key file: see KEY SETUP below). The matching pubkey
#      must be in ubuntu@LAMBDA's authorized_keys.
#   2. Appends LLM_* vars to /etc/philly-pulse.env so philly-pulse-api
#      picks them up on next restart. Idempotent (sed-removes prior LLM_
#      block before appending).
#   3. Installs /etc/systemd/system/lambda-ollama-tunnel.service:
#      autossh-style ssh -N -L tunnel that systemd auto-restarts on drop.
#   4. Starts the tunnel + restarts philly-pulse-api.
#   5. Health checks: `curl localhost:11435/api/tags` (should list
#      qwen2.5:7b-instruct-q5_K_M) and a real chat completion.
#
# Rollback (after Lambda is gone):
#   systemctl disable --now lambda-ollama-tunnel.service
#   rm /etc/systemd/system/lambda-ollama-tunnel.service
#   sed -i '/^# --- Lambda Ollama tunnel/,/^# --- end Lambda/d' /etc/philly-pulse.env
#   systemctl restart philly-pulse-api

set -euo pipefail

LAMBDA_USER="ubuntu"
LAMBDA_IP="150.230.182.19"
LAMBDA_REMOTE_PORT=11434
LOCAL_TUNNEL_PORT=11435
TUNNEL_KEY="/root/.ssh/lambda_tunnel_key"
ENV_FILE="/etc/philly-pulse.env"

# KEY SETUP (never commit the private key to git):
#   On your laptop: scp .secrets/prod_lambda_tunnel_key root@hetzner:/root/lambda_tunnel_key.incoming
#   On prod: bash scripts/prod_setup_lambda_ollama.sh /root/lambda_tunnel_key.incoming
#   Or place the key at $TUNNEL_KEY yourself (chmod 600), then run this script with no args.
echo "==> 1. Installing dedicated tunnel key at $TUNNEL_KEY"
mkdir -p /root/.ssh
chmod 700 /root/.ssh
if [[ -f "$TUNNEL_KEY" ]]; then
  echo "    Key already present at $TUNNEL_KEY (not overwriting)"
elif [[ -n "${1:-}" && -f "$1" ]]; then
  install -m 600 "$1" "$TUNNEL_KEY"
  echo "    Installed key from $1"
else
  echo "ERROR: No tunnel key found." >&2
  echo "  Put the ed25519 private key at: $TUNNEL_KEY (chmod 600)" >&2
  echo "  Or run: $0 /path/to/prod_lambda_tunnel_key" >&2
  exit 1
fi

# Pre-trust the Lambda host so systemd's tunnel doesn't stall on the
# first-connect interactive prompt. Re-keyscan is idempotent; appended
# lines just shadow the older ones.
ssh-keygen -R "$LAMBDA_IP" >/dev/null 2>&1 || true
ssh-keyscan -H "$LAMBDA_IP" >> /root/.ssh/known_hosts 2>/dev/null

echo "==> 2. Appending LLM_* vars to $ENV_FILE"
touch "$ENV_FILE"
chmod 640 "$ENV_FILE"
# Strip any prior block we wrote so reruns are clean.
sed -i '/^# --- Lambda Ollama tunnel/,/^# --- end Lambda/d' "$ENV_FILE"
# Also strip bare LLM_* lines from any older deploy (one-shot migration).
sed -i '/^LLM_BASE_URL=/d;/^LLM_API_KEY=/d;/^LLM_MODEL=/d;/^LLM_PROVIDER_NAME=/d' "$ENV_FILE"
cat >> "$ENV_FILE" <<EOF
# --- Lambda Ollama tunnel (managed by lambda-ollama-tunnel.service) ---
LLM_BASE_URL=http://localhost:${LOCAL_TUNNEL_PORT}/v1
LLM_API_KEY=ollama
LLM_MODEL=qwen2.5:7b-instruct-q5_K_M
LLM_PROVIDER_NAME=lambda-ollama
# --- end Lambda Ollama tunnel ---
EOF

echo "==> 3. Installing systemd unit lambda-ollama-tunnel.service"
cat > /etc/systemd/system/lambda-ollama-tunnel.service <<EOF
[Unit]
Description=Persistent SSH tunnel: prod localhost:${LOCAL_TUNNEL_PORT} -> Lambda A10 :${LAMBDA_REMOTE_PORT} (Ollama)
# Run after the network is reachable; not strict (network-online.target
# can hang for 60-90s on container hosts).
After=network.target
Wants=network.target

[Service]
Type=simple
User=root
# -N: no remote command (just forward).
# -T: no pty.
# ServerAlive*: detect dead peer in ~90s and exit; systemd restarts us.
# ExitOnForwardFailure=yes: bail immediately if port :${LOCAL_TUNNEL_PORT}
#   is already taken (so systemd retries instead of silently no-op).
ExecStart=/usr/bin/ssh -N -T \\
    -i ${TUNNEL_KEY} \\
    -o BatchMode=yes \\
    -o StrictHostKeyChecking=accept-new \\
    -o ServerAliveInterval=30 \\
    -o ServerAliveCountMax=3 \\
    -o ExitOnForwardFailure=yes \\
    -o TCPKeepAlive=yes \\
    -L ${LOCAL_TUNNEL_PORT}:localhost:${LAMBDA_REMOTE_PORT} \\
    ${LAMBDA_USER}@${LAMBDA_IP}
Restart=always
RestartSec=10
# After the GPU is terminated (key revoked, port :11434 dead) ssh exits
# instantly; without these, systemd would back off forever on a 1-week-
# old failure. StartLimit caps how aggressive the loop gets.
StartLimitIntervalSec=300
StartLimitBurst=20

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now lambda-ollama-tunnel.service
sleep 2
echo "==> tunnel service status:"
systemctl is-active lambda-ollama-tunnel.service || true
ss -tlnp 2>/dev/null | grep ":${LOCAL_TUNNEL_PORT}\\b" || \
    echo "  WARNING: nothing listening on :${LOCAL_TUNNEL_PORT} yet. Give it 5-10s"

echo "==> 4. Restarting philly-pulse-api so it picks up new env"
systemctl restart philly-pulse-api
sleep 3
systemctl is-active philly-pulse-api

echo "==> 5. Health checks"
echo "  /api/tags via tunnel:"
curl -sS --max-time 8 "http://localhost:${LOCAL_TUNNEL_PORT}/api/tags" | head -c 300
echo
echo "  chat completion smoke test:"
curl -sS --max-time 30 "http://localhost:${LOCAL_TUNNEL_PORT}/v1/chat/completions" \
    -H 'Authorization: Bearer ollama' \
    -H 'Content-Type: application/json' \
    -d '{"model":"qwen2.5:7b-instruct-q5_K_M","messages":[{"role":"user","content":"Reply with the single word OK"}],"max_tokens":4}' \
    | head -c 400
echo
echo "  philly-pulse-api LLM provider self-report (if /api/health exposes it):"
curl -sS --max-time 5 http://127.0.0.1:8765/api/health 2>/dev/null | head -c 400 || echo "  (no health endpoint, skip)"

echo
echo "==> Done. The /api/ingest endpoint will now use Lambda Ollama."
echo "    Watch live: journalctl -fu philly-pulse-api"
echo "    Watch tunnel: journalctl -fu lambda-ollama-tunnel"
