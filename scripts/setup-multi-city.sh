#!/bin/bash
# Setup multi-city live transcription on the Hetzner server.
# Run this once on the server: sudo ./scripts/setup-multi-city.sh
#
# Creates:
#   - pulse-live@{sf,nyc,philly,chattanooga}  - 4 realtime transcriber services
#
# Backfill no longer runs on Hetzner. It runs exclusively on Lambda; see
# scripts/install_lambda_backfill.sh and scripts/deploy_lambda_backfill.sh.
# Any leftover pulse-backfill.{service,timer} from older deploys is
# disabled below.

set -euo pipefail
cd "$(dirname "$0")/.."

# Allowlist: only these cities get a live transcriber. The 6 announced
# "coming soon" cities (memphis, detroit, orlando, miami, la, lasvegas)
# stay in the registry / UI but are NOT collected here.
ACTIVE_CITIES=(sf nyc philly chattanooga)
INACTIVE_CITIES=(memphis detroit orlando miami la lasvegas)
CITIES=("${ACTIVE_CITIES[@]}")

echo "=== Pulse Multi-City Setup ==="
echo ""

# 1. Install systemd unit files
echo "Installing systemd units..."
cp systemd/pulse-live@.service /etc/systemd/system/
systemctl daemon-reload
echo "  units installed"

# 2. Disable any legacy units we no longer want here
for legacy in philly-pulse-live pulse-backfill.service pulse-backfill.timer; do
    if systemctl list-unit-files "$legacy" >/dev/null 2>&1; then
        echo "Disabling legacy unit: $legacy"
        systemctl stop "$legacy" 2>/dev/null || true
        systemctl disable "$legacy" 2>/dev/null || true
        rm -f "/etc/systemd/system/${legacy}"
    fi
done

# 3. Disable + stop pulse-live@<city> for any city NOT on the allowlist
echo ""
echo "Stopping live transcribers for inactive cities..."
for city in "${INACTIVE_CITIES[@]}"; do
    if systemctl is-enabled --quiet "pulse-live@${city}" 2>/dev/null \
        || systemctl is-active --quiet "pulse-live@${city}" 2>/dev/null; then
        systemctl stop "pulse-live@${city}" 2>/dev/null || true
        systemctl disable "pulse-live@${city}" 2>/dev/null || true
        echo "  stopped: pulse-live@${city}"
    else
        echo "  skip:    pulse-live@${city} (not present)"
    fi
done

# 4. Enable and start per-city live transcribers for the allowlist
echo ""
echo "Starting live transcribers..."
for city in "${ACTIVE_CITIES[@]}"; do
    config="cities/$city/config.yaml"
    if [ ! -f "$config" ]; then
        echo "  SKIP $city: $config not found"
        continue
    fi
    systemctl enable "pulse-live@${city}" 2>/dev/null || true
    systemctl restart "pulse-live@${city}"
    sleep 2
    if systemctl is-active --quiet "pulse-live@${city}"; then
        echo "  $city: running"
    else
        echo "  $city: FAILED (check: journalctl -u pulse-live@${city})"
    fi
done

systemctl daemon-reload

# 5. Summary
echo ""
echo "=== Setup Complete ==="
echo ""
echo "Live transcribers (active allowlist):"
for city in "${ACTIVE_CITIES[@]}"; do
    status=$(systemctl is-active "pulse-live@${city}" 2>/dev/null || echo "inactive")
    echo "  pulse-live@${city}: ${status}"
done
echo ""
echo "Live transcribers (must NOT be running):"
for city in "${INACTIVE_CITIES[@]}"; do
    status=$(systemctl is-active "pulse-live@${city}" 2>/dev/null || echo "inactive")
    echo "  pulse-live@${city}: ${status}"
done
echo ""
echo "Useful commands:"
echo "  journalctl -fu pulse-live@sf          # follow SF transcriber logs"
echo "  journalctl -fu pulse-live@philly      # follow Philly transcriber logs"
echo "  systemctl status pulse-live@nyc       # check NYC status"
