#!/bin/bash
# Backfill one city at a time, one day per run.
# Designed to be run via cron every 2 hours to respect Broadcastify rate limits.
#
# Usage:  ./backfill_cron.sh
# Cron:   0 */2 * * * cd /home/ubuntu/PhillyPulse && ./backfill_cron.sh >> logs/backfill_cron.log 2>&1
#
# The script round-robins through cities and processes the next unfinished day.

set -euo pipefail
cd "$(dirname "$0")"

CITIES=("sf" "nyc" "philly" "chattanooga")
CITY_NAMES=("San Francisco" "New York City" "Philadelphia" "Chattanooga")
STATE_FILE="backfill_progress/cron_state.json"
DAYS=150

mkdir -p backfill_progress logs

# Initialize state file if missing
if [ ! -f "$STATE_FILE" ]; then
    echo '{"city_idx": 0, "completed_runs": 0}' > "$STATE_FILE"
fi

CITY_IDX=$(python3 -c "import json; print(json.load(open('$STATE_FILE'))['city_idx'])")
CITY="${CITIES[$CITY_IDX]}"
CITY_NAME="${CITY_NAMES[$CITY_IDX]}"

echo ""
echo "================================================================="
echo "  Backfill cron: $CITY_NAME ($(date))"
echo "================================================================="

# Run backfill for one feed of this city, limited days
# The script's built-in progress tracking skips already-done days
python3 -u backfill_archives.py \
    --config "cities/$CITY/config.yaml" \
    --days "$DAYS"

# Rotate to next city
NEXT_IDX=$(( (CITY_IDX + 1) % ${#CITIES[@]} ))
RUNS=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('completed_runs', 0))")
python3 -c "
import json
state = {'city_idx': $NEXT_IDX, 'completed_runs': $RUNS + 1}
json.dump(state, open('$STATE_FILE', 'w'), indent=2)
"

echo "Next run will process: ${CITY_NAMES[$NEXT_IDX]}"
echo "Cron run complete at $(date)"
