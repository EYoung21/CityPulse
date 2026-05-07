#!/usr/bin/env bash
# scripts/run_lambda_ingest_api.sh
#
# Run on Lambda only: minimal FastAPI ingest bound to loopback so
# backfill_archives.py can hit /api/ingest without transiting Hetzner.
# Expects /etc/citypulse-backfill.env (GOOGLE_APPLICATION_CREDENTIALS,
# PHILLY_PULSE_LLM_AUTO, LLM_*, etc.).

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/citypulse-backfill}"
# systemd passes EnvironmentFile=/etc/citypulse-backfill.env into this process;
# that file is often mode 640 (root-only), so do not `source` it here — it
# would fail for User=ubuntu. For a manual shell test: `sudo systemctl start citypulse-ingest-api`
# or `sudo -E $(grep -v '^#' /etc/citypulse-backfill.env | xargs -d '\n' printf 'export %q; ' 2>/dev/null) ...` (fragile).
if [[ -r /etc/citypulse-backfill.env ]]; then
    # shellcheck disable=SC1091
    source /etc/citypulse-backfill.env
fi
cd "$REPO_DIR"

PORT="${CITYPULSE_LOCAL_INGEST_PORT:-18080}"
exec "$REPO_DIR/.venv/bin/uvicorn" philly_pulse.server:app \
  --host 127.0.0.1 --port "$PORT" --workers 1 --log-level info
