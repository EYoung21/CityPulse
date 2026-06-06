#!/usr/bin/env bash
# CityPulse Ollama wedge watchdog (Lambda GPU box).
#
# The live Whisper transcribers pin the A10 GPU, which throttles the local
# Ollama (the ingest / incident-extraction LLM — local-only by design, NOT
# DeepSeek) to ~60s per call and can occasionally wedge it entirely: inference
# hangs, /api/ingest blocks, and incidents stop landing. This probes Ollama and
# restarts ollama.service ONLY when it is genuinely wedged. A merely slow
# (~60s) Ollama under GPU contention is normal and is NOT restarted.
#
# Install (Lambda box):
#   sudo cp scripts/citypulse-ollama-watchdog.sh /usr/local/bin/
#   sudo chmod +x /usr/local/bin/citypulse-ollama-watchdog.sh
#   sudo cp systemd/citypulse-ollama-watchdog.{service,timer} /etc/systemd/system/
#   sudo systemctl daemon-reload && sudo systemctl enable --now citypulse-ollama-watchdog.timer
set -uo pipefail

OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434/api/generate}"
MODEL="${OLLAMA_WATCHDOG_MODEL:-qwen2.5:7b-instruct-q5_K_M}"
# Must sit well above Ollama's normal contended latency (~60s) so we only trip
# on a true hang, never on ordinary slowness.
TIMEOUT="${OLLAMA_WATCHDOG_TIMEOUT:-150}"
PAYLOAD="{\"model\":\"$MODEL\",\"prompt\":\"ping\",\"stream\":false,\"options\":{\"num_predict\":1}}"

probe() {
  curl -s -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" \
    "$OLLAMA_URL" -H 'Content-Type: application/json' -d "$PAYLOAD" 2>/dev/null
}

c1=$(probe)
if [ "$c1" = "200" ]; then
  echo "$(date -Is) ollama-watchdog: ok (probe1=$c1)"
  exit 0
fi

# Confirm before acting — never restart on a single transient blip.
sleep 20
c2=$(probe)
if [ "$c2" = "200" ]; then
  echo "$(date -Is) ollama-watchdog: recovered (probe1=$c1 probe2=$c2)"
  exit 0
fi

echo "$(date -Is) ollama-watchdog: WEDGED (probe1=$c1 probe2=$c2) — restarting ollama.service"
systemctl restart ollama.service
echo "$(date -Is) ollama-watchdog: restart issued"
