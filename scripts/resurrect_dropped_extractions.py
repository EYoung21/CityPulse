#!/usr/bin/env python3
"""Resurrect extractions that were dropped at geocode due to overly-tight bounds.

Background: cities/philly/config.yaml originally bounded the geocoder
to Philadelphia city proper (lng_min: -75.30). Every transcript from
the suburban scanner feeds we're subscribed to (Delaware Co Police
Dispatch, Chester Co LE, MontCo Region 3, etc.) that produced a real
address west of Center City was geocoded successfully by Nominatim
but then rejected as out-of-bounds — so no incident row was ever
created. The transcript + extracted location_text survived in the
`extractions` collection with `geocode_status="no_result_*"` but the
incident itself was lost.

This script walks `extractions` for rows that:
  - Have a non-empty `llm_location_text`
  - Were marked llm_relevant=True
  - Have geocode_status starting with "no_result"
  - Have no `incident_id` set (we never made an incident for them)

For each, re-runs the new (wider-bounds) geocoder. On success, calls
`store.insert_incident` with the recovered coords, then back-stamps
the source extraction with the new incident_id and a
"success_resurrected_<conf>" geocode_status so we don't process it
twice on a future run.

Dry-run by default. `--execute` to actually create incidents.

Usage:
    python3 scripts/resurrect_dropped_extractions.py --hours 168
    python3 scripts/resurrect_dropped_extractions.py --hours 720 --execute
    python3 scripts/resurrect_dropped_extractions.py --hours 168 --execute --city philly --limit 200

Requires:
  - GOOGLE_APPLICATION_CREDENTIALS pointing at the service account
  - Network access to Nominatim (no LLM call needed — we trust the
    LLM's original location_text and just re-geocode it).
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from collections import Counter
from datetime import datetime, timezone, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

import yaml  # noqa: E402

from philly_pulse import geocode  # noqa: E402
from philly_pulse import persistence as store  # noqa: E402

CITY_REGISTRY: dict[str, dict] = {}


def _load_city_registry() -> None:
    """Mirror server.py's per-city geocode/LLM context loader.

    We re-read these from disk so the script picks up live config edits
    (e.g. the wider Philly metro bounds) without needing to be deployed
    to Hetzner first.
    """
    cities_dir = REPO_ROOT / "cities"
    if not cities_dir.is_dir():
        return
    for cfg_dir in sorted(cities_dir.iterdir()):
        cfg_path = cfg_dir / "config.yaml"
        if not cfg_path.exists():
            continue
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = yaml.safe_load(f) or {}
            slug = cfg.get("city", {}).get("slug") or cfg_dir.name
            city_name = cfg.get("city", {}).get("name", slug)
            geo = cfg.get("geocode", {})

            bounds_raw = geo.get("bounds", {})
            if isinstance(bounds_raw, str):
                parts = [float(x) for x in bounds_raw.split(",")]
                bounds = {
                    "lng_min": parts[0], "lat_min": parts[1],
                    "lng_max": parts[2], "lat_max": parts[3],
                }
            elif isinstance(bounds_raw, dict):
                bounds = bounds_raw
            else:
                bounds = {"lat_min": -90, "lat_max": 90, "lng_min": -180, "lng_max": 180}

            CITY_REGISTRY[slug] = {
                "city_name": city_name,
                "geocode_suffix": geo.get("suffix", f", {city_name}"),
                "bounds": bounds,
                "viewbox": geo.get("viewbox", ""),
            }
        except Exception as e:
            print(f"[WARN] failed to load {cfg_path}: {e}", file=sys.stderr)


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


def _get_db():
    from philly_pulse.firestore_store import _ensure_client
    return _ensure_client()


def _load_dropped_extractions(
    *,
    city: str | None,
    since_iso: str,
    limit: int | None,
    window_hours: int = 6,
) -> list[tuple]:
    """Return (extraction_id, ref, data) for rows we should re-geocode.

    We page the time range in `window_hours` chunks because the Firestore
    server-side stream times out on long ranges (~100k+ docs/week). Each
    chunk is materialized into memory in a single `.get()` call, which
    is bounded by Firestore's 60s deadline rather than dripping rows
    over many minutes.
    """
    from google.api_core.exceptions import DeadlineExceeded
    db = _get_db()

    since_dt = datetime.fromisoformat(since_iso)
    end_dt = datetime.now(timezone.utc)
    rows: list[tuple] = []
    scanned = 0

    cur = since_dt
    while cur < end_dt:
        nxt = min(cur + timedelta(hours=window_hours), end_dt)
        cur_iso = cur.isoformat()
        nxt_iso = nxt.isoformat()
        try:
            q = (
                db.collection("extractions")
                .where("reported_at", ">=", cur_iso)
                .where("reported_at", "<", nxt_iso)
            )
            chunk = list(q.get())  # snapshot read; bounded by single-RPC deadline
        except DeadlineExceeded:
            print(f"[WARN] window {cur_iso} → {nxt_iso} timed out; halving", flush=True)
            window_hours = max(1, window_hours // 2)
            continue

        for snap in chunk:
            scanned += 1
            d = snap.to_dict() or {}
            if city and d.get("city") != city:
                continue
            if d.get("incident_id"):
                continue
            if d.get("llm_relevant") is not True:
                continue
            gs = (d.get("geocode_status") or "")
            if not gs.startswith("no_result"):
                continue
            if not (d.get("llm_location_text") or "").strip():
                continue
            if d.get("inhibitor_status") == "blocked":
                continue
            if d.get("resurrect_attempted_at"):
                continue
            rows.append((snap.id, snap.reference, d))
            if limit and len(rows) >= int(limit):
                print(
                    f"[INFO] hit limit={limit} after scanning {scanned} extractions",
                    flush=True,
                )
                return rows

        print(
            f"[INFO] window {cur_iso[:19]} → {nxt_iso[:19]}: "
            f"{len(chunk)} docs, total queued so far: {len(rows)}",
            flush=True,
        )
        cur = nxt

    print(f"[INFO] scanned {scanned} extractions, queued {len(rows)} for re-geocode", flush=True)
    return rows


async def _resurrect_one(
    extraction_id: str,
    ext_ref,
    data: dict,
    *,
    dry_run: bool,
) -> str:
    city = data.get("city")
    location_text = (data.get("llm_location_text") or "").strip()
    raw_text = data.get("raw_text") or ""
    feed_id = data.get("feed_id") or ""
    reported_at = data.get("reported_at") or datetime.now(timezone.utc).isoformat()
    category = data.get("llm_category") or "admin_or_noise"
    confidence = float(data.get("llm_confidence") or 0.5)
    location_confidence = data.get("location_confidence") or "none"

    coords = await geocode.geocode(location_text, geo_ctx=_geo_ctx(city))
    if not coords:
        if not dry_run:
            ext_ref.update({
                "resurrect_attempted_at": datetime.now(timezone.utc).isoformat(),
                "resurrect_outcome": "still_no_geocode",
            })
        return "still_no_geocode"

    lat, lng = coords

    if dry_run:
        print(
            f"  [{extraction_id}] would resurrect: "
            f"{location_text!r} → ({lat:.5f}, {lng:.5f}) feed={feed_id} city={city}",
            flush=True,
        )
        return "would_resurrect"

    # Pull severity weight from the extraction's category. We import lazily
    # because philly_pulse.weights pulls FastAPI deps that aren't needed
    # for the dry-run path.
    from philly_pulse import weights
    s_base = weights.get_s_base(category)

    incident = store.insert_incident(
        raw_text=raw_text,
        severity_category=category,
        s_base=s_base,
        confidence=confidence,
        location_text=location_text,
        lat=lat,
        lng=lng,
        geocode_status=f"success_resurrected_{location_confidence}",
        location_confidence=location_confidence,
        inhibitor_status=data.get("inhibitor_status") or "passed",
        inhibitor_reason=data.get("inhibitor_reason"),
        reported_at=reported_at,
        audio_clip=data.get("audio_clip"),
        feed_id=feed_id,
        description=None,
        word_timings=None,
        city=city,
    )

    incident_id = incident["id"]
    ext_ref.update({
        "incident_id": incident_id,
        "geocode_status": f"success_resurrected_{location_confidence}",
        "resurrect_attempted_at": datetime.now(timezone.utc).isoformat(),
        "resurrect_outcome": "resurrected",
    })

    print(
        f"  [{extraction_id}] RESURRECTED → incident {incident_id} "
        f"@ ({lat:.5f}, {lng:.5f})  loc={location_text!r}  feed={feed_id}",
        flush=True,
    )
    return "resurrected"


async def _run(args: argparse.Namespace) -> None:
    _load_city_registry()
    if not CITY_REGISTRY:
        print("[FATAL] No cities loaded from cities/*/config.yaml", file=sys.stderr)
        sys.exit(2)

    since_iso = (datetime.now(timezone.utc) - timedelta(hours=args.hours)).isoformat()
    print(f"=== {'DRY-RUN' if args.dry_run else 'EXECUTE'} resurrect_dropped_extractions ===")
    print(f"City filter:   {args.city or '(all)'}")
    print(f"Since:         {since_iso}  ({args.hours}h ago)")
    print(f"Limit:         {args.limit or '(none)'}")
    print()

    rows = _load_dropped_extractions(city=args.city, since_iso=since_iso, limit=args.limit)
    counts: Counter = Counter()
    started = time.time()

    for i, (eid, ref, data) in enumerate(rows, start=1):
        outcome = await _resurrect_one(eid, ref, data, dry_run=args.dry_run)
        counts[outcome] += 1
        if i % 25 == 0:
            elapsed = time.time() - started
            rate = i / max(elapsed, 1)
            eta = (len(rows) - i) / max(rate, 0.001)
            print(
                f"  ... {i}/{len(rows)} processed in {elapsed:.0f}s "
                f"({rate:.2f}/s, ETA {eta/60:.1f}min) counts: {dict(counts)}",
                flush=True,
            )
        # Nominatim usage policy: 1 req/sec absolute max.
        await asyncio.sleep(args.sleep)

    print()
    print("=== Resurrection run complete ===")
    print(f"Mode:       {'DRY-RUN' if args.dry_run else 'EXECUTED'}")
    print(f"Processed:  {len(rows)}")
    for outcome, n in counts.most_common():
        print(f"  {outcome:20s}  {n}")
    print(f"Elapsed:    {time.time() - started:.0f}s")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--execute", action="store_true",
                   help="Actually create incidents (default: dry-run).")
    p.add_argument("--city", default=None,
                   help="Restrict to a single city slug (e.g. philly).")
    p.add_argument("--hours", type=int, default=168,
                   help="Look back this many hours (default 168 = 1 week).")
    p.add_argument("--limit", type=int, default=None,
                   help="Cap on extractions to process.")
    p.add_argument("--sleep", type=float, default=1.1,
                   help="Seconds between Nominatim calls (Nominatim policy is 1 req/s).")
    args = p.parse_args()
    args.dry_run = not args.execute
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
