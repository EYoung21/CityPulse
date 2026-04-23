#!/bin/bash
# continuous_backfill.sh
#
# Long-running daemon that keeps the archive backfill saturated against
# Broadcastify's per-account daily download cap. Runs forever, checking
# every CHECK_INTERVAL_SEC whether any bp-* SLURM jobs are still in the
# queue. When the queue drains (because the last wave hit quota and exited
# cleanly), it kicks off a fresh cycle via daily_backfill_cycle.sh.
#
# Why this beats a once-a-day cron:
#   - Some feeds finish their entire 150-day window before quota hits
#     (especially feeds with mostly "no_archives" days). Cron would leave
#     them idle for hours; this daemon re-launches them immediately.
#   - If the cluster is busy and our SLURM jobs sit in PENDING for a long
#     time, the cycle still lines up the next wave the moment they finish,
#     instead of waiting for the next 00:35 EDT tick.
#   - Cycle launching is itself idempotent (progress files dedupe done
#     segments), so worst case we start a redundant wave that exits in
#     seconds with QUOTA EXHAUSTED.
#
# Run via:
#   nohup bash continuous_backfill.sh > /dev/null 2>&1 &
#   disown
# or in a tmux session for easy attach/inspect.

set -u

cd "$(dirname "$0")"

LOG_DIR="logs"
mkdir -p "$LOG_DIR"
DAEMON_LOG="${LOG_DIR}/continuous_backfill.log"

CHECK_INTERVAL_SEC=300
COOLDOWN_AFTER_LAUNCH_SEC=600

exec >> "$DAEMON_LOG" 2>&1

echo "[$(date)] === continuous_backfill daemon starting (PID $$) ==="

while true; do
    BP_COUNT=$(squeue -u "$USER" --noheader --format="%j" 2>/dev/null | grep -c "^bp-" || true)

    if [ "$BP_COUNT" -gt 0 ]; then
        echo "[$(date)] $BP_COUNT bp-* jobs still in queue, sleeping ${CHECK_INTERVAL_SEC}s"
        sleep "$CHECK_INTERVAL_SEC"
        continue
    fi

    echo "[$(date)] Queue is empty, launching new cycle..."
    if bash daily_backfill_cycle.sh; then
        echo "[$(date)] Cycle launched OK, cooling down ${COOLDOWN_AFTER_LAUNCH_SEC}s before next check"
    else
        echo "[$(date)] WARN: cycle launch returned non-zero, cooling down ${COOLDOWN_AFTER_LAUNCH_SEC}s anyway"
    fi
    sleep "$COOLDOWN_AFTER_LAUNCH_SEC"
done
