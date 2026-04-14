#!/usr/bin/env python3
"""One-time script to backfill the `city` field on existing Firestore incidents and extractions.

Maps each document's `feed_id` to its owning city slug, then batch-updates
documents that are missing the `city` field. Uses batched queries with
exponential backoff to respect Firestore quotas.

Usage:
    python3 backfill_city_field.py                # dry-run (default)
    python3 backfill_city_field.py --execute      # actually write updates
    python3 backfill_city_field.py --collection extractions --execute
"""

import argparse
import json
import os
import time

import firebase_admin
from firebase_admin import credentials, firestore

# feed_id → city slug mapping (from all cities/*/config.yaml)
FEED_TO_CITY: dict[str, str] = {
    # Philadelphia
    "4603": "philly", "17310": "philly", "21297": "philly",
    "45495": "philly", "18836": "philly", "15102": "philly",
    "15195": "philly", "34250": "philly", "15747": "philly",
    "44308": "philly", "36323": "philly", "46438": "philly",
    "24104": "philly", "10489": "philly", "25767": "philly",
    # San Francisco
    "46180": "sf", "6336": "sf",
    # New York City
    "40184": "nyc", "40185": "nyc", "40186": "nyc", "46122": "nyc",
    # Chattanooga
    "45708": "chattanooga", "34716": "chattanooga", "45709": "chattanooga",
    "45707": "chattanooga", "44571": "chattanooga", "21572": "chattanooga",
    "45601": "chattanooga", "45706": "chattanooga", "29255": "chattanooga",
    # Seattle
    "40168": "seattle", "20365": "seattle", "45933": "seattle",
    # Dallas
    "46336": "dallas", "2681": "dallas",
    # Frisco
    "40227": "frisco",
}


def get_db():
    if firebase_admin._apps:
        return firestore.client()
    cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    json_str = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    if cred_path and os.path.isfile(cred_path):
        cred = credentials.Certificate(cred_path)
    elif json_str:
        cred = credentials.Certificate(json.loads(json_str))
    else:
        raise RuntimeError("Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON")
    firebase_admin.initialize_app(cred)
    return firestore.client()


def backfill_collection(collection_name: str, dry_run: bool):
    db = get_db()
    col = db.collection(collection_name)

    total = 0
    updated = 0
    skipped_has_city = 0
    skipped_no_feed = 0
    unknown_feed = 0
    errors = 0

    batch_size = 500
    last_doc = None

    while True:
        q = col.order_by("__name__").limit(batch_size)
        if last_doc:
            q = q.start_after(last_doc)

        for attempt in range(5):
            try:
                docs = list(q.stream())
                break
            except Exception as e:
                if "429" in str(e) or "Quota" in str(e) or "RESOURCE_EXHAUSTED" in str(e):
                    wait = min(2 ** attempt * 5, 120)
                    print(f"  [QUOTA] backoff {wait}s (attempt {attempt + 1})...")
                    time.sleep(wait)
                    continue
                raise
        else:
            print("  [ERROR] Exhausted retries for query batch, stopping.")
            break

        if not docs:
            break

        write_batch = db.batch()
        batch_count = 0

        for doc in docs:
            total += 1
            data = doc.to_dict() or {}

            if data.get("city"):
                skipped_has_city += 1
                continue

            feed_id = str(data.get("feed_id", ""))
            if not feed_id or feed_id == "unknown":
                skipped_no_feed += 1
                continue

            city = FEED_TO_CITY.get(feed_id)
            if not city:
                unknown_feed += 1
                if total <= 20 or unknown_feed <= 10:
                    print(f"  [UNKNOWN FEED] doc={doc.id} feed_id={feed_id}")
                continue

            if not dry_run:
                write_batch.update(doc.reference, {"city": city})
                batch_count += 1

            updated += 1

        if batch_count > 0:
            for attempt in range(5):
                try:
                    write_batch.commit()
                    break
                except Exception as e:
                    if "429" in str(e) or "Quota" in str(e) or "RESOURCE_EXHAUSTED" in str(e):
                        wait = min(2 ** attempt * 5, 120)
                        print(f"  [QUOTA] write backoff {wait}s (attempt {attempt + 1})...")
                        time.sleep(wait)
                        continue
                    print(f"  [WRITE ERROR] {e}")
                    errors += batch_count
                    break

        last_doc = docs[-1]

        if total % 2000 == 0:
            print(f"  ... processed {total} docs, updated {updated}, "
                  f"already had city={skipped_has_city}, no feed={skipped_no_feed}")

        time.sleep(0.2)

    mode = "DRY-RUN" if dry_run else "EXECUTED"
    print(f"\n=== {collection_name} backfill {mode} ===")
    print(f"  Total docs scanned: {total}")
    print(f"  Updated with city:  {updated}")
    print(f"  Already had city:   {skipped_has_city}")
    print(f"  No feed_id:         {skipped_no_feed}")
    print(f"  Unknown feed_id:    {unknown_feed}")
    print(f"  Errors:             {errors}")


def main():
    parser = argparse.ArgumentParser(description="Backfill city field on Firestore docs")
    parser.add_argument("--execute", action="store_true", help="Actually write updates (default: dry-run)")
    parser.add_argument("--collection", default="incidents",
                        choices=["incidents", "extractions", "both"],
                        help="Which collection(s) to backfill")
    args = parser.parse_args()

    dry_run = not args.execute
    if dry_run:
        print("=== DRY-RUN MODE (use --execute to write) ===\n")

    collections = ["incidents", "extractions"] if args.collection == "both" else [args.collection]

    for col in collections:
        print(f"\nBackfilling '{col}'...")
        backfill_collection(col, dry_run)


if __name__ == "__main__":
    main()
