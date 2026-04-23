#!/usr/bin/env bash
# Run the LLM-fallback incident repair script across every Pulse city
# in descending order of work, waiting for each to finish before
# starting the next. Idempotent: safe to re-run any time — already-
# repaired incidents are filtered out by the geocode_status range
# query so a second run only picks up new tainted rows.
#
# Cities are ordered largest → smallest so the biggest visible
# cleanup happens first.
#
# Usage:
#   ./scripts/repair_all_cities.sh                       # all cities
#   ./scripts/repair_all_cities.sh chattanooga sf nyc    # subset
#   WAIT_FOR_PID=20687 ./scripts/repair_all_cities.sh    # block until
#                                                          a running
#                                                          repair (eg.
#                                                          philly) exits
#
# Requires: .env with LAMBDA_API_KEY (preferred) or OPENAI_API_KEY,
# .secrets/firebase-service-account.json, .venv/ activated venv with
# project deps installed. The active LLM provider is logged at startup.
set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
source .venv/bin/activate
set -a; source .env; set +a
export GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/.secrets/firebase-service-account.json"

mkdir -p logs

if [[ -n "${WAIT_FOR_PID:-}" ]]; then
  echo "[repair-all] waiting for PID $WAIT_FOR_PID to exit before starting..."
  while kill -0 "$WAIT_FOR_PID" 2>/dev/null; do
    sleep 30
  done
  echo "[repair-all] PID $WAIT_FOR_PID exited; proceeding."
fi

# Default order: largest cities first (counts as of repair start).
DEFAULT_CITIES=(chattanooga sf nyc)
CITIES=("${@:-${DEFAULT_CITIES[@]}}")

for city in "${CITIES[@]}"; do
  log="logs/repair-${city}.log"
  echo "[repair-all] === starting ${city} → ${log} ==="
  python3 -u scripts/repair_llm_fallback_incidents.py \
      --execute --city "$city" --sleep 0.05 \
      >"$log" 2>&1
  echo "[repair-all] === ${city} complete ==="
  tail -10 "$log"
done

echo "[repair-all] === ALL CITIES COMPLETE ==="
