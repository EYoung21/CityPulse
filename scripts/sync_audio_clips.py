#!/usr/bin/env python3
"""Batch-upload local audio clips to the API server.

Reads WAV files from audio_clips/ (and optionally audio_clips_raw/),
base64-encodes them, and POSTs them in batches to /api/audio/upload.

Usage:
    python scripts/sync_audio_clips.py
    python scripts/sync_audio_clips.py --include-raw
    python scripts/sync_audio_clips.py --api-url https://api.phlpulse.com --batch-size 20
"""

import argparse
import base64
import json
import os
import sys
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError

REPO_ROOT = Path(__file__).resolve().parent.parent
CLIPS_DIR = REPO_ROOT / "audio_clips"
RAW_DIR = REPO_ROOT / "audio_clips_raw"

DEFAULT_API = "https://api.phlpulse.com"
BATCH_SIZE = 10  # clips per request (keep payload under ~10MB)


def upload_batch(api_url: str, clips: dict, raw_clips: dict | None = None):
    payload = {"clips": clips}
    if raw_clips:
        payload["raw_clips"] = raw_clips
    body = json.dumps(payload).encode("utf-8")
    req = Request(
        f"{api_url}/api/audio/upload",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())


def main():
    parser = argparse.ArgumentParser(description="Sync audio clips to the API server")
    parser.add_argument("--api-url", default=DEFAULT_API)
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    parser.add_argument("--include-raw", action="store_true",
                        help="Also upload raw (unprocessed) clips")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    wav_files = sorted(CLIPS_DIR.glob("*.wav"))
    print(f"Found {len(wav_files)} processed clips in {CLIPS_DIR}")

    raw_files = []
    if args.include_raw:
        raw_files = sorted(RAW_DIR.glob("*.wav"))
        print(f"Found {len(raw_files)} raw clips in {RAW_DIR}")

    if args.dry_run:
        print("Dry run — not uploading.")
        return

    total_saved = 0
    batch: dict[str, str] = {}

    for i, wav in enumerate(wav_files, 1):
        clip_id = wav.stem
        with open(wav, "rb") as f:
            batch[clip_id] = base64.b64encode(f.read()).decode("ascii")

        if len(batch) >= args.batch_size or i == len(wav_files):
            try:
                result = upload_batch(args.api_url, batch)
                saved = result.get("saved", 0)
                total_saved += saved
                print(f"  Batch {i}/{len(wav_files)}: uploaded {len(batch)}, saved {saved} new")
            except (URLError, Exception) as e:
                print(f"  Batch {i}/{len(wav_files)}: FAILED — {e}", file=sys.stderr)
            batch = {}

    if raw_files:
        batch = {}
        for i, wav in enumerate(raw_files, 1):
            clip_id = wav.stem
            with open(wav, "rb") as f:
                batch[clip_id] = base64.b64encode(f.read()).decode("ascii")

            if len(batch) >= args.batch_size or i == len(raw_files):
                try:
                    result = upload_batch(args.api_url, {}, raw_clips=batch)
                    saved = result.get("saved", 0)
                    total_saved += saved
                    print(f"  Raw batch {i}/{len(raw_files)}: uploaded {len(batch)}, saved {saved} new")
                except (URLError, Exception) as e:
                    print(f"  Raw batch {i}/{len(raw_files)}: FAILED — {e}", file=sys.stderr)
                batch = {}

    print(f"\nDone. Total new clips saved on server: {total_saved}")


if __name__ == "__main__":
    main()
