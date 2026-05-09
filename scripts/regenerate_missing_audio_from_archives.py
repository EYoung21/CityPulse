#!/usr/bin/env python3
"""Regenerate missing incident audio clips from Broadcastify archives.

Use this after ``repair_missing_audio_urls.py``. That script can only upload
WAVs that still exist on disk. This one handles the harder case: incidents
whose ``audio_clip`` id remains in Firestore, but the local WAV is gone.

For each incident, it:
  1. Uses ``feed_id`` + ``reported_at`` to find the matching archive segment.
  2. Downloads the MP3 archive.
  3. Cuts the 60-second chunk containing ``reported_at``.
  4. Runs the same preprocessing variant used by backfill.
  5. Saves/upload the clip under the existing ``audio_clip`` id.
  6. Patches ``audio_url`` on the incident.

It does not rerun LLM/geocoding and does not create duplicate incidents.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import tempfile
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

import firebase_admin
from firebase_admin import credentials, firestore, storage

import backfill_archives as ba
from philly_pulse.preprocess import PIPELINE_VARIANTS, preprocess_audio


DEFAULT_CITIES = ("chattanooga", "nyc", "philly", "sf")
CHUNK_SECONDS = 60


def parse_iso(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


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


def public_audio_url(bucket, clip_path: Path, clip_id: str) -> str:
    blob = bucket.blob(f"audio/{clip_id}.wav")
    blob.upload_from_filename(str(clip_path), content_type="audio/wav")
    blob.make_public()
    return blob.public_url


def iter_missing_incidents(db, cities: set[str], limit: int, page_size: int, older_than_minutes: int):
    scanned = 0
    cursor = None
    base = db.collection("incidents").order_by("reported_at", direction=firestore.Query.DESCENDING)
    while True:
        if limit and scanned >= limit:
            break
        n = page_size if not limit else min(page_size, limit - scanned)
        q = base.limit(n)
        if cursor:
            q = q.start_after(cursor)
        page = list(q.stream())
        if not page:
            break
        for snap in page:
            scanned += 1
            data = snap.to_dict() or {}
            if data.get("city") not in cities:
                continue
            if not data.get("audio_clip") or data.get("audio_url"):
                continue
            if not data.get("feed_id") or not data.get("reported_at"):
                continue
            reported = parse_iso(data.get("reported_at"))
            if older_than_minutes > 0:
                floor = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=older_than_minutes)
                if reported and reported > floor:
                    continue
            yield snap, data
        cursor = page[-1]
        if len(page) < n:
            break


def fetch_archives_for_dates(session, feed_id: str, reported: dt.datetime) -> list[dict]:
    # Around midnight UTC/local, the matching archive can appear under either
    # adjacent Broadcastify date, so try yesterday/today/tomorrow.
    dates = [
        (reported.date() + dt.timedelta(days=offset)).isoformat()
        for offset in (-1, 0, 1)
    ]
    archives: list[dict] = []
    seen: set[str] = set()
    for day in dates:
        for arch in ba.fetch_archive_links(session, feed_id, day):
            aid = str(arch.get("id") or "")
            if aid and aid in seen:
                continue
            seen.add(aid)
            archives.append(arch)
    return archives


def archive_start(archive: dict, fallback_day: str | None = None) -> dt.datetime | None:
    start_ts = archive.get("startTs") or 0
    if start_ts:
        return dt.datetime.fromtimestamp(start_ts, tz=dt.timezone.utc)
    if fallback_day and archive.get("time_label"):
        try:
            return dt.datetime.fromisoformat(f"{fallback_day}T{archive['time_label']}").replace(tzinfo=dt.timezone.utc)
        except ValueError:
            return None
    return None


def choose_archive(archives: list[dict], reported: dt.datetime) -> tuple[dict | None, dt.datetime | None]:
    starts: list[tuple[dt.datetime, dict]] = []
    for arch in archives:
        start = archive_start(arch)
        if start:
            starts.append((start, arch))
    starts.sort(key=lambda t: t[0])
    if not starts:
        return None, None
    candidates = [(start, arch) for start, arch in starts if start <= reported]
    if candidates:
        start, arch = candidates[-1]
        if (reported - start).total_seconds() <= 45 * 60:
            return arch, start
    # Fallback to nearest start within 45 minutes.
    start, arch = min(starts, key=lambda t: abs((reported - t[0]).total_seconds()))
    if abs((reported - start).total_seconds()) <= 45 * 60:
        return arch, start
    return None, None


def regenerate_one(session, bucket, clip_dir: Path, snap, data: dict[str, Any], archives_cache: dict):
    reported = parse_iso(data.get("reported_at"))
    if not reported:
        return "bad_time", None
    feed_id = str(data["feed_id"])
    cache_key = (feed_id, reported.date().isoformat())
    if cache_key not in archives_cache:
        archives_cache[cache_key] = fetch_archives_for_dates(session, feed_id, reported)
    archive, start = choose_archive(archives_cache[cache_key], reported)
    if not archive or not start:
        return "no_archive", None

    offset_s = max(0.0, (reported - start).total_seconds())
    chunk_index = int(offset_s // CHUNK_SECONDS)
    clip_id = str(data["audio_clip"])

    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        mp3_path = tmp.name
    try:
        if not ba.download_mp3(session, archive["url"], mp3_path):
            return "download_failed", None
        audio = ba.mp3_to_pcm(mp3_path)
        if audio is None:
            return "decode_failed", None
        start_sample = chunk_index * CHUNK_SECONDS * ba.SAMPLE_RATE
        end_sample = start_sample + CHUNK_SECONDS * ba.SAMPLE_RATE
        chunk = audio[start_sample:end_sample]
        if len(chunk) <= ba.SAMPLE_RATE:
            return "chunk_empty", None

        processed, _meta = preprocess_audio(chunk, PIPELINE_VARIANTS[0])
        if len(processed) <= ba.SAMPLE_RATE:
            processed = chunk

        clip_dir.mkdir(parents=True, exist_ok=True)
        wav_path = clip_dir / f"{clip_id}.wav"
        ba._save_wav(str(wav_path), processed)
        url = public_audio_url(bucket, wav_path, clip_id)
        snap.reference.update({"audio_url": url})
        return "repaired", url
    finally:
        try:
            os.unlink(mp3_path)
        except OSError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--city", action="append", dest="cities")
    parser.add_argument("--clip-dir", default="audio_clips")
    parser.add_argument("--bucket", default=os.environ.get("FIREBASE_STORAGE_BUCKET", "phlpulse.firebasestorage.app"))
    parser.add_argument("--limit", type=int, default=1000, help="Max incidents to scan; 0 means all.")
    parser.add_argument("--max-repairs", type=int, default=25, help="Max clips to repair in this run; 0 means no cap.")
    parser.add_argument("--max-attempts", type=int, default=100, help="Max missing-audio incidents to attempt in this run; 0 means no cap.")
    parser.add_argument("--page-size", type=int, default=500)
    parser.add_argument("--older-than-minutes", type=int, default=180, help="Skip very recent incidents whose archives may not exist yet.")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--sleep", type=float, default=1.0)
    args = parser.parse_args()

    db, bucket = init_firebase(args.bucket)
    cities = set(args.cities or DEFAULT_CITIES)
    clip_dir = Path(args.clip_dir)
    session = ba.get_broadcastify_session()
    archives_cache: dict = {}

    counts: defaultdict[str, int] = defaultdict(int)
    repaired = 0
    attempts = 0
    for snap, data in iter_missing_incidents(db, cities, args.limit, args.page_size, args.older_than_minutes):
        if args.max_repairs and repaired >= args.max_repairs:
            break
        if args.max_attempts and attempts >= args.max_attempts:
            break
        attempts += 1
        if not args.apply:
            counts["would_attempt"] += 1
            print(
                f"DRY {snap.id} city={data.get('city')} feed={data.get('feed_id')} "
                f"reported={data.get('reported_at')} clip={data.get('audio_clip')}",
                flush=True,
            )
            repaired += 1
            continue
        status, url = regenerate_one(session, bucket, clip_dir, snap, data, archives_cache)
        counts[status] += 1
        if status == "repaired":
            repaired += 1
        print(
            f"{status} {snap.id} city={data.get('city')} feed={data.get('feed_id')} "
            f"reported={data.get('reported_at')} clip={data.get('audio_clip')} url={bool(url)}",
            flush=True,
        )
        time.sleep(args.sleep)

    print("SUMMARY " + " ".join(f"{k}={v}" for k, v in sorted(counts.items())), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
