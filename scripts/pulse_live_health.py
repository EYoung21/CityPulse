#!/usr/bin/env python3
"""Compare extraction vs promoted-incident freshness per city (ops health)."""

from __future__ import annotations

import argparse
import os
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from philly_pulse import city_registry, persistence as store


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def _age_minutes(value: str | None) -> float | None:
    dt = _parse_iso(value)
    if not dt:
        return None
    return (datetime.now(timezone.utc) - dt).total_seconds() / 60.0


def city_report(slug: str, hours: int) -> dict:
    freshness = store.get_city_pipeline_freshness(slug, hours=hours)
    return {
        "slug": slug,
        "hours": hours,
        "newest_extraction_at": freshness.get("newest_extraction_at"),
        "newest_incident_at": freshness.get("newest_incident_at"),
        "extraction_age_min": _age_minutes(freshness.get("newest_extraction_at")),
        "incident_age_min": _age_minutes(freshness.get("newest_incident_at")),
        "llm_relevant": freshness.get("llm_relevant_6h", 0),
        "promoted": freshness.get("promoted_6h", 0),
        "promotion_rate": freshness.get("promotion_rate_6h"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Pulse live pipeline health")
    parser.add_argument("--city", action="append", help="City slug (repeatable)")
    parser.add_argument("--hours", type=int, default=6)
    args = parser.parse_args()

    if not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") and not os.environ.get(
        "FIREBASE_SERVICE_ACCOUNT_JSON"
    ):
        print("Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON", file=sys.stderr)
        return 2

    city_registry.load_city_registry()
    slugs = args.city or sorted(city_registry.CITY_REGISTRY.keys())
    for slug in slugs:
        row = city_report(slug, args.hours)
        print(
            f"{slug}: extraction_age={row['extraction_age_min']:.1f}m "
            f"incident_age={row['incident_age_min']:.1f}m "
            f"promotion={row['promoted']}/{row['llm_relevant']} "
            f"rate={row['promotion_rate']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
