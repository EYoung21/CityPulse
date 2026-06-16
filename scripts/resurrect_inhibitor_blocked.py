#!/usr/bin/env python3
"""Re-evaluate inhibitor-blocked incidents and publish those that now pass.

The local PII guardrail (`philly_pulse/inhibitor.py`) had high false-positive
rates on dispatch radio artifacts (911 location codes, "cardiac" → "card",
unit-number phone patterns). Those incidents were stored with
`inhibitor_status='blocked'`, `geocode_status='pending'`, and no coordinates.

This script re-runs the fixed guardrail on blocked rows. When an incident
passes, it geocodes the stored `location_text` and promotes the row to a
normal published incident (`inhibitor_status='passed'`, coords written).

Dry-run by default. `--execute` to write.

Usage:
    python3 scripts/resurrect_inhibitor_blocked.py
    python3 scripts/resurrect_inhibitor_blocked.py --execute
    python3 scripts/resurrect_inhibitor_blocked.py --execute --city chattanooga --limit 100

Requires:
  - GOOGLE_APPLICATION_CREDENTIALS pointing at the service account
  - Network access to Nominatim (no LLM call — uses stored location_text).
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from philly_pulse import geocode, ingest_location, inhibitor  # noqa: E402
from philly_pulse.city_registry import CITY_REGISTRY, FEED_META, load_city_registry  # noqa: E402


def _get_db():
    from philly_pulse.firestore_store import _ensure_client
    return _ensure_client()


def _geo_ctx(city: str | None) -> dict | None:
    if not city:
        return None
    entry = CITY_REGISTRY.get(city)
    if not entry:
        return None
    return {
        "viewbox": entry["viewbox"],
        "bounds": entry["bounds"],
        "suffix": entry["geocode_suffix"],
    }


def _load_blocked(*, city: str | None, limit: int | None, force: bool) -> list[tuple]:
    db = _get_db()
    q = db.collection("incidents").where("inhibitor_status", "==", "blocked")
    if city:
        q = q.where("city", "==", city)

    rows: list[tuple] = []
    for snap in q.stream():
        data = snap.to_dict() or {}
        if not force and data.get("inhibitor_resurrect_attempted_at"):
            continue
        rows.append((snap.id, snap.reference, data))
        if limit and len(rows) >= int(limit):
            break
    return rows


async def _resurrect_one(incident_id: str, ref, data: dict, *, dry_run: bool) -> str:
    raw_text = data.get("raw_text") or ""
    category = data.get("severity_category") or "admin_or_noise"
    location_text = (data.get("location_text") or "").strip()
    confidence = float(data.get("confidence") or 0.0)
    city = data.get("city") or ""
    feed_id = str(data.get("feed_id") or "").strip()
    feed_meta = FEED_META.get(feed_id, {})
    location_confidence = data.get("location_confidence") or "none"

    result = await inhibitor.check_incident(
        raw_text, category, location_text or None, confidence
    )
    if result.status == "blocked":
        if not dry_run:
            ref.update({
                "inhibitor_resurrect_attempted_at": datetime.now(timezone.utc).isoformat(),
                "inhibitor_resurrect_outcome": "still_blocked",
                "inhibitor_resurrect_reason": result.reason,
            })
        return "still_blocked"

    if not location_text:
        if not dry_run:
            ref.update({
                "inhibitor_resurrect_attempted_at": datetime.now(timezone.utc).isoformat(),
                "inhibitor_resurrect_outcome": "no_location_text",
            })
        return "no_location_text"

    location_result = await ingest_location.resolve_validated_location(
        raw_text=raw_text,
        location_text=location_text,
        location_confidence=location_confidence,
        city=city,
        geo_ctx=_geo_ctx(city),
        feed_meta=feed_meta,
    )
    if location_result.lat is None or location_result.lng is None:
        if not dry_run:
            ref.update({
                "inhibitor_resurrect_attempted_at": datetime.now(timezone.utc).isoformat(),
                "inhibitor_resurrect_outcome": "geocode_failed",
                "geocode_status": location_result.geocode_status,
            })
        return "geocode_failed"

    payload = {
        "inhibitor_status": "passed",
        "inhibitor_reason": None,
        "lat": location_result.lat,
        "lng": location_result.lng,
        "location_text": location_result.location_text or location_text,
        "geocode_status": f"success_resurrected_{location_result.geocode_status}",
        "hidden": False,
        "inhibitor_resurrect_attempted_at": datetime.now(timezone.utc).isoformat(),
        "inhibitor_resurrect_outcome": "published",
        "inhibitor_resurrect_from_reason": data.get("inhibitor_reason"),
    }
    if not dry_run:
        ref.update(payload)
    print(
        f"  [{incident_id}] RESURRECTED {data.get('inhibitor_reason')!r} → "
        f"{payload['location_text']!r} @ ({location_result.lat:.5f}, {location_result.lng:.5f})",
        flush=True,
    )
    return "published"


async def _run(args: argparse.Namespace) -> None:
    load_city_registry()
    counts: Counter = Counter()
    started = time.time()

    print("[INFO] loading inhibitor-blocked incidents...", flush=True)
    rows = _load_blocked(city=args.city, limit=args.limit, force=args.force)
    print(f"[INFO] loaded {len(rows)} blocked incidents", flush=True)

    for incident_id, ref, data in rows:
        outcome = await _resurrect_one(incident_id, ref, data, dry_run=args.dry_run)
        counts[outcome] += 1
        await asyncio.sleep(args.sleep)

    print()
    print("=== Inhibitor resurrection complete ===")
    print(f"Mode:       {'DRY-RUN' if args.dry_run else 'EXECUTED'}")
    print(f"City:       {args.city or '(all)'}")
    print(f"Processed:  {len(rows)}")
    for outcome, n in counts.most_common():
        print(f"  {outcome:25s}  {n}")
    print(f"Elapsed:    {time.time() - started:.0f}s")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--execute", action="store_true",
                   help="Actually write updates (default: dry-run).")
    p.add_argument("--city", default=None,
                   help="Restrict to a single city slug (e.g. philly).")
    p.add_argument("--limit", type=int, default=None,
                   help="Cap on number of incidents to process.")
    p.add_argument("--sleep", type=float, default=0.2,
                   help="Seconds between incidents (Nominatim pacing).")
    p.add_argument("--force", action="store_true",
                   help="Re-attempt rows already stamped with inhibitor_resurrect_attempted_at.")
    args = p.parse_args()
    args.dry_run = not args.execute

    if args.dry_run:
        print("[DRY-RUN] Pass --execute to write Firestore updates.\n", flush=True)

    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
