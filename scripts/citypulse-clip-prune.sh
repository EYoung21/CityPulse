#!/usr/bin/env bash
# Prune local audio-clip staging directories on the Lambda transcriber box.
#
# The live transcriber (multi_transcriber.py) writes every captured segment to
# audio_clips_raw/ and audio_clips/, but the philly_pulse bridge uploads each
# clip to GCS / Firebase Storage at ingest time. The local copies are therefore
# transient staging and safe to delete once they age out — nothing serves audio
# from this box. Without this prune the dirs grow unbounded and eventually fill
# the disk, which crash-loops every pulse-live@<city> transcriber on
# "[Errno 28] No space left on device" (root cause of the 2026-06 outage).
#
# Install (Lambda box):
#   sudo cp scripts/citypulse-clip-prune.sh /usr/local/bin/citypulse-clip-prune.sh
#   sudo chmod +x /usr/local/bin/citypulse-clip-prune.sh
#   sudo cp systemd/citypulse-clip-prune.{service,timer} /etc/systemd/system/
#   sudo systemctl daemon-reload && sudo systemctl enable --now citypulse-clip-prune.timer
set -uo pipefail

RAW=/opt/citypulse-backfill/audio_clips_raw
PROC=/opt/citypulse-backfill/audio_clips

# Raw captures are only useful for short-term re-transcription; processed clips
# are already in GCS. Keep a few days of slack, drop the rest.
find "$RAW"  -maxdepth 1 -type f -name '*.wav' -mtime +3 -delete 2>/dev/null || true
find "$PROC" -maxdepth 1 -type f -name '*.wav' -mtime +5 -delete 2>/dev/null || true

echo "$(date -Is) clip-prune done; disk: $(df -h / | awk 'NR==2{print $5" used, "$4" free"}')"
