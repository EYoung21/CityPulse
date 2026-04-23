#!/bin/bash
# Launch backfill for a single city using its config YAML.
# Reads feeds from the config and submits one SLURM job per feed.
#
# Usage:
#   ./launch_city_backfill.sh cities/sf/config.yaml
#   ./launch_city_backfill.sh cities/nyc/config.yaml --days 90

set -e

CONFIG="$1"
shift || true

if [ -z "$CONFIG" ] || [ ! -f "$CONFIG" ]; then
    echo "Usage: $0 <city-config.yaml> [extra backfill_archives.py args]"
    echo "Example: $0 cities/sf/config.yaml --days 90"
    exit 1
fi

CITY_NAME=$(python3 -c "
import yaml, sys
with open('$CONFIG') as f:
    cfg = yaml.safe_load(f)
print(cfg.get('city', {}).get('name', 'Unknown'))
")

FEED_IDS=$(python3 -c "
import yaml
with open('$CONFIG') as f:
    cfg = yaml.safe_load(f)
for f in cfg.get('feeds', []):
    print(f['feed_id'] + ':' + f.get('label', f['feed_id']))
")

if [ -z "$FEED_IDS" ]; then
    echo "ERROR: No feeds found in $CONFIG"
    exit 1
fi

FEED_COUNT=$(echo "$FEED_IDS" | wc -l | tr -d ' ')

DAY_LIST="backfill_days_${CITY_NAME// /_}.txt"
echo "=== ${CITY_NAME} Backfill ==="
echo "Config:  $CONFIG"
echo "Feeds:   $FEED_COUNT"
echo ""

echo "Generating day list..."
python3 generate_day_list.py -o "${DAY_LIST}" 2>/dev/null || {
    echo "generate_day_list.py not found or failed; using --days 150 instead"
    DAY_LIST=""
}

SLURM_SCRIPT="backfill_single_feed.slurm"
JOB_IDS=()

if [ -f "$SLURM_SCRIPT" ] && command -v sbatch &>/dev/null; then
    echo "Submitting SLURM jobs (1 per feed)..."
    echo ""

    while IFS= read -r line; do
        IFS=':' read -r fid label <<< "$line"
        EXTRA_ARGS=""
        if [ -n "$DAY_LIST" ] && [ -f "$DAY_LIST" ]; then
            EXTRA_ARGS="DAY_LIST=${DAY_LIST},"
        fi

        JID=$(sbatch \
            --job-name="bp-${label}" \
            --export="${EXTRA_ARGS}FEEDS=${fid},CITY_CONFIG=${CONFIG}" \
            "$SLURM_SCRIPT" | awk '{print $NF}')

        echo "  Job $JID: ${label} (feed ${fid})"
        JOB_IDS+=("$JID")
        sleep 15
    done <<< "$FEED_IDS"

    echo ""
    echo "=== ${#JOB_IDS[@]} jobs submitted for ${CITY_NAME} ==="
    echo "Job IDs: ${JOB_IDS[*]}"
else
    echo "No SLURM available — running backfill directly..."
    echo ""

    while IFS= read -r line; do
        IFS=':' read -r fid label <<< "$line"
        echo "--- Backfilling feed ${fid} (${label}) ---"
        DAY_ARGS=""
        if [ -n "$DAY_LIST" ] && [ -f "$DAY_LIST" ]; then
            DAY_ARGS="--day-list ${DAY_LIST}"
        else
            DAY_ARGS="--days 150"
        fi
        python3 backfill_archives.py --config "$CONFIG" --feed "$fid" $DAY_ARGS "$@" || {
            echo "WARNING: Feed ${fid} (${label}) failed, continuing..."
        }
    done <<< "$FEED_IDS"

    echo ""
    echo "=== ${CITY_NAME} backfill complete ==="
fi
