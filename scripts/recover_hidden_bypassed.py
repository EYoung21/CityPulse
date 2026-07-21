#!/usr/bin/env python3
"""Recover legacy soft-hidden incidents from the Invalid API key bypass window.

During Apr 8–17 2026 the external Inhibitor API returned `Invalid API key`,
so ~1,689 incidents were ingested with `inhibitor_status='bypassed'`. Most
published normally; ~162 were later soft-hidden by geocode repair scripts
(city-center clusters, vague text, suburb misgeocodes, unmapped repair).

This script gives those hidden bypassed rows a second chance:

  * `hidden_city_center_cluster` / `hidden_vague_location` → LLM re-extract
    with adjacent radio context, then strict re-geocode (same logic as
    `recover_hidden_clusters.py`).
  * `unmapped_repaired` / `hidden_suburb_misgeocode` → re-geocode the stored
    `location_text` with the current geocoder (no LLM).

Dry-run by default. `--execute` to write.

Usage:
    python3 scripts/recover_hidden_bypassed.py
    python3 scripts/recover_hidden_bypassed.py --execute
    python3 scripts/recover_hidden_bypassed.py --execute --limit 50

Requires:
  - GOOGLE_APPLICATION_CREDENTIALS pointing at the service account
  - For LLM recovery paths: LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
  - Network access to Nominatim
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from philly_pulse import geocode  # noqa: E402
from philly_pulse.city_registry import CITY_REGISTRY, load_city_registry  # noqa: E402
from google.cloud.firestore_v1.base_query import FieldFilter  # noqa: E402

_LLM_RECOVERY_STATUSES = frozenset({
    "hidden_city_center_cluster",
    "hidden_vague_location",
})
_GEOCODE_ONLY_STATUSES = frozenset({
    "unmapped_repaired",
    "hidden_suburb_misgeocode",
})


def _load_cluster_recovery():
    path = Path(__file__).parent / "recover_hidden_clusters.py"
    spec = importlib.util.spec_from_file_location("recover_hidden_clusters", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


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


def _load_hidden_bypassed(
    *,
    city: str | None,
    limit: int | None,
    force: bool,
) -> list[tuple]:
    db = _get_db()
    q = (
        db.collection("incidents")
        .where(filter=FieldFilter("inhibitor_status", "==", "bypassed"))
        .where(filter=FieldFilter("hidden", "==", True))
    )
    if city:
        q = q.where(filter=FieldFilter("city", "==", city))

    rows: list[tuple] = []
    for snap in q.stream():
        data = snap.to_dict() or {}
        if not force and data.get("bypassed_recovery_attempted_at"):
            continue
        rows.append((snap.id, snap.reference, data))
        if limit and len(rows) >= int(limit):
            break
    return rows


async def _regeocode_only(incident_id: str, ref, data: dict, *, dry_run: bool) -> str:
    city = data.get("city")
    location_text = (data.get("location_text") or "").strip()
    if not location_text:
        if not dry_run:
            ref.update({
                "bypassed_recovery_attempted_at": datetime.now(timezone.utc).isoformat(),
                "bypassed_recovery_outcome": "no_location_text",
            })
        return "no_location_text"

    gctx = _geo_ctx(city)
    suf = (gctx or {}).get("suffix") or ""
    if suf:
        norm = geocode.normalize_location_text_for_geocode(location_text, suffix=suf)
        if norm:
            location_text = norm

    coords = await geocode.geocode(location_text, geo_ctx=gctx)
    if not coords:
        if not dry_run:
            ref.update({
                "bypassed_recovery_attempted_at": datetime.now(timezone.utc).isoformat(),
                "bypassed_recovery_outcome": "geocode_failed",
            })
        return "geocode_failed"

    lat, lng = coords
    payload = {
        "lat": lat,
        "lng": lng,
        "location_text": location_text,
        "geocode_status": "success_bypassed_recovery",
        "hidden": False,
        "bypassed_recovery_attempted_at": datetime.now(timezone.utc).isoformat(),
        "bypassed_recovery_outcome": "regeocoded",
    }
    if not dry_run:
        ref.update(payload)
    print(
        f"  [{incident_id}] REGEOCODED → {location_text!r} @ ({lat:.5f}, {lng:.5f})",
        flush=True,
    )
    return "regeocoded"


async def _run(args: argparse.Namespace) -> None:
    cluster_mod = _load_cluster_recovery()
    load_city_registry()

    counts: Counter = Counter()
    started = time.time()

    print("[INFO] loading hidden bypassed incidents...", flush=True)
    rows = _load_hidden_bypassed(city=args.city, limit=args.limit, force=args.force)
    print(f"[INFO] loaded {len(rows)} hidden bypassed incidents", flush=True)

    for incident_id, ref, data in rows:
        status = data.get("geocode_status") or ""
        if status in _LLM_RECOVERY_STATUSES:
            outcome = await cluster_mod._recover_one(incident_id, ref, data, dry_run=args.dry_run)
            if not args.dry_run and outcome == "recovered":
                ref.update({
                    "bypassed_recovery_attempted_at": datetime.now(timezone.utc).isoformat(),
                    "bypassed_recovery_outcome": "llm_recovered",
                })
        elif status in _GEOCODE_ONLY_STATUSES:
            outcome = await _regeocode_only(incident_id, ref, data, dry_run=args.dry_run)
        else:
            print(f"  [{incident_id}] SKIP unknown geocode_status={status!r}", flush=True)
            outcome = "skipped_unknown_status"
            if not args.dry_run:
                ref.update({
                    "bypassed_recovery_attempted_at": datetime.now(timezone.utc).isoformat(),
                    "bypassed_recovery_outcome": outcome,
                })

        counts[outcome] += 1
        await asyncio.sleep(args.sleep)

    print()
    print("=== Hidden bypassed recovery complete ===")
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
    p.add_argument("--sleep", type=float, default=0.15,
                   help="Seconds between incidents.")
    p.add_argument("--force", action="store_true",
                   help="Re-attempt rows already stamped with bypassed_recovery_attempted_at.")
    args = p.parse_args()
    args.dry_run = not args.execute

    if args.dry_run:
        print("[DRY-RUN] Pass --execute to write Firestore updates.\n", flush=True)

    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
