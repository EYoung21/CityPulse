"""Backfill Broadcastify archives for the last N days.

Downloads 30-minute MP3 archive segments, transcribes with Whisper,
and POSTs to the ingest API (which stores as raw extractions — no LLM).

Processes most recent days first so you get recent data quickly.

Usage:
    python backfill_archives.py              # default: 180 days, all feeds
    python backfill_archives.py --days 7     # just last 7 days
    python backfill_archives.py --feed 4603  # single feed only

Requires:
    - config.yaml with Broadcastify credentials
    - faster-whisper, requests, numpy, scipy
    - The FastAPI server running (for /api/ingest)
"""

import argparse
import datetime
import json
import os
import re
import subprocess
import tempfile
import time
import uuid
import wave

import numpy as np
import requests
import yaml
from bs4 import BeautifulSoup
from faster_whisper import WhisperModel
from philly_pulse.preprocess import PIPELINE_VARIANTS, preprocess_audio

# ── Config ──────────────────────────────────────────────────────────

with open("config.yaml", "r", encoding="utf-8") as f:
    config = yaml.safe_load(f)

USERNAME = config["credentials"]["username"]
PASSWORD = config["credentials"]["password"]

MODEL_SIZE = config["tuning"].get("model_size", "base")
LANGUAGE = config["tuning"]["language"]
INITIAL_PROMPT = config["tuning"]["initial_prompt"]
BEAM_SIZE = config["tuning"].get("beam_size", 5)
NO_SPEECH_THRESHOLD = config["tuning"]["no_speech_threshold"]
FULL_BLOCK_PHRASES = config["post_generation_cleanup"]["full_block_phrases"]
CUTOFF_PHRASES = config["post_generation_cleanup"]["cutoff_phrases"]

PP_CFG = config.get("philly_pulse", {})
BRIDGE_URL = PP_CFG.get("bridge_url", "http://127.0.0.1:8765/api/ingest")

SAMPLE_RATE = 16000
AUDIO_CLIPS_FOLDER = "audio_clips/"
RAW_CLIPS_FOLDER = "audio_clips_raw/"
os.makedirs(AUDIO_CLIPS_FOLDER, exist_ok=True)
os.makedirs(RAW_CLIPS_FOLDER, exist_ok=True)

PROGRESS_FILE = "backfill_progress.json"

PHILLY_FEEDS = [
    {"feed_id": "4603",  "label": "PPD Citywide"},
    {"feed_id": "17310", "label": "PPD Central"},
    {"feed_id": "21297", "label": "PPD East"},
    {"feed_id": "45495", "label": "PPD Northeast"},
    {"feed_id": "18836", "label": "PPD Northwest"},
    {"feed_id": "15102", "label": "PPD South"},
    {"feed_id": "15195", "label": "PPD Southwest/West"},
    {"feed_id": "34250", "label": "PFD South Fire/Medics"},
    {"feed_id": "15747", "label": "PFD North Fire"},
    {"feed_id": "44308", "label": "SEPTA Transit Police"},
    {"feed_id": "13975", "label": "SEPTA Regional Rail"},
    {"feed_id": "13951", "label": "PA Turnpike Police East"},
    {"feed_id": "36323", "label": "Delaware Co Police Dispatch"},
    {"feed_id": "20795", "label": "Camden Co Fire/EMS Digital"},
]


def load_progress() -> dict:
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE, "r") as f:
            return json.load(f)
    return {}


def save_progress(progress: dict):
    with open(PROGRESS_FILE, "w") as f:
        json.dump(progress, f, indent=2)


def cleanup_text(text: str, duration: float) -> str | None:
    if re.fullmatch(r'[.\s]+', text):
        return None
    stripped = re.sub(r'[\W_]+', '', text).upper()
    if stripped and re.fullmatch(r'(BANG)+', stripped):
        return None
    if duration < 10.0:
        beep_patterns = ["BEEE", "BEEEE", "EEEE", "BEEP", "AAAA", "AAAAA"]
        upper = text.upper()
        if any(p in upper for p in beep_patterns) and len(text) > 10:
            return None
    if re.search(r'([A-Z])\1{10,}', text.upper()):
        return None
    if duration > 0 and len(text.split()) / duration > 8.0:
        return None
    lower = text.lower()
    for phrase in FULL_BLOCK_PHRASES:
        if phrase.lower() in lower:
            return None
    for phrase in CUTOFF_PHRASES:
        idx = lower.find(phrase.lower())
        if idx != -1:
            text = text[:idx].strip()
            break
    return text if text.strip() else None


def get_broadcastify_session() -> requests.Session:
    """Login to Broadcastify and return an authenticated session."""
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (PhillyPulse Backfill)"
    })

    login_url = "https://www.broadcastify.com/login/"
    resp = session.get(login_url)
    resp.raise_for_status()

    login_data = {
        "username": USERNAME,
        "password": PASSWORD,
        "action": "auth",
        "redirect": "/",
    }
    resp = session.post(login_url, data=login_data, allow_redirects=True)
    resp.raise_for_status()

    if "logout" not in resp.text.lower() and "my account" not in resp.text.lower():
        print("[WARN] Login may have failed — check credentials")

    return session


def fetch_archive_links(session: requests.Session, feed_id: str, day: str) -> list[dict]:
    """Fetch archive MP3 download links for a feed on a given day.

    Returns list of {"url": ..., "time_label": ...} dicts.
    """
    url = f"https://www.broadcastify.com/archives/feed/{feed_id}/?d={day}"
    resp = session.get(url, timeout=30)
    if resp.status_code == 404:
        return []
    resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")
    archives = []

    for link in soup.find_all("a", href=True):
        href = link["href"]
        if "/archives/download/" in href:
            full_url = href if href.startswith("http") else f"https://www.broadcastify.com{href}"
            time_label = link.get_text(strip=True) or "unknown"
            archives.append({"url": full_url, "time_label": time_label})

    return archives


def download_mp3(session: requests.Session, url: str, dest_path: str) -> bool:
    """Download an archive MP3 to a local file."""
    try:
        resp = session.get(url, stream=True, timeout=120)
        resp.raise_for_status()
        with open(dest_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)
        return True
    except Exception as e:
        print(f"    [DL ERROR] {e}")
        return False


def mp3_to_pcm(mp3_path: str) -> np.ndarray | None:
    """Convert MP3 to 16kHz mono float32 PCM using ffmpeg."""
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-i", mp3_path,
                "-f", "s16le", "-acodec", "pcm_s16le",
                "-ar", str(SAMPLE_RATE), "-ac", "1",
                "-loglevel", "quiet", "-",
            ],
            capture_output=True,
            timeout=300,
        )
        if result.returncode != 0:
            return None
        pcm_data = np.frombuffer(result.stdout, dtype=np.int16).astype(np.float32) / 32768.0
        return pcm_data if len(pcm_data) > SAMPLE_RATE else None  # Skip if < 1 second
    except Exception as e:
        print(f"    [FFMPEG ERROR] {e}")
        return None


def _save_wav(path: str, audio_f32: np.ndarray):
    pcm = (audio_f32 * 32767).astype(np.int16)
    with wave.open(path, "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm.tobytes())


def transcribe_and_post(
    model: WhisperModel,
    audio_data: np.ndarray,
    feed_id: str,
    feed_label: str,
    archive_timestamp: str,
):
    """Run all preprocessing variants, transcribe each, and POST to ingest."""

    # Split long archives into ~60s chunks
    chunk_seconds = 60
    chunk_samples = chunk_seconds * SAMPLE_RATE
    chunks = []
    if len(audio_data) > chunk_samples * 2:
        for i in range(0, len(audio_data), chunk_samples):
            chunk = audio_data[i : i + chunk_samples]
            if len(chunk) > SAMPLE_RATE:
                chunks.append(chunk)
    else:
        chunks = [audio_data]

    transcribed = 0
    for ci, chunk in enumerate(chunks):
        try:
            # Save raw clip
            raw_clip_id = uuid.uuid4().hex[:12]
            try:
                _save_wav(os.path.join(RAW_CLIPS_FOLDER, f"{raw_clip_id}.wav"), chunk)
            except Exception as e:
                print(f"    [RAW CLIP ERROR] {e}")
                raw_clip_id = None

            variants_list = []
            standard_text = None

            for vcfg in PIPELINE_VARIANTS:
                processed, meta = preprocess_audio(chunk, vcfg)
                duration = len(processed) / SAMPLE_RATE

                try:
                    segments, _info = model.transcribe(
                        processed,
                        language=LANGUAGE,
                        initial_prompt=INITIAL_PROMPT,
                        condition_on_previous_text=False,
                        temperature=0.0,
                        beam_size=BEAM_SIZE,
                        patience=1.5,
                        suppress_blank=True,
                        no_speech_threshold=NO_SPEECH_THRESHOLD,
                    )
                    segments = list(segments)
                    text = " ".join(s.text for s in segments).strip()

                    no_speech_prob = max((s.no_speech_prob for s in segments), default=0)
                    if no_speech_prob > NO_SPEECH_THRESHOLD:
                        continue

                    text = cleanup_text(text, duration)
                    if not text:
                        continue

                    clip_id = uuid.uuid4().hex[:12]
                    try:
                        _save_wav(os.path.join(AUDIO_CLIPS_FOLDER, f"{clip_id}.wav"), processed)
                    except Exception as e:
                        print(f"    [CLIP ERROR {vcfg.name}] {e}")
                        clip_id = None

                    variants_list.append({
                        "name": vcfg.name,
                        "audio_clip": clip_id,
                        "transcript": text,
                        "preprocess_meta": meta,
                        "whisper_meta": {
                            "no_speech_prob": round(no_speech_prob, 4),
                            "duration_s": round(duration, 2),
                        },
                    })

                    if vcfg.name == "standard":
                        standard_text = text

                except Exception as e:
                    print(f"    [VARIANT {vcfg.name} ERROR chunk {ci}] {e}")

            if not variants_list:
                continue

            if standard_text is None:
                standard_text = variants_list[0]["transcript"]

            payload: dict = {
                "text": standard_text,
                "timestamp": archive_timestamp,
                "feed_id": feed_id,
                "raw_audio_clip": raw_clip_id,
                "variants": variants_list,
            }

            try:
                resp = requests.post(BRIDGE_URL, json=payload, timeout=30)
                if resp.status_code == 200:
                    transcribed += 1
                else:
                    print(f"    [INGEST {resp.status_code}] {resp.text[:100]}")
            except Exception as e:
                print(f"    [INGEST ERROR] {e}")

        except Exception as e:
            print(f"    [CHUNK ERROR {ci}] {e}")

    return transcribed


def main():
    parser = argparse.ArgumentParser(description="Backfill Broadcastify archives")
    parser.add_argument("--days", type=int, default=180, help="How many days back to go (default: 180)")
    parser.add_argument("--feed", type=str, default=None, help="Single feed ID to process")
    parser.add_argument("--skip-existing", action="store_true", default=True, help="Skip already-processed feed+day combos")
    args = parser.parse_args()

    feeds = PHILLY_FEEDS
    if args.feed:
        feeds = [f for f in feeds if f["feed_id"] == args.feed]
        if not feeds:
            print(f"Unknown feed ID: {args.feed}")
            return

    print(f"=== PhillyPulse Archive Backfill ===")
    print(f"Feeds: {len(feeds)}, Days: {args.days}, Bridge: {BRIDGE_URL}")
    print(f"Loading Whisper model '{MODEL_SIZE}'...")

    model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8", cpu_threads=4)
    print("Model loaded.")

    print("Logging into Broadcastify...")
    session = get_broadcastify_session()
    print("Logged in.")

    progress = load_progress()
    today = datetime.date.today()
    total_transcribed = 0
    total_archives = 0

    # Process most recent days first
    for days_ago in range(1, args.days + 1):
        day = today - datetime.timedelta(days=days_ago)
        day_str = day.isoformat()

        for feed in feeds:
            feed_id = feed["feed_id"]
            feed_label = feed["label"]
            progress_key = f"{feed_id}_{day_str}"

            if args.skip_existing and progress.get(progress_key):
                continue

            print(f"\n[{day_str}] [{feed_label}] Fetching archives...")
            archives = fetch_archive_links(session, feed_id, day_str)

            if not archives:
                print(f"  No archives available.")
                progress[progress_key] = "no_archives"
                save_progress(progress)
                continue

            print(f"  Found {len(archives)} archive segments.")
            day_transcribed = 0

            for ai, archive in enumerate(archives):
                archive_url = archive["url"]
                time_label = archive["time_label"]
                archive_ts = f"{day_str}T{time_label}" if re.match(r'\d{2}:\d{2}', time_label) else f"{day_str}T00:00:00"

                with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
                    tmp_path = tmp.name

                try:
                    print(f"  [{ai+1}/{len(archives)}] Downloading {time_label}...", end=" ", flush=True)
                    if not download_mp3(session, archive_url, tmp_path):
                        continue

                    audio = mp3_to_pcm(tmp_path)
                    if audio is None:
                        print("(empty/error)")
                        continue

                    duration_min = len(audio) / SAMPLE_RATE / 60
                    print(f"({duration_min:.1f}min)", end=" ", flush=True)

                    count = transcribe_and_post(model, audio, feed_id, feed_label, archive_ts)
                    day_transcribed += count
                    total_transcribed += count
                    total_archives += 1
                    print(f"-> {count} transcripts")

                finally:
                    if os.path.exists(tmp_path):
                        os.unlink(tmp_path)

                time.sleep(0.5)  # Be polite to Broadcastify

            progress[progress_key] = f"done_{day_transcribed}"
            save_progress(progress)

        print(f"\n--- Day {day_str} complete. Running total: {total_transcribed} transcripts from {total_archives} archives ---")

    print(f"\n=== Backfill complete ===")
    print(f"Total: {total_transcribed} transcripts from {total_archives} archive segments")


if __name__ == "__main__":
    main()
