#!/usr/bin/env python3
"""One-shot purge of the orphaned `userReports` Firestore collection.

Background: the crowdsourced "drop a pin" feature was removed from the
app on 2026-04-21 (see commit "feat(moderation): remove user reports +
broadcast"). The frontend no longer reads or writes `userReports`, the
`/api/push/notify-user-report` endpoint is gone, and the Firestore
rules block all client access to the collection. The documents that
were already in the collection before the cutover are still sitting
there, taking up storage and making the Firebase console confusing.

This script deletes every doc under `userReports/{reportId}` and the
per-voter sub-collection `userReports/{reportId}/votes/{voterUid}`. It
is dry-run by default — it walks the collection, prints what it would
delete, and exits without touching anything. Pass `--yes` to actually
delete. The deletions go through the Firebase Admin SDK using batched
writes (cap of ~500 operations per batch) so we don't blow the per-
request limit on a city with thousands of historical reports.

Usage:

    python3 scripts/delete_user_reports.py
    python3 scripts/delete_user_reports.py --yes
    python3 scripts/delete_user_reports.py --yes --city philly

Idempotent: safe to re-run; subsequent runs find nothing to delete.
Requires GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON
in the environment.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

# Re-use the same Firestore bootstrap as the rest of the backend so we
# pick up GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_SERVICE_ACCOUNT_JSON
# without duplicating the env-juggling logic.
from philly_pulse.firestore_store import _ensure_client  # noqa: E402

# Firestore caps a single batched commit at 500 operations. We delete
# one parent doc + N votes per report; staying well under the cap with
# a smaller window keeps the largest reports from spilling a batch.
BATCH_LIMIT = 400


def _iter_reports(db, *, city: str | None):
    """Yield report doc snapshots, optionally filtered by city.

    We page through the collection rather than calling .get() in one
    shot so the script doesn't hold every doc in memory if a city
    accumulated thousands of historical pins."""
    col = db.collection("userReports")
    if city:
        # `city` was always written as the city slug (philly, sf, …).
        # The where filter keeps the round-trip cheap when an admin
        # only wants to wipe one city's data.
        col = col.where("city", "==", city)
    return col.stream()


def _delete_report_with_votes(db, batch, report_ref) -> int:
    """Stage deletes for one parent doc + every doc under its
    `votes/` sub-collection. Returns the number of operations
    appended to `batch` so the caller can decide when to flush."""
    ops = 0
    for vote_snap in report_ref.collection("votes").stream():
        batch.delete(vote_snap.reference)
        ops += 1
    batch.delete(report_ref)
    ops += 1
    return ops


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Actually delete. Without this flag the script is a dry run.",
    )
    parser.add_argument(
        "--city",
        default=None,
        help="Optional city slug filter (e.g. philly). Default: all cities.",
    )
    args = parser.parse_args()

    try:
        db = _ensure_client()
    except RuntimeError as e:
        print(f"Firestore client unavailable: {e}", file=sys.stderr)
        return 2

    mode = "DELETE" if args.yes else "DRY-RUN"
    city_label = args.city or "<all>"
    print(f"[{mode}] userReports purge — city={city_label}")

    total_reports = 0
    total_votes = 0
    pending_ops = 0
    batch = db.batch() if args.yes else None

    for snap in _iter_reports(db, city=args.city):
        total_reports += 1
        votes = list(snap.reference.collection("votes").stream())
        total_votes += len(votes)

        if args.yes:
            assert batch is not None
            for v in votes:
                batch.delete(v.reference)
            batch.delete(snap.reference)
            pending_ops += len(votes) + 1
            if pending_ops >= BATCH_LIMIT:
                batch.commit()
                batch = db.batch()
                pending_ops = 0
        else:
            print(
                f"  would delete report {snap.id} "
                f"(city={(snap.to_dict() or {}).get('city', '?')}, "
                f"votes={len(votes)})"
            )

    if args.yes and batch is not None and pending_ops > 0:
        batch.commit()

    verb = "Deleted" if args.yes else "Would delete"
    print(
        f"{verb} {total_reports} report doc(s) and {total_votes} vote doc(s)."
    )
    if not args.yes and total_reports > 0:
        print("Re-run with --yes to apply.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
