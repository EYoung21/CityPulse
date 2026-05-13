# Ingest operations

## Live transcribers

- `systemctl status pulse-live@philly` (and `@nyc`, etc.)
- Tail logs on the Lambda host for bridge POST failures and Whisper queue depth.
- Bridge URL must reach `/api/ingest` on the API host.

## Freshness checks

- `python scripts/pulse_live_health.py --city philly --city nyc`
- `GET /api/city-stats/{slug}` exposes `newest_incident_at`, `newest_extraction_at`, and `promotion_rate_6h`.

## Promotion failures

- `python scripts/analyze_dropped_extractions.py --city philly` prints candidate tokens for `cities/<slug>/location_lexicon.yaml`.
- Re-geocode recent drops: `python scripts/resurrect_dropped_extractions.py` (dry-run first).

## NYC NYPD limits

NYPD precinct dispatch is largely encrypted on Broadcastify; FDNY borough feeds remain the primary NYC source. See `cities/nyc/config.yaml` feed notes.
