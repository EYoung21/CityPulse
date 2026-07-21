#!/usr/bin/env python3
"""Summarize extraction → map funnel from Firestore (ops / data QA).

Examples::

    GOOGLE_APPLICATION_CREDENTIALS=.../firebase-service-account.json \\
      python3 scripts/extraction_funnel_report.py --city nyc --days 14

Counts rows in the window with ``llm_relevant is True`` and no ``incident_id``,
grouped by ``geocode_status`` and ``prefilter_status``. Also reports newest
``reported_at`` for (a) all extractions in the city and (b) extractions that
received an ``incident_id`` — useful to compare against ``/api/city-stats``.
"""

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

from philly_pulse.firestore_store import _ensure_client  # noqa: E402
from google.cloud.firestore_v1.base_query import FieldFilter  # noqa: E402


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--city", required=True, help="City slug, e.g. nyc")
    p.add_argument("--days", type=int, default=14)
    p.add_argument("--page-size", type=int, default=2000)
    return p.parse_args()


def _iter_city_extractions(city: str, days: int, page_size: int):
    db = _ensure_client()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    base = (
        db.collection("extractions")
        .where(filter=FieldFilter("city", "==", city))
        .where(filter=FieldFilter("reported_at", ">=", cutoff))
        .order_by("reported_at")
        .limit(page_size)
    )
    last = None
    while True:
        q = base if last is None else base.start_after(last)
        page = list(q.stream())
        if not page:
            return
        for snap in page:
            d = snap.to_dict() or {}
            d["_id"] = snap.id
            yield d
        last = page[-1]
        if len(page) < page_size:
            return


def main() -> int:
    if not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") and not os.environ.get(
        "FIREBASE_SERVICE_ACCOUNT_JSON"
    ):
        print("Set GOOGLE_APPLICATION_CREDENTIALS (or FIREBASE_SERVICE_ACCOUNT_JSON).", file=sys.stderr)
        return 1

    args = _parse_args()
    city = args.city.strip().lower()

    newest_any: str | None = None
    newest_with_incident: str | None = None
    unpromoted_geo = Counter()
    unpromoted_pf = Counter()
    n_unpromoted_relevant = 0
    n_total = 0
    n_relevant = 0
    n_with_incident = 0

    for row in _iter_city_extractions(city, args.days, args.page_size):
        n_total += 1
        ra = row.get("reported_at")
        if isinstance(ra, str) and (newest_any is None or ra > newest_any):
            newest_any = ra
        if row.get("llm_relevant") is True:
            n_relevant += 1
        iid = row.get("incident_id")
        if iid:
            n_with_incident += 1
            if isinstance(ra, str) and (newest_with_incident is None or ra > newest_with_incident):
                newest_with_incident = ra

        if row.get("llm_relevant") is not True:
            continue
        if iid:
            continue
        n_unpromoted_relevant += 1
        gs = str(row.get("geocode_status") or "(missing)")
        unpromoted_geo[gs] += 1
        pf = str(row.get("prefilter_status") or "(missing)")
        unpromoted_pf[pf] += 1

    print(f"=== extraction funnel  city={city}  last {args.days} days ===")
    print(f"total_extractions: {n_total:,}")
    print(f"llm_relevant: {n_relevant:,}")
    print(f"with_incident_id: {n_with_incident:,}")
    print(f"newest reported_at (any): {newest_any}")
    print(f"newest reported_at (with incident_id): {newest_with_incident}")
    print()
    print(f"llm_relevant but no incident_id: {n_unpromoted_relevant:,}")
    print("geocode_status (unpromoted llm_relevant):")
    for k, v in unpromoted_geo.most_common(30):
        print(f"  {k!r}: {v:,}")
    print("prefilter_status (same subset):")
    for k, v in unpromoted_pf.most_common(20):
        print(f"  {k!r}: {v:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
