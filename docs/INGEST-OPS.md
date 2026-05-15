# Ingest operations

## Transcriber throughput (multi_feed)

- `multi_transcriber.py` scales Whisper worker threads with **feed count** (default floor 3, cap 6). Low-feed cities (NYC, SF) used to share the same cap as three workers total, which increased **queue depth** during voice bursts.
- Override on Lambda: `Environment=PULSE_TRANSCRIBE_WORKERS=5` in the `pulse-live@.service` drop-in, then `sudo systemctl daemon-reload && sudo systemctl restart pulse-live@nyc`.
- Per-city **VAD** overrides live in `cities/<slug>/config.yaml` under `vad_and_silence:` (`vad_aggressiveness`, `min_speech_seconds`, `silence_limit`). NYC/SF use softer VAD + shorter silence tail so short FDNY/SFFD phrases become segments sooner.
- **Queue backlog**: every 30s the process logs `[Status] feeds=… queue=…`. If you see `[WARN] transcription_queue depth=25`, ingest or Whisper is behind — raise workers slightly or check `journalctl -u philly-pulse-api` for slow `/api/ingest` on Hetzner.

## Live transcribers

- `systemctl status pulse-live@philly` (and `@nyc`, etc.)
- **Lambda (GPU host):** `sudo journalctl -u pulse-live@nyc.service -f --no-pager` (swap `nyc` for `sf`, etc.). Combined file log: `tail -f /var/log/pulse-live.log`. Grep for backlog: `grep -E 'queue=|\\[WARN\\]' /var/log/pulse-live.log | tail`.
- **Hetzner API:** `journalctl -u philly-pulse-api -f` — watch `POST /api/ingest` latency and errors from Lambda IPs.
- Bridge URL must reach `/api/ingest` on the API host.
- Realtime has priority over archive catch-up. Keep `citypulse-backfill` stopped unless you are intentionally running backfill:
  `systemctl disable --now citypulse-backfill`.
- `scripts/deploy_lambda_backfill.sh` leaves archive backfill stopped by default; use `START_BACKFILL=1` only during supervised catch-up windows.

### Stale feed triage

- If all cities share the same `newest_extraction_at`, check Lambda live logs first:
  `tail -f /var/log/pulse-live.log`.
- `EOF, reconnecting...` on most feeds plus `queue=0` usually means Broadcastify live streams are not delivering audio. Stop archive backfill, restart `pulse-live@sf pulse-live@nyc pulse-live@philly pulse-live@chattanooga`, then re-check `/api/city-stats/{slug}`.
- `Bridge POST error: The read operation timed out` means the public ingest request exceeded `BRIDGE_POST_TIMEOUT_SEC`; raise that env var or reduce live-path geocode/LLM retry work before starting backfill.

## Freshness checks

- `python scripts/pulse_live_health.py --city philly --city nyc`
- `GET /api/city-stats/{slug}` exposes `newest_incident_at`, `newest_extraction_at`, and `promotion_rate_6h`.

## Promotion failures

- `python scripts/analyze_dropped_extractions.py --city philly` prints candidate tokens for `cities/<slug>/location_lexicon.yaml`.
- Re-geocode recent drops: `python scripts/resurrect_dropped_extractions.py` (dry-run first).

## NYC NYPD limits

NYPD precinct dispatch is largely encrypted on Broadcastify; FDNY borough feeds remain the primary NYC source. See `cities/nyc/config.yaml` feed notes.
