#!/bin/bash
# Setup multi-city live transcription + backfill on the Hetzner server.
# Run this once on the server: sudo ./scripts/setup-multi-city.sh
#
# Creates:
#   - pulse-live@{sf,nyc,philly,chattanooga}  — 4 realtime transcriber services
#   - pulse-backfill.timer                     — backfill cron (every 2h, rotates cities)

set -euo pipefail
cd "$(dirname "$0")/.."

CITIES=(sf nyc philly chattanooga memphis detroit orlando miami la lasvegas)

echo "=== Pulse Multi-City Setup ==="
echo ""

# 1. Install systemd unit files
echo "Installing systemd units..."
cp systemd/pulse-live@.service /etc/systemd/system/
cp systemd/pulse-backfill.service /etc/systemd/system/
cp systemd/pulse-backfill.timer /etc/systemd/system/
systemctl daemon-reload
echo "  ✓ Units installed"

# 2. Stop the old single-city transcriber if running
if systemctl is-active --quiet philly-pulse-live 2>/dev/null; then
    echo "Stopping old philly-pulse-live service..."
    systemctl stop philly-pulse-live
    systemctl disable philly-pulse-live 2>/dev/null || true
    echo "  ✓ Old single-city service stopped"
fi

# 3. Enable and start per-city live transcribers
echo ""
echo "Starting live transcribers..."
for city in "${CITIES[@]}"; do
    config="cities/$city/config.yaml"
    if [ ! -f "$config" ]; then
        echo "  ✗ SKIP $city — $config not found"
        continue
    fi
    systemctl enable "pulse-live@${city}" 2>/dev/null || true
    systemctl restart "pulse-live@${city}"
    sleep 2
    if systemctl is-active --quiet "pulse-live@${city}"; then
        echo "  ✓ $city — running"
    else
        echo "  ✗ $city — FAILED (check: journalctl -u pulse-live@${city})"
    fi
done

# 4. Enable and start backfill timer
echo ""
echo "Starting backfill timer..."
systemctl enable pulse-backfill.timer 2>/dev/null || true
systemctl start pulse-backfill.timer
echo "  ✓ Backfill timer active (every 2h)"
echo "  Next run: $(systemctl list-timers pulse-backfill.timer --no-pager | tail -2 | head -1 | awk '{print $1, $2}')"

# 5. Summary
echo ""
echo "=== Setup Complete ==="
echo ""
echo "Live transcribers:"
for city in "${CITIES[@]}"; do
    status=$(systemctl is-active "pulse-live@${city}" 2>/dev/null || echo "inactive")
    echo "  pulse-live@${city}: ${status}"
done
echo ""
echo "Backfill:"
echo "  pulse-backfill.timer: $(systemctl is-active pulse-backfill.timer 2>/dev/null || echo 'inactive')"
echo ""
echo "Useful commands:"
echo "  journalctl -fu pulse-live@sf          # follow SF transcriber logs"
echo "  journalctl -fu pulse-live@philly      # follow Philly transcriber logs"
echo "  systemctl status pulse-live@nyc       # check NYC status"
echo "  systemctl start pulse-backfill        # trigger backfill now"
echo "  systemctl list-timers pulse-backfill* # check backfill schedule"
