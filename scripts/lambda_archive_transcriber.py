#!/usr/bin/env python3
"""Lambda-side transcriber for the split-pipeline backfill.

Companion to `scripts/hetzner_archive_downloader.py`. Hetzner downloads
30-minute Broadcastify archive MP3s and scp's them (plus a sidecar JSON
of metadata) into $INCOMING_DIR. This daemon picks them up oldest first,
runs Whisper-large-v3-turbo on the GPU, runs the POSTed transcript
through the same `transcribe_and_post()` pipeline the monolith used (so
the per-chunk preprocessing variants, cleanup heuristics and ingest
retry logic are identical to the previous flow — single source of truth
in `backfill_archives.py`).

Why a daemon instead of a watchdog/FastAPI:
    inotify on a network filesystem is unreliable, and a FastAPI
    upload endpoint would mean opening a port (security) plus losing
    the natural at-least-once retry the spool dir gives us. A simple
    "list dir, sort by mtime, process oldest" loop is unkillable: a
    crash mid-job leaves the .mp3 + .json sidecar in place, and the
    next iteration picks up where we left off.

Sidecar protocol (the contract with the downloader):
    For each shipment Hetzner uploads two files into $INCOMING_DIR:
        <base>.mp3      (raw Broadcastify archive segment)
        <base>.json     {schema, city, feed_id, feed_label,
                         segment_id, archive_ts, time_label,
                         downloaded_at, source, downloader}
    The .mp3 is uploaded FIRST and the .json is uploaded LAST, so
    sidecar presence == "MP3 fully transferred". A .mp3 without a
    matching .json is treated as in-flight; we skip it on this pass
    and pick it up next pass once the sidecar lands.

Outcomes per file:
    success → both files deleted (we don't keep MP3s once the LLM
              has had its way with them; Firestore is the system of
              record from here on out).
    failure → both files moved to $FAILED_DIR for manual inspection.
              We never silently delete failure cases; debugging
              regressions in the LLM/preprocess chain is worth the
              disk it takes to keep the corpses around.
    janitor → orphan .mp3 files older than $ORPHAN_AGE_S without a
              sidecar get moved to $FAILED_DIR/orphans on each pass.

Required env (set in /etc/citypulse-archive-transcriber.env):
    PP_BRIDGE_URL                       https://api.phlpulse.com/api/ingest
    INCOMING_DIR                        /var/spool/citypulse-incoming
    FAILED_DIR                          /var/spool/citypulse-failed
    WHISPER_MODEL_SIZE                  large-v3-turbo
    TRANSCRIBER_HEARTBEAT               /var/log/citypulse-transcriber.heartbeat
    TRANSCRIBER_POLL_INTERVAL_S         5
    TRANSCRIBER_ORPHAN_AGE_S            3600  (orphan .mp3 → /failed)
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import shutil
import signal
import sys
import time
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

# Pull the transcribe + post + ffmpeg helpers from the monolithic
# backfill so per-chunk preprocessing, cleanup phrases and ingest
# retry/backoff stay identical to the existing live flow. Importing
# the module is cheap — its module-level side effects are just
# mkdir()s for audio_clips/ folders and env-var parsing, no Whisper
# load until main() (which we don't call).
import backfill_archives as ba  # noqa: E402

INCOMING_DIR = Path(os.environ.get("INCOMING_DIR", "/var/spool/citypulse-incoming"))
FAILED_DIR = Path(os.environ.get("FAILED_DIR", "/var/spool/citypulse-failed"))
HEARTBEAT_PATH = Path(os.environ.get("TRANSCRIBER_HEARTBEAT", "/var/log/citypulse-transcriber.heartbeat"))
POLL_INTERVAL_S = float(os.environ.get("TRANSCRIBER_POLL_INTERVAL_S", "5"))
ORPHAN_AGE_S = float(os.environ.get("TRANSCRIBER_ORPHAN_AGE_S", "3600"))
JANITOR_INTERVAL_S = float(os.environ.get("TRANSCRIBER_JANITOR_INTERVAL_S", "600"))

INCOMING_DIR.mkdir(parents=True, exist_ok=True)
FAILED_DIR.mkdir(parents=True, exist_ok=True)
(FAILED_DIR / "orphans").mkdir(parents=True, exist_ok=True)


# ── Heartbeat ──────────────────────────────────────────────────────


def heartbeat(state: dict) -> None:
    try:
        HEARTBEAT_PATH.parent.mkdir(parents=True, exist_ok=True)
        with HEARTBEAT_PATH.open("w") as f:
            json.dump({
                "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                **state,
            }, f)
    except OSError as e:
        print(f"[heartbeat] couldn't write {HEARTBEAT_PATH}: {e}", flush=True)


# ── Per-city LLM/initial-prompt overlay ────────────────────────────
# Every city has its own Whisper initial_prompt so the acoustic model
# resolves region-specific vocabulary correctly. The monolithic backfill
# loaded this once at startup because it was single-city. We have to
# look it up per-job now since the daemon services every city's queue.

_CITY_PROMPTS: dict[str, str] = {}


def _load_city_prompts() -> None:
    for cfg in sorted(REPO_ROOT.glob("cities/*/config.yaml")):
        try:
            data = yaml.safe_load(cfg.read_text()) or {}
            slug = (data.get("city") or {}).get("slug") or cfg.parent.name
            prompt = (data.get("tuning") or {}).get("initial_prompt")
            if prompt:
                _CITY_PROMPTS[slug] = prompt
        except Exception as e:
            print(f"[WARN] could not load prompt for {cfg}: {e}", flush=True)


# ── File queue ─────────────────────────────────────────────────────


def _list_jobs() -> list[Path]:
    """Return sidecar paths in oldest-first order. Sidecar presence
    means the matching MP3 is fully transferred (Hetzner uploads the
    .mp3 first, sidecar last). MP3s without sidecars are still in
    flight — janitor sweeps long-stale ones to /failed/orphans."""
    sidecars = sorted(INCOMING_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime)
    return sidecars


def _move_pair_to_failed(sidecar: Path, mp3: Path, reason: str) -> None:
    dest = FAILED_DIR / sidecar.name
    try:
        if mp3.exists():
            shutil.move(str(mp3), str(FAILED_DIR / mp3.name))
    except Exception as e:
        print(f"  [failed-move mp3] {e}", flush=True)
    try:
        with open(sidecar, "r+") as f:
            try:
                meta = json.load(f)
            except Exception:
                meta = {}
        meta["failed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        meta["failed_reason"] = reason
        sidecar.write_text(json.dumps(meta, indent=2))
        shutil.move(str(sidecar), str(dest))
    except Exception as e:
        print(f"  [failed-move sidecar] {e}", flush=True)


def _delete_pair(sidecar: Path, mp3: Path) -> None:
    for p in (mp3, sidecar):
        try:
            if p.exists():
                p.unlink()
        except Exception as e:
            print(f"  [delete] {p}: {e}", flush=True)


def _janitor() -> None:
    """Move orphan .mp3 files (no sidecar) older than ORPHAN_AGE_S
    to /failed/orphans. Hetzner's atomic-upload protocol guarantees a
    sidecar lands within seconds of the MP3, so anything pending an hour
    later is a dead transfer."""
    now = time.time()
    moved = 0
    for mp3 in INCOMING_DIR.glob("*.mp3"):
        sidecar = mp3.with_suffix(".json")
        if sidecar.exists():
            continue
        try:
            age = now - mp3.stat().st_mtime
        except OSError:
            continue
        if age < ORPHAN_AGE_S:
            continue
        try:
            shutil.move(str(mp3), str(FAILED_DIR / "orphans" / mp3.name))
            moved += 1
        except Exception as e:
            print(f"  [janitor] {mp3}: {e}", flush=True)
    if moved:
        print(f"  [janitor] moved {moved} orphan MP3s to {FAILED_DIR/'orphans'}", flush=True)
    # Also sweep .partial debris from interrupted scp's older than 1h.
    for partial in INCOMING_DIR.glob("*.partial"):
        try:
            age = now - partial.stat().st_mtime
        except OSError:
            continue
        if age > 3600:
            try:
                partial.unlink()
            except Exception:
                pass


# ── Whisper model ──────────────────────────────────────────────────


_model = None


def _get_model():
    """Lazy-load Whisper. GPU if available, CPU int8 fallback otherwise.
    Mirrors the boot logic in backfill_archives.main()."""
    global _model
    if _model is not None:
        return _model
    from faster_whisper import WhisperModel
    try:
        import ctranslate2
        cuda_ok = "float16" in ctranslate2.get_supported_compute_types("cuda")
    except Exception:
        cuda_ok = False
    size = ba.MODEL_SIZE
    if cuda_ok:
        print(f"  [whisper] loading {size} on CUDA float16", flush=True)
        _model = WhisperModel(size, device="cuda", compute_type="float16")
    else:
        print(f"  [whisper] loading {size} on CPU int8 (no CUDA)", flush=True)
        _model = WhisperModel(size, device="cpu", compute_type="int8", cpu_threads=4)
    return _model


# ── Per-job pipeline ───────────────────────────────────────────────


def process_one(sidecar: Path) -> tuple[str, int]:
    """Whisper + LLM-via-/api/ingest one shipment. Returns (outcome, transcripts).

    outcome ∈ {ok, no_audio, llm_skip, post_fail, missing_mp3, bad_sidecar}
    """
    mp3 = sidecar.with_suffix(".mp3")
    if not mp3.exists():
        # Sidecar landed but mp3 vanished — race / manual delete. Treat as
        # bad and move sidecar aside so we don't loop on it.
        _move_pair_to_failed(sidecar, mp3, "missing_mp3")
        return "missing_mp3", 0

    try:
        meta = json.loads(sidecar.read_text())
    except Exception as e:
        print(f"  [bad sidecar] {sidecar.name}: {e}", flush=True)
        _move_pair_to_failed(sidecar, mp3, f"bad_sidecar: {e}")
        return "bad_sidecar", 0

    city = (meta.get("city") or "philly").strip()
    feed_id = str(meta.get("feed_id") or "")
    feed_label = meta.get("feed_label") or feed_id
    archive_ts = meta.get("archive_ts") or ""

    # Per-city Whisper initial_prompt swap. We mutate the module-global
    # because backfill_archives.transcribe_and_post() reads
    # ba.INITIAL_PROMPT directly. Single-threaded daemon → no race.
    prompt = _CITY_PROMPTS.get(city)
    if prompt:
        ba.INITIAL_PROMPT = prompt

    audio = ba.mp3_to_pcm(str(mp3))
    if audio is None:
        print(f"  [no audio] {mp3.name}", flush=True)
        _move_pair_to_failed(sidecar, mp3, "ffmpeg_failed_or_silent")
        return "no_audio", 0

    duration_min = len(audio) / ba.SAMPLE_RATE / 60.0
    print(
        f"  [{city}/{feed_label}] {mp3.name} ({duration_min:.1f}min) → transcribing",
        flush=True,
    )

    model = _get_model()
    try:
        n_posted = ba.transcribe_and_post(
            model,
            audio,
            feed_id,
            feed_label,
            archive_ts,
            city=city,
        )
    except Exception as e:
        print(f"  [pipeline error] {mp3.name}: {e}", flush=True)
        _move_pair_to_failed(sidecar, mp3, f"pipeline_error: {e!r}")
        return "post_fail", 0

    print(f"    -> {n_posted} transcripts ingested", flush=True)
    _delete_pair(sidecar, mp3)
    return "ok", n_posted


# ── Main loop ──────────────────────────────────────────────────────


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--once", action="store_true",
                   help="Drain the queue once and exit (default: loop forever)")
    p.add_argument("--limit", type=int, default=None,
                   help="Process at most N jobs then exit (testing)")
    args = p.parse_args()

    print(
        f"Lambda transcriber: incoming={INCOMING_DIR} failed={FAILED_DIR} "
        f"poll={POLL_INTERVAL_S}s",
        flush=True,
    )
    print(f"  PP_BRIDGE_URL: {ba.BRIDGE_URL}", flush=True)
    print(f"  Whisper model: {ba.MODEL_SIZE}", flush=True)
    _load_city_prompts()
    print(f"  City prompts loaded: {sorted(_CITY_PROMPTS.keys())}", flush=True)
    heartbeat({"phase": "boot", "incoming": str(INCOMING_DIR)})

    def _on_term(_sig, _frm):
        heartbeat({"phase": "shutdown_clean"})
        sys.exit(0)
    signal.signal(signal.SIGTERM, _on_term)
    signal.signal(signal.SIGINT, _on_term)

    # Pre-load the model so the first job doesn't pay the cold-start
    # penalty mid-stream (and so a missing nvidia-cudnn surfaces in the
    # service log immediately, not on first-job-after-an-hour).
    try:
        _get_model()
    except Exception as e:
        print(f"[FATAL] could not load Whisper model: {e}", file=sys.stderr)
        heartbeat({"phase": "fatal_model_load_failed", "error": str(e)})
        return 5

    processed = 0
    last_janitor = 0.0
    cycle = 0
    counts: dict[str, int] = {}
    while True:
        cycle += 1
        jobs = _list_jobs()
        depth = len(jobs)
        if not jobs:
            heartbeat({"phase": "idle", "queue_depth": 0,
                       "processed_total": processed, "outcomes": counts})
            if args.once:
                return 0
            time.sleep(POLL_INTERVAL_S)
            if time.time() - last_janitor > JANITOR_INTERVAL_S:
                _janitor()
                last_janitor = time.time()
            continue

        sidecar = jobs[0]
        heartbeat({
            "phase": f"processing {sidecar.name}",
            "queue_depth": depth,
            "processed_total": processed,
            "outcomes": counts,
        })
        outcome, n = process_one(sidecar)
        counts[outcome] = counts.get(outcome, 0) + 1
        processed += 1

        if processed % 10 == 0 or outcome != "ok":
            print(
                f"[cycle {cycle}] processed={processed} queue={depth} "
                f"counts={counts}",
                flush=True,
            )

        if args.limit is not None and processed >= args.limit:
            print(f"[done] hit --limit {args.limit}; exiting", flush=True)
            return 0

        if time.time() - last_janitor > JANITOR_INTERVAL_S:
            _janitor()
            last_janitor = time.time()


if __name__ == "__main__":
    sys.exit(main())
