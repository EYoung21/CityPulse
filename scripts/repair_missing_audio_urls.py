#!/usr/bin/env python3
"""Repair incident audio URLs from local backfill WAV clips.

Backfill incidents created before audio_data upload support can have an
``audio_clip`` id but no ``audio_url``. Run this on the Lambda backfill host,
where ``audio_clips/<clip_id>.wav`` still exists, to upload missing clips to
Firebase Storage and patch Firestore incidents in place.
"""

from __future__ import annotations

import argparse
import os
import re
import time
from pathlib import Path
from typing import Any

import firebase_admin
from firebase_admin import credentials, firestore, storage


CLIP_RE = re.compile(r"^[a-f0-9]{12}$")
DEFAULT_CITIES = ("chattanooga", "nyc", "philly", "sf")


def init_firebase(bucket_name: str):
    cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not cred_path:
        raise SystemExit("GOOGLE_APPLICATION_CREDENTIALS must point to the service-account JSON")
    if not firebase_admin._apps:
        firebase_admin.initialize_app(
            credentials.Certificate(cred_path),
            {"storageBucket": bucket_name},
        )
    return firestore.client(), storage.bucket(bucket_name)


def upload_clip(bucket, clip_dir: Path, clip_id: str) -> str | None:
    if not CLIP_RE.fullmatch(clip_id):
        return None
    path = clip_dir / f"{clip_id}.wav"
    if not path.exists():
        return None
    blob = bucket.blob(f"audio/{clip_id}.wav")
    blob.upload_from_filename(str(path), content_type="audio/wav")
    blob.make_public()
    return blob.public_url


def patch_mentions(bucket, clip_dir: Path, mentions: list[Any], cache: dict[str, str]) -> tuple[list[Any], int, int]:
    changed = 0
    missing = 0
    out: list[Any] = []
    for mention in mentions:
        if not isinstance(mention, dict):
            out.append(mention)
            continue
        next_mention = dict(mention)
        clip_id = next_mention.get("audio_clip")
        if clip_id and not next_mention.get("audio_url"):
            url = cache.get(clip_id)
            if url is None:
                url = upload_clip(bucket, clip_dir, clip_id)
                if url:
                    cache[clip_id] = url
            if url:
                next_mention["audio_url"] = url
                changed += 1
            else:
                missing += 1
        out.append(next_mention)
    return out, changed, missing


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--clip-dir", default="audio_clips")
    parser.add_argument("--bucket", default=os.environ.get("FIREBASE_STORAGE_BUCKET", "phlpulse.firebasestorage.app"))
    parser.add_argument("--city", action="append", dest="cities")
    parser.add_argument("--limit", type=int, default=0, help="Max Firestore docs to scan; 0 means all.")
    parser.add_argument("--page-size", type=int, default=500, help="Firestore page size.")
    parser.add_argument("--max-updates", type=int, default=0, help="Max incidents to patch; 0 means no cap.")
    parser.add_argument("--apply", action="store_true", help="Actually update Firestore. Default is dry run.")
    parser.add_argument("--sleep", type=float, default=0.03, help="Pause between updates.")
    args = parser.parse_args()

    clip_dir = Path(args.clip_dir)
    cities = set(args.cities or DEFAULT_CITIES)
    db, bucket = init_firebase(args.bucket)
    cache: dict[str, str] = {}

    scanned = eligible = updated = missing = mention_updates = 0
    base_query = db.collection("incidents").order_by("reported_at", direction=firestore.Query.DESCENDING)
    cursor = None

    while True:
        if args.limit > 0 and scanned >= args.limit:
            break
        page_limit = max(1, args.page_size)
        if args.limit > 0:
            page_limit = min(page_limit, args.limit - scanned)
        query = base_query.limit(page_limit)
        if cursor:
            query = query.start_after(cursor)
        page = list(query.stream())
        if not page:
            break

        for snap in page:
            scanned += 1
            data = snap.to_dict() or {}
            if data.get("city") not in cities:
                continue

            patch: dict[str, Any] = {}
            root_clip = data.get("audio_clip")
            if root_clip and not data.get("audio_url"):
                eligible += 1
                url = cache.get(root_clip)
                if url is None:
                    url = upload_clip(bucket, clip_dir, root_clip)
                    if url:
                        cache[root_clip] = url
                if url:
                    patch["audio_url"] = url
                else:
                    missing += 1

            mentions = data.get("mentions")
            if isinstance(mentions, list):
                next_mentions, changed, mention_missing = patch_mentions(bucket, clip_dir, mentions, cache)
                if changed:
                    patch["mentions"] = next_mentions
                    mention_updates += changed
                missing += mention_missing

            if patch:
                updated += 1
                if args.apply:
                    snap.reference.update(patch)
                    time.sleep(args.sleep)
                if updated % 100 == 0:
                    print(
                        f"scanned={scanned} eligible_root={eligible} "
                        f"updated_docs={updated} mention_urls={mention_updates} missing_clips={missing}",
                        flush=True,
                    )
                if args.max_updates and updated >= args.max_updates:
                    break

        cursor = page[-1]
        if len(page) < page_limit:
            break
        if args.max_updates and updated >= args.max_updates:
            break

    mode = "APPLIED" if args.apply else "DRY_RUN"
    print(
        f"{mode} scanned={scanned} eligible_root={eligible} "
        f"updated_docs={updated} mention_urls={mention_updates} missing_clips={missing}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
