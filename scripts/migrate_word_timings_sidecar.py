#!/usr/bin/env python3
"""Move inline incident ``word_timings`` into the sidecar collection.

``word_timings`` was ~73% of the map-sync payload (≈4.9 MB of a 6.7 MB cold
load) yet only the detail view needs it. New ingest already writes it to the
``incident_word_timings`` sidecar (see ``firestore_store.insert_incident``);
this backfills existing incidents:

  1. copy inline ``word_timings`` to ``incident_word_timings/{id}``
  2. set ``has_word_timings = True`` on the incident
  3. delete the inline ``word_timings`` field so the map query goes slim

The frontend reads inline timings on legacy docs and lazy-loads from the
sidecar otherwise, so run this AFTER the frontend deploy. Dry-run by default;
``--execute`` to write. Resumable — already-slim rows are skipped.

Usage:
    python3 scripts/migrate_word_timings_sidecar.py
    python3 scripts/migrate_word_timings_sidecar.py --execute
    python3 scripts/migrate_word_timings_sidecar.py --execute --city chattanooga
"""
from __future__ import annotations

import argparse
import sys
import time
from collections import Counter
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from firebase_admin import firestore as fb_firestore  # noqa: E402
from philly_pulse.firestore_store import (  # noqa: E402
    WORD_TIMINGS_COLLECTION,
    _ensure_client,
)


def _run(args: argparse.Namespace) -> None:
    db = _ensure_client()
    counts: Counter = Counter()
    started = time.time()

    base = db.collection("incidents")
    if args.city:
        from google.cloud.firestore_v1.base_query import FieldFilter

        base = base.where(filter=FieldFilter("city", "==", args.city))

    # Paginate by document id rather than one long stream — a single 45k-doc
    # stream trips a google-cloud-firestore retry bug, and id-ordering is stable
    # even as we mutate docs (the id never changes). Resumable: already-slim rows
    # are skipped, so a re-run continues where a crash left off.
    BATCH = 800
    scanned = 0
    last = None
    stop = False
    while not stop:
        q = base.order_by("__name__").limit(BATCH)
        if last is not None:
            q = q.start_after(last)
        docs = list(q.stream())
        if not docs:
            break
        last = docs[-1]
        for snap in docs:
            scanned += 1
            data = snap.to_dict() or {}
            wt = data.get("word_timings")
            if not isinstance(wt, list) or not wt:
                counts["already_slim"] += 1
                continue
            if not args.dry_run:
                try:
                    db.collection(WORD_TIMINGS_COLLECTION).document(snap.id).set(
                        {"incident_id": snap.id, "word_timings": wt}
                    )
                    snap.reference.update(
                        {
                            "has_word_timings": True,
                            "word_timings": fb_firestore.DELETE_FIELD,
                        }
                    )
                except Exception as e:  # don't let one bad doc kill the run
                    counts["error"] += 1
                    print(f"  [err] {snap.id}: {e}", flush=True)
                    continue
            counts["migrated"] += 1
            if args.limit and counts["migrated"] >= args.limit:
                stop = True
                break
        print(f"... scanned {scanned}, migrated {counts['migrated']}", flush=True)

    print()
    print("=== word_timings sidecar migration ===")
    print(f"Mode:      {'DRY-RUN' if args.dry_run else 'EXECUTED'}")
    print(f"City:      {args.city or '(all)'}")
    print(f"Scanned:   {scanned}")
    for k, v in counts.most_common():
        print(f"  {k:14s} {v}")
    print(f"Elapsed:   {time.time() - started:.0f}s")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--execute", action="store_true", help="Write (default: dry-run).")
    p.add_argument("--city", default=None, help="Restrict to one city slug.")
    p.add_argument("--limit", type=int, default=None, help="Cap migrated rows.")
    args = p.parse_args()
    args.dry_run = not args.execute

    if args.dry_run:
        print("[DRY-RUN] pass --execute to write Firestore updates.\n", flush=True)

    _run(args)


if __name__ == "__main__":
    main()
