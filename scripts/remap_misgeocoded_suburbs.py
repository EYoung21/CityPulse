#!/usr/bin/env python3
"""Remap incidents that the old geocoder force-suffixed into Philadelphia.

Background: until commit 867b113 the Philly LLM context told the model
to append ", Philadelphia, PA" to every extracted address, even on
transcripts coming from Delaware Co Police, Chester Co LE, or MontCo
dispatch. Nominatim then either:

  (a) returned no_result — fixed by scripts/resurrect_dropped_extractions.py
  (b) returned a fuzzy match in Philly proper that happened to share the
      street name → the incident was geocoded "successfully" but to the
      WRONG city.

This script handles case (b). It walks `incidents` where:
  - city = philly
  - feed_id is one of the suburban dispatches we subscribe to
  - geocode_status starts with success_*
  - lat/lng landed inside the old narrow Philly bbox (lng_min: -75.30)
  - location_text ends with ", Philadelphia, PA"

For each, it:
  1. Strips ", Philadelphia, PA" from location_text.
  2. Re-geocodes with the correct county suffix for the feed_id
     (DelCo Fire/Police → Delaware County, ChesCo LE → Chester County,
      MontCo Fire/Police → Montgomery County). The county hint
     disambiguates streets like "Chester Avenue" that exist in both
     Philly AND Chester PA.
  3. If the new coords are meaningfully different (>1km from original)
     AND outside the old Philly bbox: update lat/lng + location_text +
     stamp `geocode_status="success_remapped_suburb"`.
  4. If the new coords are still inside Philly bbox OR no new result:
     soft-hide the incident with `geocode_status="hidden_suburb_misgeocode"`
     to keep wrong pins off the map. The data is preserved.

Idempotent: rows with `remap_attempted_at` are skipped unless --force.
Dry-run by default; --execute to write.
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

import yaml  # noqa: E402

from philly_pulse import geocode  # noqa: E402

FEED_TO_COUNTY: dict[str, str] = {
    "36323": "Delaware County",
    "46438": "Delaware County",
    "46435": "Delaware County",  # DelCo Fire East
    "46440": "Delaware County",  # DelCo PD Sector 7 (Haverford/Radnor)
    "46441": "Delaware County",  # DelCo PD Sector 6 (Swarthmore/Media)
    "46444": "Delaware County",  # DelCo PD Sector 3 (Upper Darby)
    "24104": "Chester County",
    "10489": "Montgomery County",
    "25767": "Montgomery County",
    "18335": "Montgomery County",  # MontCo Fire West / Police SW (Bryn Mawr)
}

PHILLY_BOX = dict(lat_min=39.85, lat_max=40.15, lng_min=-75.30, lng_max=-74.94)

# A few towns are technically inside the metro but right on the edge of
# Philly bbox; we don't want to false-positive them. Treat the inner
# Center City core as "definitely Philly", and accept anything outside
# the old narrow bbox as a successful remap.
def _in_box(lat: float, lng: float, b: dict) -> bool:
    return b["lat_min"] <= lat <= b["lat_max"] and b["lng_min"] <= lng <= b["lng_max"]


def _haversine_km(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    from math import radians, sin, cos, asin, sqrt
    r = 6371.0
    dlat = radians(b_lat - a_lat)
    dlng = radians(b_lng - a_lng)
    h = sin(dlat / 2) ** 2 + cos(radians(a_lat)) * cos(radians(b_lat)) * sin(dlng / 2) ** 2
    return 2 * r * asin(sqrt(h))


def _strip_philly_suffix(s: str) -> str:
    """Remove the LLM-appended Philadelphia tail without nuking content."""
    base = s.strip().rstrip(",.")
    suffixes = (
        ", Philadelphia, PA",
        ", philadelphia, PA",
        ", Philadelphia, pa",
        " Philadelphia, PA",
        ", PHILADELPHIA, PA",
    )
    for suf in suffixes:
        if base.endswith(suf):
            return base[: -len(suf)].rstrip(",. ")
    if base.lower().endswith("philadelphia, pa"):
        return base[: -len("philadelphia, pa")].rstrip(",. ")
    return base


def _load_metro_geo_ctx() -> dict:
    """Load the (now-metro-wide) Philly bounds/viewbox from cities/philly/config.yaml."""
    cfg_path = REPO_ROOT / "cities" / "philly" / "config.yaml"
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    geo = cfg.get("geocode", {}) or {}
    bounds_raw = geo.get("bounds", {})
    if isinstance(bounds_raw, str):
        parts = [float(x) for x in bounds_raw.split(",")]
        bounds = {"lng_min": parts[0], "lat_min": parts[1],
                  "lng_max": parts[2], "lat_max": parts[3]}
    else:
        bounds = bounds_raw
    return {
        "viewbox": geo.get("viewbox", ""),
        "bounds": bounds,
        # Suffix is dynamically replaced per-feed in _build_geo_ctx_for_feed
        "suffix": geo.get("suffix", ", PA"),
    }


def _build_geo_ctx_for_feed(feed_id: str, base_ctx: dict) -> dict:
    """Override suffix with the feed's known county."""
    county = FEED_TO_COUNTY.get(feed_id)
    if not county:
        return base_ctx
    ctx = dict(base_ctx)
    ctx["suffix"] = f", {county}, PA"
    return ctx


def _get_db():
    from philly_pulse.firestore_store import _ensure_client
    return _ensure_client()


def _load_suspects(*, limit: int | None, force: bool) -> list[tuple]:
    """Materialize suspect incidents up front; per-row LLM/geocode is slow
    enough that holding the Firestore stream open the whole time would
    blow past the gRPC deadline (we learned this on the cluster recovery
    pass)."""
    db = _get_db()
    rows: list[tuple] = []
    for snap in db.collection("incidents").where("city", "==", "philly").stream():
        d = snap.to_dict() or {}
        feed_id = d.get("feed_id") or ""
        if feed_id not in FEED_TO_COUNTY:
            continue
        if d.get("hidden"):
            continue
        gs = (d.get("geocode_status") or "")
        if not gs.startswith("success"):
            continue
        lat, lng = d.get("lat"), d.get("lng")
        if lat is None or lng is None:
            continue
        if not _in_box(float(lat), float(lng), PHILLY_BOX):
            continue
        loc = (d.get("location_text") or "")
        if not loc.lower().rstrip(",. ").endswith("philadelphia, pa"):
            continue
        if not force and d.get("remap_attempted_at"):
            continue
        rows.append((snap.id, snap.reference, d))
        if limit and len(rows) >= int(limit):
            break
    return rows


async def _remap_one(incident_id: str, ref, data: dict, base_ctx: dict, *, dry_run: bool) -> str:
    feed_id = data["feed_id"]
    old_loc = data["location_text"]
    old_lat = float(data["lat"])
    old_lng = float(data["lng"])

    stripped = _strip_philly_suffix(old_loc)
    if not stripped or len(stripped) < 3:
        if not dry_run:
            ref.update({
                "remap_attempted_at": datetime.now(timezone.utc).isoformat(),
                "remap_outcome": "stripped_too_short",
                "hidden": True,
                "geocode_status": "hidden_suburb_misgeocode",
            })
        return "stripped_too_short"

    ctx = _build_geo_ctx_for_feed(feed_id, base_ctx)
    coords = await geocode.geocode(stripped, geo_ctx=ctx)

    if not coords:
        if not dry_run:
            ref.update({
                "remap_attempted_at": datetime.now(timezone.utc).isoformat(),
                "remap_outcome": "no_geocode_after_strip",
                "hidden": True,
                "geocode_status": "hidden_suburb_misgeocode",
            })
        return "no_geocode_after_strip"

    new_lat, new_lng = coords
    moved_km = _haversine_km(old_lat, old_lng, new_lat, new_lng)

    # If the re-geocode still landed inside the old Philly bbox, we can't
    # tell if the new pin is correct or if Nominatim just kept hugging
    # Philly. Hide rather than risk a still-wrong pin.
    if _in_box(new_lat, new_lng, PHILLY_BOX):
        if not dry_run:
            ref.update({
                "remap_attempted_at": datetime.now(timezone.utc).isoformat(),
                "remap_outcome": "still_in_philly",
                "hidden": True,
                "geocode_status": "hidden_suburb_misgeocode",
            })
        return "still_in_philly"

    # Nominatim returned a different city outside Philly proper — much
    # higher confidence this is the right place.
    new_loc = stripped + ctx["suffix"]
    if not dry_run:
        ref.update({
            "lat": new_lat,
            "lng": new_lng,
            "location_text": new_loc,
            "geocode_status": "success_remapped_suburb",
            "remap_attempted_at": datetime.now(timezone.utc).isoformat(),
            "remap_outcome": "remapped",
            "remap_distance_km": round(moved_km, 2),
        })
    print(
        f"  [{incident_id}] feed={feed_id} REMAPPED → "
        f"{new_loc!r} ({old_lat:.4f},{old_lng:.4f}) → ({new_lat:.4f},{new_lng:.4f}) "
        f"moved {moved_km:.1f}km",
        flush=True,
    )
    return "remapped"


async def _run(args: argparse.Namespace) -> None:
    base_ctx = _load_metro_geo_ctx()
    print(f"Metro bounds: {base_ctx['bounds']}")
    print(f"Default suffix: {base_ctx['suffix']!r}")
    print(f"Per-feed county overrides: {FEED_TO_COUNTY}")
    print()

    print("[INFO] Loading suspect incidents from Firestore...", flush=True)
    rows = _load_suspects(limit=args.limit, force=args.force)
    print(f"[INFO] Loaded {len(rows)} suspect incidents", flush=True)
    if not rows:
        return

    counts: Counter = Counter()
    started = time.time()
    for i, (iid, ref, data) in enumerate(rows, start=1):
        outcome = await _remap_one(iid, ref, data, base_ctx, dry_run=args.dry_run)
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
        # Nominatim policy: 1 req/s.
        await asyncio.sleep(args.sleep)

    print()
    print(f"=== Remap run complete ({'DRY-RUN' if args.dry_run else 'EXECUTED'}) ===")
    print(f"Processed: {len(rows)}")
    for outcome, n in counts.most_common():
        print(f"  {outcome:25s} {n}")
    print(f"Elapsed: {time.time() - started:.0f}s")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--execute", action="store_true",
                   help="Actually write updates (default: dry-run).")
    p.add_argument("--limit", type=int, default=None,
                   help="Cap on incidents to process.")
    p.add_argument("--sleep", type=float, default=1.1,
                   help="Seconds between Nominatim calls (Nominatim policy is 1 req/s).")
    p.add_argument("--force", action="store_true",
                   help="Re-attempt rows already stamped with remap_attempted_at.")
    args = p.parse_args()
    args.dry_run = not args.execute
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
