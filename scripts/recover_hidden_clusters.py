#!/usr/bin/env python3
"""Recover incidents that were soft-hidden as city-center cluster pile-ups.

Companion to `scripts/hide_city_center_clusters.py`. That script set
`hidden=true` and `geocode_status="hidden_city_center_cluster"` on
~931 incidents whose original `location_text` was too vague (e.g.
"Philadelphia, PA", "highway", "Walmart, Chattanooga, TN") and so
Nominatim was returning the city centroid, stacking unrelated reports
at one pin.

This script gives those incidents a second chance:

  1. Pull adjacent transmissions on the same feed within ±60s of
     the incident's reported_at — exactly the prior+after radio
     context the live ingest path uses today.
  2. Re-run `llm.extract_incident()` with that context. The LLM
     gets a chance to inherit the location from a dispatcher's
     callout that immediately preceded or followed the cryptic
     follow-up that originally produced the vague text.
  3. Re-run the new (strict) `geocode.geocode()` on the resulting
     `location_text`. The new geocoder rejects city/POI/region hits
     and pre-rejects vague text, so a "success" here means we got
     a real street/intersection/address.
  4. On success: clear `hidden`, write new lat/lng, mark
     `geocode_status="success_recovered_<conf>"`.
     On failure: leave hidden, just stamp `repair_attempted_at` and
     `repair_outcome="recovery_failed"` so we don't keep retrying
     the same dead transmissions on every future run.

Idempotent: rows already stamped with `repair_attempted_at` are
skipped on subsequent runs unless `--force` is passed.

Dry-run by default. `--execute` to actually write.

Usage:
    python3 scripts/recover_hidden_clusters.py
    python3 scripts/recover_hidden_clusters.py --execute
    python3 scripts/recover_hidden_clusters.py --execute --city philly
    python3 scripts/recover_hidden_clusters.py --execute --limit 50

Requires:
  - GOOGLE_APPLICATION_CREDENTIALS pointing at the service account
  - LLM_BASE_URL / LLM_API_KEY / LLM_MODEL pointing at a working
    LLM endpoint (e.g. via `ssh -L 11435:localhost:11434 ubuntu@<lambda>`
    and the local .env values).
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

import yaml  # noqa: E402

from philly_pulse import geocode, llm  # noqa: E402

CITY_REGISTRY: dict[str, dict] = {}

_DEFAULT_BOUNDS = {"lat_min": 39.85, "lat_max": 40.15, "lng_min": -75.30, "lng_max": -74.94}


def _load_city_registry() -> None:
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
            map_cfg = cfg.get("map", {})

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
                bounds = _DEFAULT_BOUNDS

            center_lat = map_cfg.get("center_lat") or (bounds["lat_min"] + bounds["lat_max"]) / 2
            center_lng = map_cfg.get("center_lng") or (bounds["lng_min"] + bounds["lng_max"]) / 2

            CITY_REGISTRY[slug] = {
                "city_name": city_name,
                "geocode_suffix": geo.get("suffix", f", {city_name}"),
                "center_lat": center_lat,
                "center_lng": center_lng,
                "bounds": bounds,
                "viewbox": geo.get("viewbox", ""),
            }
        except Exception as e:
            print(f"[WARN] failed to load {cfg_path}: {e}", file=sys.stderr)


def _llm_ctx(city: str | None) -> dict | None:
    return CITY_REGISTRY.get(city) if city else None


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


def _iter_hidden_incidents(city: str | None, limit: int | None, force: bool):
    """Stream incidents we hid in the city-center backfill."""
    db = _get_db()
    q = (
        db.collection("incidents")
        .where("geocode_status", "==", "hidden_city_center_cluster")
    )
    if city:
        q = q.where("city", "==", city)
    if limit:
        q = q.limit(int(limit))

    yielded = 0
    for snap in q.stream():
        data = snap.to_dict() or {}
        if not force and data.get("repair_attempted_at"):
            continue
        yield snap.id, snap.reference, data
        yielded += 1
        if limit and yielded >= int(limit):
            return


def _adjacent_context(feed_id: str, reported_at: str, *, window_s: int = 60,
                      exclude_incident_id: str | None = None) -> list[str]:
    """Return up to 6 nearby raw_texts on the same feed, ±window_s, oldest first.

    This is wider than the live ingest path (which only uses ±60s before)
    because we're trying to recover signal — a dispatcher callout that
    landed AFTER an officer's cryptic "10-4 en route" follow-up gives us
    the location too.
    """
    if not feed_id or not reported_at:
        return []
    try:
        from datetime import timedelta
        before_dt = datetime.fromisoformat(reported_at.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return []

    floor_iso = (before_dt - timedelta(seconds=window_s)).isoformat()
    ceil_iso = (before_dt + timedelta(seconds=window_s)).isoformat()

    db = _get_db()
    rows: list[tuple[str, str]] = []
    try:
        # Explicit order_by lets Firestore use the existing
        # `feed_id ASC, reported_at DESC` composite index instead of
        # demanding a new one. We re-sort ASC in memory below.
        from google.cloud import firestore as gcf  # type: ignore
        q = (
            db.collection("extractions")
            .where("feed_id", "==", feed_id)
            .where("reported_at", ">=", floor_iso)
            .where("reported_at", "<=", ceil_iso)
            .order_by("reported_at", direction=gcf.Query.DESCENDING)
            .limit(20)
        )
        for snap in q.stream():
            d = snap.to_dict() or {}
            if exclude_incident_id and d.get("incident_id") == exclude_incident_id:
                continue
            ts = d.get("reported_at") or ""
            txt = d.get("raw_text") or ""
            if txt.strip():
                rows.append((ts, txt))
    except Exception as e:
        print(f"  [ctx-error] {e}", file=sys.stderr)
        return []

    rows.sort(key=lambda r: r[0])
    return [t for _, t in rows[:6]]


async def _recover_one(incident_id: str, ref, data: dict, *, dry_run: bool) -> str:
    city = data.get("city")
    raw_text = data.get("raw_text") or ""
    feed_id = data.get("feed_id") or ""
    reported_at = data.get("reported_at") or ""

    if not raw_text.strip():
        if not dry_run:
            ref.update({
                "repair_attempted_at": datetime.now(timezone.utc).isoformat(),
                "repair_outcome": "no_transcript",
            })
        return "no_transcript"

    prior_context = _adjacent_context(feed_id, reported_at, exclude_incident_id=incident_id)

    try:
        result = await llm.extract_incident(
            raw_text,
            city_context=_llm_ctx(city),
            prior_context=prior_context or None,
        )
    except llm.LLMError as e:
        print(f"  [{incident_id}] LLM error: {e}")
        if not dry_run:
            ref.update({
                "repair_attempted_at": datetime.now(timezone.utc).isoformat(),
                "repair_outcome": "llm_error",
            })
        return "llm_error"

    if result is None:
        if not dry_run:
            ref.update({
                "repair_attempted_at": datetime.now(timezone.utc).isoformat(),
                "repair_outcome": "llm_marked_not_relevant",
            })
        return "not_relevant"

    new_loc = (result.get("location_text") or "").strip()
    new_conf = result.get("location_confidence", "none")

    if not new_loc:
        if not dry_run:
            ref.update({
                "repair_attempted_at": datetime.now(timezone.utc).isoformat(),
                "repair_outcome": "no_location_after_llm",
                "location_confidence": new_conf,
            })
        return "no_location"

    coords = await geocode.geocode(new_loc, geo_ctx=_geo_ctx(city))
    if not coords:
        if not dry_run:
            ref.update({
                "repair_attempted_at": datetime.now(timezone.utc).isoformat(),
                "repair_outcome": "geocode_failed",
                "location_text": new_loc,
                "location_confidence": new_conf,
            })
        return "geocode_failed"

    new_lat, new_lng = coords
    payload = {
        "lat": new_lat,
        "lng": new_lng,
        "location_text": new_loc,
        "location_confidence": new_conf,
        "geocode_status": f"success_recovered_{new_conf}",
        "hidden": False,
        "repair_attempted_at": datetime.now(timezone.utc).isoformat(),
        "repair_outcome": "recovered",
        "severity_category": result.get("severity_category", data.get("severity_category")),
        "confidence": float(result.get("confidence", data.get("confidence", 0.7))),
        "description": result.get("description") or data.get("description"),
    }
    if not dry_run:
        ref.update(payload)
    print(f"  [{incident_id}] RECOVERED → {new_loc!r} @ ({new_lat:.5f}, {new_lng:.5f}) conf={new_conf}")
    return "recovered"


async def _run(args: argparse.Namespace) -> None:
    from philly_pulse import llm_client

    if not llm_client.is_configured():
        print(
            "[FATAL] No LLM provider configured. Open the SSH tunnel:\n"
            "  ssh -f -N -L 11435:localhost:11434 -i .secrets/prod_lambda_tunnel_key "
            "ubuntu@150.230.182.19\n"
            "and ensure LLM_BASE_URL / LLM_API_KEY / LLM_MODEL are set in the env.",
            file=sys.stderr,
        )
        sys.exit(2)
    print(
        f"[INFO] LLM provider: {llm_client.active_provider_name()} "
        f"(model: {llm_client.active_model()})"
    )

    _load_city_registry()
    if not CITY_REGISTRY:
        print("[WARN] No city registry loaded; falling back to defaults.", file=sys.stderr)

    counts: Counter = Counter()
    processed = 0
    started = time.time()

    for incident_id, ref, data in _iter_hidden_incidents(args.city, args.limit, args.force):
        outcome = await _recover_one(incident_id, ref, data, dry_run=args.dry_run)
        counts[outcome] += 1
        processed += 1
        if processed % 25 == 0:
            elapsed = time.time() - started
            print(f"  ... {processed} processed in {elapsed:.0f}s (counts: {dict(counts)})")
        await asyncio.sleep(args.sleep)

    print()
    print("=== Recovery run complete ===")
    print(f"Mode:       {'DRY-RUN' if args.dry_run else 'EXECUTED'}")
    print(f"City:       {args.city or '(all)'}")
    print(f"Processed:  {processed}")
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
    p.add_argument("--sleep", type=float, default=0.15,
                   help="Seconds between incidents (rate-limit pacing).")
    p.add_argument("--force", action="store_true",
                   help="Re-attempt rows already stamped with repair_attempted_at.")
    args = p.parse_args()
    args.dry_run = not args.execute

    if args.dry_run:
        print("=== DRY-RUN MODE (use --execute to write) ===\n")
    else:
        print("=== EXECUTING recovery writes ===\n")

    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
