#!/bin/bash
# daily_backfill_cycle.sh
#
# Run once per day (after midnight US-Eastern, when Broadcastify's per-account
# daily download quota resets) to chip away at the 5-month archive backfill
# for every priority city. Idempotent: progress is tracked per-feed in
# backfill_progress/<feed_id>.json so previously-downloaded segments are
# skipped on re-runs.
#
# Strategy:
#   1. Cancel any leftover bp-* SLURM jobs from the previous day's cycle
#      (they're invariably stuck post-quota-exhaustion). This prevents
#      duplicate-job collisions when we re-submit.
#   2. Iterate the 10 priority cities in shuffled order. Shuffling matters:
#      whichever city's feeds start first each day hogs the quota window
#      before others are throttled, so rotating who-goes-first gives every
#      feed an equal long-run share.
#   3. Submit one SLURM job per feed via launch_city_backfill.sh. Each job
#      will work until quota_exhausted, then exit cleanly.
#
# Cron entry (intended):
#   35 0 * * *  /home/eyoung4-swat/PhillyPulse/daily_backfill_cycle.sh

set -e

cd "$(dirname "$0")"

LOG_DIR="logs"
mkdir -p "$LOG_DIR"
LOG="${LOG_DIR}/daily_backfill_$(date +%Y%m%d_%H%M%S).log"

exec >> "$LOG" 2>&1

echo "[$(date)] === Daily backfill cycle starting ==="

CITIES=(sf nyc philly chattanooga memphis detroit orlando miami la lasvegas)

LEFTOVER_JOBS=$(squeue -u "$USER" --noheader --format="%i %j" 2>/dev/null | awk '$2 ~ /^bp-/ {print $1}')
if [ -n "$LEFTOVER_JOBS" ]; then
    echo "[$(date)] Cancelling leftover bp-* jobs from previous cycle:"
    echo "$LEFTOVER_JOBS" | sed 's/^/  /'
    echo "$LEFTOVER_JOBS" | xargs -r scancel || true
    sleep 5
else
    echo "[$(date)] No leftover bp-* jobs to cancel."
fi

SHUFFLED=()
while IFS= read -r line; do
    SHUFFLED+=("$line")
done < <(printf '%s\n' "${CITIES[@]}" | shuf)

echo "[$(date)] Today's cycle order: ${SHUFFLED[*]}"

for c in "${SHUFFLED[@]}"; do
    cfg="cities/$c/config.yaml"
    if [ ! -f "$cfg" ]; then
        echo "[$(date)] WARN: $cfg not found, skipping $c"
        continue
    fi
    echo "[$(date)] === launching $c ==="
    if bash launch_city_backfill.sh "$cfg"; then
        echo "[$(date)] $c launched OK"
    else
        echo "[$(date)] WARN: $c launch returned non-zero"
    fi
    sleep 10
done

echo "[$(date)] === Daily backfill cycle complete ==="
