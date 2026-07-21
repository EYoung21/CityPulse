#!/usr/bin/env python3
"""Export recent extractions with poor geocode outcomes for manual lexicon tuning.

Reads Firestore ``extractions`` for one city, filters by ``geocode_status`` in a
configurable set (default: no_result_context, failed, no_result_direct), and
writes JSONL lines with ``raw_text``, ``llm_location_text``, ``geocode_status``,
``reported_at``, ``id``.

Example::

    GOOGLE_APPLICATION_CREDENTIALS=.../firebase-service-account.json \\
      python3 scripts/export_geocode_failures.py --city nyc --days 30 --limit 400 \\
      --out /tmp/nyc_geocode_failures.jsonl
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

from philly_pulse.firestore_store import _ensure_client  # noqa: E402
from google.cloud import firestore  # noqa: E402
from google.cloud.firestore_v1.base_query import FieldFilter  # noqa: E402


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--city", required=True)
    p.add_argument("--days", type=int, default=14)
    p.add_argument("--limit", type=int, default=300)
    p.add_argument(
        "--statuses",
        default="no_result_context,failed,no_result_direct",
        help="Comma-separated geocode_status values to include.",
    )
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--page-size", type=int, default=500)
    return p.parse_args()


def _iter_city(city: str, days: int, page_size: int):
    db = _ensure_client()
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    base = (
        db.collection("extractions")
        .where(filter=FieldFilter("city", "==", city))
        .where(filter=FieldFilter("reported_at", ">=", cutoff))
        .order_by("reported_at", direction=firestore.Query.DESCENDING)
        .limit(page_size)
    )
    last = None
    while True:
        q = base if last is None else base.start_after(last)
        page = list(q.stream())
        if not page:
            return
        for snap in page:
            yield snap.id, snap.to_dict() or {}
        last = page[-1]
        if len(page) < page_size:
            return


def main() -> int:
    if not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS") and not os.environ.get(
        "FIREBASE_SERVICE_ACCOUNT_JSON"
    ):
        print("Set GOOGLE_APPLICATION_CREDENTIALS.", file=sys.stderr)
        return 1

    args = _parse_args()
    city = args.city.strip().lower()
    want = {s.strip() for s in args.statuses.split(",") if s.strip()}

    args.out.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with args.out.open("w", encoding="utf-8") as fp:
        for eid, row in _iter_city(city, args.days, args.page_size):
            if n >= args.limit:
                break
            gs = str(row.get("geocode_status") or "")
            if gs not in want:
                continue
            if row.get("llm_relevant") is not True:
                continue
            rec = {
                "id": eid,
                "city": city,
                "reported_at": row.get("reported_at"),
                "geocode_status": gs,
                "llm_location_text": row.get("llm_location_text"),
                "location_confidence": row.get("location_confidence"),
                "raw_text": (row.get("raw_text") or "")[:2000],
            }
            fp.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n += 1

    print(f"Wrote {n} rows to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
