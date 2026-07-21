#!/usr/bin/env python3
"""Soft-hide incidents that are stacked on a single city-centroid pin.

Background: even after we removed the explicit "LLM-fallback to city
center" coord behavior, incidents kept piling up at one or two points
per city. Diagnosis (see the inline cluster report from
`shouldRenderIncident`-aware queries) showed Nominatim was happily
resolving vague LLM `location_text` values like "Philadelphia, PA",
"highway", "Walmart, Chattanooga, TN", or "downtown" to the city
centroid (or one arbitrary POI), then dedup grouped the unrelated
incidents under one pin.

The geocoder fix in `philly_pulse/geocode.py` (rejecting vague text
and Nominatim hits whose `class`/`type` is city/POI/etc.) prevents
NEW incidents from doing this. This script repairs the EXISTING ones:

  1. For each city, find the top-N exact-coordinate clusters whose
     count is ≥ THRESHOLD (default 8).
  2. For every incident at those clusters, set
        hidden = true
        geocode_status = "hidden_city_center_cluster"
        repair_reason = "stacked_on_centroid"
        repaired_at = <iso>
     so the frontend's `shouldRenderIncident` filter drops them but
     the underlying data stays for forensics / future re-geocoding.

Dry-run by default. `--execute` to actually write.

Usage:
    python3 scripts/hide_city_center_clusters.py
    python3 scripts/hide_city_center_clusters.py --execute
    python3 scripts/hide_city_center_clusters.py --execute --threshold 5
    python3 scripts/hide_city_center_clusters.py --execute --city philly

Idempotent: an incident already marked `hidden=True` is skipped.
Requires GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON
in the environment.
"""

from __future__ import annotations

import argparse
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from google.cloud.firestore_v1.base_query import FieldFilter  # noqa: E402


def _get_db():
    from philly_pulse.firestore_store import _ensure_client
    return _ensure_client()


def _scan_clusters(db, city: str, *, sample_limit: int) -> tuple[Counter, dict]:
    """Return Counter[(round_lat, round_lng)] and a refs lookup.

    `refs` maps each cluster key to a list of (incident_id, ref) so the
    caller can update them without a second pass.
    """
    counts: Counter = Counter()
    refs: dict[tuple, list[tuple[str, object, dict]]] = defaultdict(list)

    q = (
        db.collection("incidents")
        .where(filter=FieldFilter("city", "==", city))
        .limit(sample_limit)
    )
    for snap in q.stream():
        d = snap.to_dict() or {}
        if d.get("hidden") is True:
            continue
        if d.get("inhibitor_status") == "blocked":
            continue
        gs = d.get("geocode_status", "") or ""
        if gs.startswith("llm_fallback"):
            # Already handled by repair_llm_fallback_incidents.py.
            continue
        lat, lng = d.get("lat"), d.get("lng")
        if lat is None or lng is None:
            continue
        # 5-decimal rounding ≈ 1.1m precision — basically "exact same pin".
        k = (round(float(lat), 5), round(float(lng), 5))
        counts[k] += 1
        refs[k].append((snap.id, snap.reference, d))

    return counts, refs


def _short_loc_examples(rows: list[tuple[str, object, dict]], n: int = 4) -> str:
    seen: list[str] = []
    for _, _, d in rows:
        lt = (d.get("location_text") or "").strip()
        if not lt:
            continue
        if lt not in seen:
            seen.append(lt)
        if len(seen) >= n:
            break
    return " | ".join(repr(s)[:60] for s in seen) or "(no location_text)"


def _run(args: argparse.Namespace) -> None:
    db = _get_db()

    cities: list[str]
    if args.city:
        cities = [args.city]
    else:
        # Discover cities by sampling /incidents.
        seen: Counter = Counter()
        for snap in db.collection("incidents").select(["city"]).limit(20000).stream():
            seen[(snap.to_dict() or {}).get("city", "(none)")] += 1
        cities = [c for c, _ in seen.most_common() if c and c != "(none)"]

    print(f"=== {'DRY-RUN' if args.dry_run else 'EXECUTE'} hide_city_center_clusters ===")
    print(f"Cities:        {cities}")
    print(f"Threshold:     ≥ {args.threshold} incidents stacked at one pin")
    print(f"Sample limit:  {args.sample_limit} per city")
    print(f"Per-city cap:  {args.max_clusters} cluster pins")
    print()

    started = time.time()
    grand_total_hidden = 0
    grand_total_clusters = 0

    for city in cities:
        print(f"--- {city} ---")
        counts, refs = _scan_clusters(db, city, sample_limit=args.sample_limit)

        big = [(k, n) for k, n in counts.most_common(args.max_clusters) if n >= args.threshold]
        if not big:
            print(f"  no clusters ≥ {args.threshold}")
            continue

        city_total = 0
        for (lat, lng), n in big:
            rows = refs[(lat, lng)]
            example = _short_loc_examples(rows)
            print(f"  {n:5d} at ({lat}, {lng})   examples: {example}")
            grand_total_clusters += 1

            if args.dry_run:
                city_total += len(rows)
                continue

            iso = datetime.now(timezone.utc).isoformat()
            payload = {
                "hidden": True,
                "geocode_status": "hidden_city_center_cluster",
                "repair_reason": "stacked_on_centroid",
                "repaired_at": iso,
            }
            # Batched writes (Firestore caps each batch at 500).
            from google.cloud import firestore as gcf  # type: ignore
            written = 0
            batch = db.batch()
            for inc_id, ref, _ in rows:
                batch.update(ref, payload)
                written += 1
                if written % 400 == 0:
                    batch.commit()
                    batch = db.batch()
            batch.commit()
            city_total += written

        print(f"  city subtotal: hid {city_total} incidents across {len(big)} clusters")
        grand_total_hidden += city_total

    print()
    print("=== Summary ===")
    print(f"Mode:               {'DRY-RUN' if args.dry_run else 'EXECUTED'}")
    print(f"Cities scanned:     {len(cities)}")
    print(f"Clusters acted on:  {grand_total_clusters}")
    print(f"Incidents hidden:   {grand_total_hidden}")
    print(f"Elapsed:            {time.time() - started:.1f}s")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--execute", action="store_true", help="Actually write (default: dry-run).")
    p.add_argument("--city", default=None, help="Single city slug.")
    p.add_argument("--threshold", type=int, default=8,
                   help="Minimum incidents stacked at the same lat/lng to count as a cluster (default 8).")
    p.add_argument("--max-clusters", type=int, default=10,
                   help="Top-N cluster pins per city to hide (default 10).")
    p.add_argument("--sample-limit", type=int, default=8000,
                   help="Max incidents to scan per city (default 8000).")
    args = p.parse_args()
    args.dry_run = not args.execute
    _run(args)


if __name__ == "__main__":
    main()
