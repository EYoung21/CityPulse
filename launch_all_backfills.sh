#!/bin/bash
# Launch 5-month backfill for all Pulse cities.
# Runs each city sequentially to avoid overwhelming Broadcastify.
#
# Usage:
#   ./launch_all_backfills.sh
#   ./launch_all_backfills.sh --days 90   # override day count

set -e

EXTRA_ARGS="$@"

CITIES=(
    "cities/sf/config.yaml"
    "cities/nyc/config.yaml"
    "cities/philly/config.yaml"
    "cities/chattanooga/config.yaml"
)

echo "========================================="
echo "  Pulse Network — Full Backfill"
echo "  Cities: ${#CITIES[@]}"
echo "========================================="
echo ""

FAILED=()

for config in "${CITIES[@]}"; do
    if [ ! -f "$config" ]; then
        echo "WARNING: $config not found, skipping"
        FAILED+=("$config")
        continue
    fi

    CITY_NAME=$(python3 -c "
import yaml
with open('$config') as f:
    cfg = yaml.safe_load(f)
print(cfg.get('city', {}).get('name', 'Unknown'))
")

    echo "=========================================>"
    echo "  Starting: ${CITY_NAME} ($config)"
    echo "=========================================>"
    echo ""

    ./launch_city_backfill.sh "$config" $EXTRA_ARGS || {
        echo "ERROR: ${CITY_NAME} backfill failed"
        FAILED+=("$config")
    }

    echo ""
    echo "  Cooling down before next city (60s)..."
    sleep 60
done

echo ""
echo "========================================="
echo "  Backfill Complete"
echo "========================================="

if [ ${#FAILED[@]} -gt 0 ]; then
    echo "  FAILED: ${FAILED[*]}"
else
    echo "  All ${#CITIES[@]} cities succeeded"
fi
