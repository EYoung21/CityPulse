#!/usr/bin/env python3
"""Soft-hide visible incidents whose location_text is too vague to trust.

Background: even after the city-center cluster cleanup
(`hide_city_center_clusters.py`) and the recovery pass
(`recover_hidden_clusters.py`), some incidents kept slipping back onto
the map with `location_text` like "I-95", "the mall", "Walmart parking
lot", "alley", "exit 6". These are road-segment / generic-POI strings
that Nominatim happily resolves to a single arbitrary point — usually
the city centroid or a random matching POI — so unrelated reports stack
on one pin even though their lat/lng are slightly different.

Two changes were made together:

  1. `philly_pulse.geocode._is_too_vague` was hardened to reject these
     strings up-front so NEW incidents don't reach the map (interstate-
     only patterns, "<brand> parking lot", "the mall", "exit N", etc.).

  2. This script does the BACKFILL for all cities: walk every visible
     incident in /incidents, run the same `_is_too_vague` check, and
     soft-hide the matches with:

         hidden = true
         geocode_status = "hidden_vague_location"
         repair_reason  = "vague_text_post_recovery"
         repaired_at    = <iso>

The frontend's `shouldRenderIncident` already drops `hidden=true`, so
they disappear from the map immediately. Underlying data is preserved.

Idempotent: rows already `hidden=true` are skipped. Dry-run by default;
`--execute` to actually write.

Usage:
    python3 scripts/hide_vague_location_incidents.py               # dry-run all cities
    python3 scripts/hide_vague_location_incidents.py --execute     # write all cities
    python3 scripts/hide_vague_location_incidents.py --execute --city sf
    python3 scripts/hide_vague_location_incidents.py --execute --recovered-only

`--recovered-only` restricts to incidents stamped with
`geocode_status starts with "success_recovered_"` — the bucket the user
specifically called out. Without it we sweep ALL visible incidents.

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

import yaml  # noqa: E402

from philly_pulse.geocode import _is_too_vague  # noqa: E402

# Per-city geocode suffix lookup — needed because `_is_too_vague` strips
# the city/state suffix before testing. We don't have to re-geocode
# anything, just classify the existing text.
_DEFAULT_SUFFIX = ", USA"


def _load_city_suffixes() -> dict[str, str]:
    """Map city slug → its geocode suffix from cities/<slug>/config.yaml."""
    out: dict[str, str] = {}
    cities_dir = REPO_ROOT / "cities"
    if not cities_dir.is_dir():
        return out
    for cfg_dir in sorted(cities_dir.iterdir()):
        cfg = cfg_dir / "config.yaml"
        if not cfg.exists():
            continue
        try:
            with open(cfg, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
            slug = (data.get("city", {}) or {}).get("slug") or cfg_dir.name
            suffix = (data.get("geocode", {}) or {}).get("suffix") or _DEFAULT_SUFFIX
            out[slug] = suffix
        except Exception as e:
            print(f"[WARN] could not read {cfg}: {e}", file=sys.stderr)
    return out


def _get_db():
    from philly_pulse.firestore_store import _ensure_client
    return _ensure_client()


def _scan_city(
    db,
    city: str,
    suffix: str,
    *,
    sample_limit: int,
    recovered_only: bool,
) -> tuple[Counter, list[tuple[str, object, dict]], dict[str, list[str]]]:
    """Return (outcome_counts, rows_to_hide, examples_by_text).

    `rows_to_hide` contains (incident_id, ref, dict) for every visible
    incident whose location_text is vague. `examples_by_text` is a
    sample of the offending strings → first 5 incident IDs, for the
    operator to sanity-check before --execute.
    """
    counts: Counter = Counter()
    to_hide: list[tuple[str, object, dict]] = []
    examples: dict[str, list[str]] = defaultdict(list)

    q = db.collection("incidents").where("city", "==", city).limit(sample_limit)
    for snap in q.stream():
        d = snap.to_dict() or {}
        counts["scanned"] += 1
        if d.get("hidden") is True:
            counts["already_hidden"] += 1
            continue
        if d.get("inhibitor_status") == "blocked":
            counts["inhibitor_blocked"] += 1
            continue
        gs = (d.get("geocode_status") or "").strip()
        if recovered_only and not gs.startswith("success_recovered_"):
            counts["not_recovered_skipped"] += 1
            continue
        loc = (d.get("location_text") or "").strip()
        if not loc:
            counts["no_location_text"] += 1
            continue
        if not _is_too_vague(loc, suffix):
            counts["passed_filter"] += 1
            continue
        # Vague — hide.
        counts["to_hide"] += 1
        to_hide.append((snap.id, snap.reference, d))
        # Keep up to 5 example incident IDs per offending text for the
        # operator's audit log.
        if len(examples[loc]) < 5:
            examples[loc].append(snap.id)

    return counts, to_hide, examples


def _commit_hides(db, rows: list[tuple[str, object, dict]]) -> int:
    """Batch update `hidden=true` etc. across `rows`. Returns count."""
    if not rows:
        return 0
    iso = datetime.now(timezone.utc).isoformat()
    payload = {
        "hidden": True,
        "geocode_status": "hidden_vague_location",
        "repair_reason": "vague_text_post_recovery",
        "repaired_at": iso,
    }
    written = 0
    batch = db.batch()
    for _inc_id, ref, _ in rows:
        batch.update(ref, payload)
        written += 1
        if written % 400 == 0:
            batch.commit()
            batch = db.batch()
    batch.commit()
    return written


def _run(args: argparse.Namespace) -> None:
    db = _get_db()
    suffixes = _load_city_suffixes()
    if not suffixes:
        print("[WARN] no city configs found; falling back to ', USA' for all", file=sys.stderr)

    cities: list[str]
    if args.city:
        cities = [args.city]
    else:
        # Discover cities by sampling /incidents (cheap projection).
        seen: Counter = Counter()
        for snap in db.collection("incidents").select(["city"]).limit(20000).stream():
            seen[(snap.to_dict() or {}).get("city", "(none)")] += 1
        cities = [c for c, _ in seen.most_common() if c and c != "(none)"]

    mode = "DRY-RUN" if args.dry_run else "EXECUTE"
    scope = "RECOVERED-ONLY" if args.recovered_only else "ALL VISIBLE"
    print(f"=== {mode} hide_vague_location_incidents ({scope}) ===")
    print(f"Cities:       {cities}")
    print(f"Sample limit: {args.sample_limit} per city")
    print(f"Examples/text shown: {args.examples_per_text}")
    print()

    started = time.time()
    grand_to_hide = 0
    grand_scanned = 0
    grand_examples: dict[str, dict[str, list[str]]] = {}

    for city in cities:
        suffix = suffixes.get(city, _DEFAULT_SUFFIX)
        counts, rows, examples = _scan_city(
            db, city, suffix,
            sample_limit=args.sample_limit,
            recovered_only=args.recovered_only,
        )
        grand_scanned += counts.get("scanned", 0)
        grand_to_hide += counts.get("to_hide", 0)
        if examples:
            grand_examples[city] = examples

        print(f"--- {city} (suffix={suffix!r}) ---")
        for k in ("scanned", "already_hidden", "inhibitor_blocked",
                  "not_recovered_skipped", "no_location_text",
                  "passed_filter", "to_hide"):
            v = counts.get(k, 0)
            if v:
                print(f"    {k:25s} {v}")

        if examples:
            print(f"    sample offending texts ({min(args.examples_per_text, len(examples))} of {len(examples)} unique):")
            shown = 0
            for txt, ids in sorted(examples.items(), key=lambda kv: -len(kv[1])):
                if shown >= args.examples_per_text:
                    break
                print(f"      {txt!r:60s}  ids={ids}")
                shown += 1

        if not args.dry_run and rows:
            n = _commit_hides(db, rows)
            print(f"    -> hidden {n} incidents")
        print()

    print("=== Summary ===")
    print(f"Mode:                {mode}")
    print(f"Scope:               {scope}")
    print(f"Cities scanned:      {len(cities)}")
    print(f"Incidents scanned:   {grand_scanned}")
    print(f"Incidents to hide:   {grand_to_hide}  ({'NOT WRITTEN' if args.dry_run else 'WRITTEN'})")
    print(f"Elapsed:             {time.time() - started:.1f}s")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--execute", action="store_true",
                   help="Actually write updates (default: dry-run).")
    p.add_argument("--city", default=None,
                   help="Restrict to a single city slug (e.g. sf, philly).")
    p.add_argument("--recovered-only", action="store_true",
                   help="Only consider rows whose geocode_status starts with "
                        "'success_recovered_' (the recover_hidden_clusters output).")
    p.add_argument("--sample-limit", type=int, default=20000,
                   help="Max incidents to scan per city (default 20000).")
    p.add_argument("--examples-per-text", type=int, default=8,
                   help="How many unique offending strings to print per city.")
    args = p.parse_args()
    args.dry_run = not args.execute
    _run(args)


if __name__ == "__main__":
    main()
