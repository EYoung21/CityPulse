"""Re-transcribe existing audio clips to add word-level timing data.

Two-phase approach to avoid Firestore quota issues:

Phase 1 (--phase transcribe): Transcribe all WAV files locally, save timings
  to a JSON file. No Firestore access needed — pure GPU work.

Phase 2 (--phase update): Read the JSON, batch-update Firestore documents.
  Minimal reads, batched writes with backoff.

Usage:
    export GOOGLE_APPLICATION_CREDENTIALS=.secrets/firebase-service-account.json

    # Phase 1: transcribe clips (GPU, no Firestore)
    python3 retranscribe_backlog.py --phase transcribe --clips-dir ./audio_clips/

    # Phase 2: push timings to Firestore
    python3 retranscribe_backlog.py --phase update

    # Or run both sequentially:
    python3 retranscribe_backlog.py --phase both --clips-dir ./audio_clips/
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import wave

import numpy as np

SAMPLE_RATE = 16000
TIMINGS_FILE = "retranscribe_timings.json"


def load_wav(path: str) -> np.ndarray | None:
    """Load a 16kHz mono WAV as float32."""
    try:
        with wave.open(path, "r") as wf:
            if wf.getnchannels() != 1 or wf.getsampwidth() != 2:
                return None
            frames = wf.readframes(wf.getnframes())
            return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    except Exception as e:
        print(f"  [WAV ERROR] {path}: {e}")
        return None


def transcribe_clip(model, audio: np.ndarray) -> list[dict] | None:
    """Run Whisper and return word timings, or None if no speech."""
    try:
        segments, _info = model.transcribe(
            audio,
            language="en",
            condition_on_previous_text=False,
            temperature=0.0,
            beam_size=5,
            patience=1.5,
            suppress_blank=True,
            no_speech_threshold=0.75,
            word_timestamps=True,
        )
        segments = list(segments)
        if not segments:
            return None

        no_speech_prob = max((s.no_speech_prob for s in segments), default=0)
        if no_speech_prob > 0.75:
            return None

        timings = []
        for seg in segments:
            if hasattr(seg, "words") and seg.words:
                for w in seg.words:
                    timings.append({
                        "word": w.word.strip(),
                        "start": round(w.start, 3),
                        "end": round(w.end, 3),
                    })
        return timings if timings else None
    except Exception as e:
        print(f"  [TRANSCRIBE ERROR] {e}")
        return None


# ── Phase 1: Transcribe ─────────────────────────────────────────────

def phase_transcribe(clips_dir: str, model_size: str, batch_size: int):
    """Transcribe WAV files and save clip_id → word_timings to JSON."""

    if not os.path.isdir(clips_dir):
        print(f"Clips directory not found: {clips_dir}")
        sys.exit(1)

    wav_files = sorted(f for f in os.listdir(clips_dir) if f.endswith(".wav"))
    print(f"Found {len(wav_files)} WAV files in {clips_dir}")

    # Load existing progress so we can resume
    existing: dict[str, list] = {}
    if os.path.exists(TIMINGS_FILE):
        with open(TIMINGS_FILE) as f:
            existing = json.load(f)
        print(f"Resuming: {len(existing)} clips already transcribed")

    todo = [f for f in wav_files if f.replace(".wav", "") not in existing]
    if batch_size > 0:
        todo = todo[:batch_size]
    print(f"Clips to transcribe this run: {len(todo)}")

    if not todo:
        print("Nothing to do!")
        return

    print(f"Loading Whisper model '{model_size}'...")
    from faster_whisper import WhisperModel
    try:
        model = WhisperModel(model_size, device="cuda", compute_type="float16")
        print("  (GPU mode: CUDA float16)")
    except Exception:
        model = WhisperModel(model_size, device="cpu", compute_type="int8", cpu_threads=4)
        print("  (CPU mode: int8)")

    processed = 0
    with_timings = 0
    t0 = time.time()

    for i, fname in enumerate(todo):
        clip_id = fname.replace(".wav", "")
        wav_path = os.path.join(clips_dir, fname)

        audio = load_wav(wav_path)
        if audio is None:
            existing[clip_id] = []
            processed += 1
            continue

        timings = transcribe_clip(model, audio)
        existing[clip_id] = timings or []
        processed += 1
        if timings:
            with_timings += 1

        if (i + 1) % 200 == 0 or i == len(todo) - 1:
            elapsed = time.time() - t0
            rate = (i + 1) / elapsed if elapsed > 0 else 0
            eta = (len(todo) - i - 1) / rate if rate > 0 else 0
            print(f"  [{i+1}/{len(todo)}] {with_timings} with timings | "
                  f"{rate:.1f} clips/s | ETA {eta/60:.0f}m")

            # Checkpoint every 200 clips
            with open(TIMINGS_FILE, "w") as f:
                json.dump(existing, f)

    # Final save
    with open(TIMINGS_FILE, "w") as f:
        json.dump(existing, f)

    elapsed = time.time() - t0
    print(f"\n=== Phase 1 complete ===")
    print(f"Processed: {processed} | With timings: {with_timings} | "
          f"Time: {elapsed/60:.1f}m ({elapsed/max(processed,1):.2f}s/clip)")
    print(f"Timings saved to {TIMINGS_FILE}")


# ── Phase 2: Update Firestore ───────────────────────────────────────

def phase_update(dry_run: bool):
    """Read timings JSON and batch-update Firestore incidents."""

    if not os.path.exists(TIMINGS_FILE):
        print(f"No timings file found at {TIMINGS_FILE}. Run --phase transcribe first.")
        sys.exit(1)

    with open(TIMINGS_FILE) as f:
        all_timings: dict[str, list] = json.load(f)

    # Only update clips that actually have timings
    clips_with_timings = {k: v for k, v in all_timings.items() if v}
    print(f"Loaded {len(all_timings)} clip entries, {len(clips_with_timings)} have word timings")

    if not clips_with_timings:
        print("No clips with timings to update!")
        return

    print("Connecting to Firestore...")
    import firebase_admin
    from firebase_admin import credentials, firestore

    cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if not cred_path:
        print("ERROR: Set GOOGLE_APPLICATION_CREDENTIALS env var")
        sys.exit(1)
    cred = credentials.Certificate(cred_path)
    firebase_admin.initialize_app(cred)
    db = firestore.client()

    clip_ids = list(clips_with_timings.keys())
    updated = 0
    not_found = 0
    already_done = 0
    errors = 0
    t0 = time.time()

    # Query in batches of 10 (smaller to avoid quota issues) with backoff
    batch_sz = 10
    for batch_start in range(0, len(clip_ids), batch_sz):
        batch = clip_ids[batch_start : batch_start + batch_sz]

        for attempt in range(5):
            try:
                from google.cloud.firestore_v1.base_query import FieldFilter
                docs = list(
                    db.collection("incidents")
                    .where(filter=FieldFilter("audio_clip", "in", batch))
                    .stream()
                )
                break
            except Exception as e:
                if "429" in str(e) or "Quota" in str(e):
                    wait = min(2 ** attempt * 5, 120)
                    print(f"  [QUOTA] backoff {wait}s (attempt {attempt+1})...")
                    time.sleep(wait)
                    continue
                print(f"  [QUERY ERROR] {e}")
                errors += len(batch)
                docs = []
                break
        else:
            print(f"  [GIVING UP] batch at {batch_start}")
            errors += len(batch)
            continue

        for doc in docs:
            data = doc.to_dict() or {}
            clip_id = data.get("audio_clip")
            if not clip_id or clip_id not in clips_with_timings:
                continue

            existing_wt = data.get("word_timings")
            if existing_wt and len(existing_wt) > 0:
                already_done += 1
                continue

            timings = clips_with_timings[clip_id]
            if dry_run:
                print(f"  [DRY-RUN] {doc.id}: {len(timings)} words")
                updated += 1
                continue

            for attempt in range(5):
                try:
                    db.collection("incidents").document(doc.id).update({
                        "word_timings": timings,
                    })
                    updated += 1
                    break
                except Exception as e:
                    if "429" in str(e) or "Quota" in str(e):
                        wait = min(2 ** attempt * 5, 120)
                        time.sleep(wait)
                        continue
                    print(f"  [UPDATE ERROR] {doc.id}: {e}")
                    errors += 1
                    break

        matched_ids = {d.to_dict().get("audio_clip") for d in docs if d.to_dict()}
        for cid in batch:
            if cid not in matched_ids:
                not_found += 1

        if (batch_start // batch_sz) % 50 == 0 and batch_start > 0:
            elapsed = time.time() - t0
            print(f"  ... {batch_start}/{len(clip_ids)} | "
                  f"updated={updated} already={already_done} missing={not_found} errors={errors}")

        time.sleep(0.5)

    elapsed = time.time() - t0
    print(f"\n=== Phase 2 {'(dry-run) ' if dry_run else ''}complete ===")
    print(f"Updated: {updated} | Already done: {already_done} | "
          f"Not in Firestore: {not_found} | Errors: {errors}")
    print(f"Time: {elapsed/60:.1f}m")


# ── Main ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Re-transcribe audio clips for word timings")
    parser.add_argument("--phase", choices=["transcribe", "update", "both"], default="both",
                        help="Which phase to run")
    parser.add_argument("--clips-dir", type=str, default="audio_clips",
                        help="Directory containing .wav clip files")
    parser.add_argument("--model", type=str, default="base",
                        help="Whisper model size (base, small, medium, large-v3)")
    parser.add_argument("--batch-size", type=int, default=0,
                        help="Max clips to transcribe (0 = all)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Phase 2: don't write to Firestore")
    args = parser.parse_args()

    if args.phase in ("transcribe", "both"):
        phase_transcribe(args.clips_dir, args.model, args.batch_size)

    if args.phase in ("update", "both"):
        phase_update(args.dry_run)


if __name__ == "__main__":
    main()
