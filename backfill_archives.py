"""Backfill Broadcastify archives.

Downloads 30-minute MP3 archive segments, transcribes with Whisper,
and POSTs to the ingest API.

Processes most recent days first so you get recent data quickly.

Usage:
    python backfill_archives.py --days 30 --feed 4603
    python backfill_archives.py --config cities/chattanooga/config.yaml --days 30
    python backfill_archives.py --day-list days.txt --feed 4603

Requires:
    - config.yaml with Broadcastify credentials
    - faster-whisper, requests, numpy, scipy
    - The FastAPI server running (for /api/ingest)
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import random
import re
import subprocess
import tempfile
import time
import uuid
import wave

import numpy as np
import requests
import yaml
from faster_whisper import WhisperModel
from philly_pulse.preprocess import PIPELINE_VARIANTS, preprocess_audio

# ── Config ──────────────────────────────────────────────────────────
# Two ways to configure the backfill:
#   1. Local dev / Firebird-era flow: drop a config.yaml next to this
#      script with credentials, tuning, and post-generation-cleanup.
#   2. Lambda flow (what scripts/install_lambda_backfill.sh sets up):
#      no config.yaml on disk; credentials and bridge URL come from env
#      (BROADCASTIFY_USERNAME / BROADCASTIFY_PASSWORD / PP_BRIDGE_URL),
#      and the per-city YAML in cities/<slug>/config.yaml supplies the
#      `feeds` list + tuning.initial_prompt. The tuning/cleanup defaults
#      below replace the heavyweight root config.yaml so this script no
#      longer requires it to import.

if os.path.exists("config.yaml"):
    with open("config.yaml", "r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}
else:
    config = {}

_creds = config.get("credentials", {})
USERNAME = os.environ.get("BROADCASTIFY_USERNAME") or _creds.get("username", "")
PASSWORD = os.environ.get("BROADCASTIFY_PASSWORD") or _creds.get("password", "")

_tuning = config.get("tuning", {})
MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE") or _tuning.get(
    "model_size", "large-v3-turbo"
)
LANGUAGE = _tuning.get("language", "en")
INITIAL_PROMPT = _tuning.get(
    "initial_prompt",
    # Generic fallback. Per-city configs override via _load_city_config.
    "Police, fire, and EMS radio dispatch. Short clipped phrases. "
    "Numbers spoken separately.",
)
BEAM_SIZE = int(_tuning.get("beam_size", 5))
NO_SPEECH_THRESHOLD = float(_tuning.get("no_speech_threshold", 0.75))

_cleanup = config.get("post_generation_cleanup", {})
# Whisper hallucination boilerplate that shows up across feeds when audio
# is silent or near-silent; safe defaults so this script no longer needs
# the giant root config.yaml just to start.
FULL_BLOCK_PHRASES = _cleanup.get(
    "full_block_phrases",
    [
        "CastingWords", "ESO", "Rev.com", "amara.org", "amara",
        "ESA, Inc.", "U.S. Department of", "Transcripts translated by",
        "Transcription Outsourcing",
    ],
)
CUTOFF_PHRASES = _cleanup.get(
    "cutoff_phrases",
    [
        "We'll be right back", "We will be right back",
        "Thank you for watching", "Thanks for watching",
        "Stay tuned", "Commercial break",
        "Transcription by", "Translation by", "Captions by",
        "Subtitle", "Subtitles",
        "the following is a", "this is a test",
        "end of transmission", "end of message",
    ],
)

PP_CFG = config.get("philly_pulse", {})
BRIDGE_URL = (
    os.environ.get("PP_BRIDGE_URL")
    or PP_CFG.get("bridge_url")
    or "https://api.phlpulse.com/api/ingest"
)

SAMPLE_RATE = 16000
AUDIO_CLIPS_FOLDER = "audio_clips/"
RAW_CLIPS_FOLDER = "audio_clips_raw/"
os.makedirs(AUDIO_CLIPS_FOLDER, exist_ok=True)
os.makedirs(RAW_CLIPS_FOLDER, exist_ok=True)

PROGRESS_DIR = "backfill_progress"
os.makedirs(PROGRESS_DIR, exist_ok=True)

# ── Rate limiting / backoff ─────────────────────────────────────────
# Broadcastify enforces an undocumented per-account daily download cap.
# Once hit, every request returns 429 "Download limit exceeded" until
# the quota resets (likely midnight US-Eastern).

# Defaults are tuned for the Premium account flow on Lambda: Premium has
# a much higher per-account quota, so we drop the per-segment cooldown
# from 45s → 8s. All knobs are env-overridable so a free-tier user can
# still slow it back down.
DOWNLOAD_DELAY_BASE = float(os.environ.get("BACKFILL_DELAY_BASE", "8"))
DOWNLOAD_DELAY_JITTER = float(os.environ.get("BACKFILL_DELAY_JITTER", "3"))
BACKOFF_BASE = float(os.environ.get("BACKFILL_BACKOFF_BASE", "60"))
BACKOFF_MULTIPLIER = float(os.environ.get("BACKFILL_BACKOFF_MULT", "2"))
BACKOFF_MAX = float(os.environ.get("BACKFILL_BACKOFF_MAX", "1800"))
BACKOFF_JITTER_FRAC = 0.25
MAX_RETRIES_PER_REQUEST = int(os.environ.get("BACKFILL_MAX_RETRIES", "6"))
CONSECUTIVE_429_ABORT = int(os.environ.get("BACKFILL_429_ABORT", "8"))

_consecutive_429_count = 0


class QuotaExhaustedError(Exception):
    """Raised when the daily download cap appears to be hit."""


def _jittered_delay(base: float, jitter_frac: float = 0.25) -> float:
    """Add decorrelated jitter: uniform in [base*(1-j), base*(1+j)]."""
    lo = base * (1.0 - jitter_frac)
    hi = base * (1.0 + jitter_frac)
    return random.uniform(lo, hi)


def _backoff_delay(attempt: int) -> float:
    """Exponential backoff with jitter, capped at BACKOFF_MAX."""
    raw = min(BACKOFF_BASE * (BACKOFF_MULTIPLIER ** attempt), BACKOFF_MAX)
    return _jittered_delay(raw, BACKOFF_JITTER_FRAC)


def _record_429():
    """Track consecutive 429s; raise QuotaExhaustedError if too many."""
    global _consecutive_429_count
    _consecutive_429_count += 1
    if _consecutive_429_count >= CONSECUTIVE_429_ABORT:
        raise QuotaExhaustedError(
            f"{CONSECUTIVE_429_ABORT} consecutive 429s — daily download quota "
            f"appears exhausted. Stopping to avoid wasting time."
        )


def _record_success():
    global _consecutive_429_count
    _consecutive_429_count = 0


def _download_delay():
    """Sleep between successful downloads with jitter."""
    delay = DOWNLOAD_DELAY_BASE + random.uniform(-DOWNLOAD_DELAY_JITTER, DOWNLOAD_DELAY_JITTER)
    time.sleep(max(5, delay))

# ── Per-city config overlay ──────────────────────────────────────

def _load_city_config(path: str | None) -> dict:
    if path and os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    return {}

_DEFAULT_PHILLY_FEEDS = [
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
    {"feed_id": "36323", "label": "Delaware Co Police Dispatch"},
    {"feed_id": "46438", "label": "DelCo Fire/EMS - Countywide Ops"},
    {"feed_id": "24104", "label": "Chester Co Law Enforcement Dispatch"},
    {"feed_id": "10489", "label": "MontCo Fire and EMS - East"},
    {"feed_id": "25767", "label": "MontCo Police, Fire and EMS - Region 3"},
]


# ── Progress tracking (per-feed, per-segment) ────────────────────

def _progress_path(feed_id: str) -> str:
    return os.path.join(PROGRESS_DIR, f"{feed_id}.json")


def load_progress(feed_id: str) -> dict:
    path = _progress_path(feed_id)
    if os.path.exists(path):
        with open(path, "r") as f:
            return json.load(f)
    return {}


def save_progress(feed_id: str, progress: dict):
    path = _progress_path(feed_id)
    with open(path, "w") as f:
        json.dump(progress, f, indent=2)


# ── Text cleanup ─────────────────────────────────────────────────

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


# ── Broadcastify session ─────────────────────────────────────────

def get_broadcastify_session() -> requests.Session:
    """Login to Broadcastify and return an authenticated session."""
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    })

    login_url = "https://www.broadcastify.com/login/"
    session.get(login_url)

    login_data = {
        "username": USERNAME,
        "password": PASSWORD,
        "action": "auth",
        "redirect": "https://www.broadcastify.com",
    }
    resp = session.post(login_url, data=login_data, allow_redirects=True)
    resp.raise_for_status()

    if "bcfyuser1" not in session.cookies.get_dict():
        print("[WARN] Login may have failed — no auth cookie set")

    return session


# ── Broadcastify API with exponential backoff ───────────────────

def fetch_archive_links(session: requests.Session, feed_id: str, day: str) -> list[dict]:
    """Fetch archive segments for a feed on a given day.

    Uses exponential backoff with jitter on 429.  Raises
    QuotaExhaustedError if the global consecutive-429 counter trips.
    """
    api_url = f"https://www.broadcastify.com/archives/api/archives.php?feedId={feed_id}&date={day}"

    for attempt in range(MAX_RETRIES_PER_REQUEST + 1):
        try:
            resp = session.get(api_url, timeout=30)
            if resp.status_code == 429:
                _record_429()
                if attempt < MAX_RETRIES_PER_REQUEST:
                    wait = _backoff_delay(attempt)
                    print(
                        f"  [429 archive list] backoff {wait:.0f}s "
                        f"(attempt {attempt+1}/{MAX_RETRIES_PER_REQUEST})",
                        flush=True,
                    )
                    time.sleep(wait)
                    continue
                print(
                    f"  [429] Giving up on archive list after {MAX_RETRIES_PER_REQUEST} retries",
                    flush=True,
                )
                return []
            if resp.status_code != 200:
                return []
            _record_success()
            data = resp.json()
        except QuotaExhaustedError:
            raise
        except Exception as e:
            print(f"  [ARCHIVE LIST ERROR] {e}")
            if attempt < MAX_RETRIES_PER_REQUEST:
                time.sleep(_backoff_delay(attempt))
                continue
            return []
        break

    archives = []
    for item in data.get("archives", []):
        aid = item.get("id", "")
        dl_url = f"https://www.broadcastify.com/archives/download/{aid}"
        time_label = item.get("start", "00:00")
        archives.append({
            "url": dl_url,
            "time_label": time_label,
            "startTs": item.get("startTs", 0),
            "id": aid,
        })

    return archives


def download_mp3(session: requests.Session, url: str, dest_path: str) -> bool:
    """Download an archive MP3 with exponential backoff + jitter.

    Raises QuotaExhaustedError if consecutive 429s trip the global counter.
    """
    for attempt in range(MAX_RETRIES_PER_REQUEST + 1):
        try:
            resp = session.get(url, stream=True, timeout=120)
            if resp.status_code == 429:
                _record_429()
                if attempt < MAX_RETRIES_PER_REQUEST:
                    wait = _backoff_delay(attempt)
                    # Newline (not end=" ") so the runner's stdout pump
                    # sees the line immediately and the heartbeat reflects
                    # current activity even during long backoff sleeps.
                    print(
                        f"    [429 download] backoff {wait:.0f}s "
                        f"(attempt {attempt+1}/{MAX_RETRIES_PER_REQUEST})",
                        flush=True,
                    )
                    time.sleep(wait)
                    continue
                print("    [429] Giving up after retries", flush=True)
                return False
            resp.raise_for_status()
            with open(dest_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=8192):
                    f.write(chunk)
            _record_success()
            return True
        except QuotaExhaustedError:
            raise
        except requests.exceptions.HTTPError as e:
            if "429" in str(e):
                _record_429()
                if attempt < MAX_RETRIES_PER_REQUEST:
                    wait = _backoff_delay(attempt)
                    print(f"    [429 download] backoff {wait:.0f}s", flush=True)
                    time.sleep(wait)
                    continue
            print(f"[DL ERROR] {e}")
            return False
        except Exception as e:
            print(f"[DL ERROR] {e}")
            if attempt < MAX_RETRIES_PER_REQUEST:
                time.sleep(_backoff_delay(attempt))
                continue
            return False
    return False


# ── Audio conversion ─────────────────────────────────────────────

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
        return pcm_data if len(pcm_data) > SAMPLE_RATE else None
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


# ── Transcription + ingest ───────────────────────────────────────

def transcribe_and_post(
    model: WhisperModel,
    audio_data: np.ndarray,
    feed_id: str,
    feed_label: str,
    archive_timestamp: str,
    city: str = "philly",
):
    """Run preprocessing, transcribe, and POST to ingest."""
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

    # Parse the archive's start timestamp once so we can advance per chunk.
    # Each chunk represents `chunk_seconds` of audio after the previous, so
    # we increment the per-chunk reported_at accordingly. Without this, all
    # chunks within a 30-min archive share one timestamp and the server's
    # adjacent-radio-context query (60s window on same feed_id) would never
    # find sibling chunks. See plan: adjacent_radio_context.
    try:
        _archive_dt = datetime.datetime.fromisoformat(
            archive_timestamp.replace("Z", "+00:00")
        )
    except (ValueError, TypeError):
        _archive_dt = None

    transcribed = 0
    for ci, chunk in enumerate(chunks):
        if _archive_dt is not None:
            chunk_ts = (_archive_dt + datetime.timedelta(seconds=ci * chunk_seconds)).isoformat()
        else:
            chunk_ts = archive_timestamp
        try:
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
                        word_timestamps=True,
                    )
                    segments = list(segments)
                    text = " ".join(s.text for s in segments).strip()

                    no_speech_prob = max((s.no_speech_prob for s in segments), default=0)
                    if no_speech_prob > NO_SPEECH_THRESHOLD:
                        continue

                    text = cleanup_text(text, duration)
                    if not text:
                        continue

                    word_timings = []
                    for seg in segments:
                        if hasattr(seg, "words") and seg.words:
                            for w in seg.words:
                                word_timings.append({
                                    "word": w.word.strip(),
                                    "start": round(w.start, 3),
                                    "end": round(w.end, 3),
                                })

                    clip_id = uuid.uuid4().hex[:12]
                    try:
                        _save_wav(os.path.join(AUDIO_CLIPS_FOLDER, f"{clip_id}.wav"), processed)
                    except Exception as e:
                        print(f"    [CLIP ERROR {vcfg.name}] {e}")
                        clip_id = None

                    variant_entry = {
                        "name": vcfg.name,
                        "audio_clip": clip_id,
                        "transcript": text,
                        "preprocess_meta": meta,
                        "whisper_meta": {
                            "no_speech_prob": round(no_speech_prob, 4),
                            "duration_s": round(duration, 2),
                        },
                    }
                    if word_timings:
                        variant_entry["word_timings"] = word_timings
                    variants_list.append(variant_entry)

                    if vcfg.name == "aggressive":
                        standard_text = text

                except Exception as e:
                    print(f"    [VARIANT {vcfg.name} ERROR chunk {ci}] {e}")

            if not variants_list:
                continue

            if standard_text is None:
                standard_text = variants_list[0]["transcript"]

            payload: dict = {
                "text": standard_text,
                "timestamp": chunk_ts,
                "feed_id": feed_id,
                "feed_label": feed_label,
                "raw_audio_clip": raw_clip_id,
                "variants": variants_list,
                "city": city,
            }

            # Retry on transient backend pressure. The Hetzner box only has
            # 2GB RAM and the philly-pulse-api uvicorn process can briefly
            # OOM-kill itself when backfill traffic stacks up on top of
            # live ingest, returning 502/504 from nginx for a few seconds
            # while systemd restarts it. Without this retry every transcript
            # caught in that window was dropped on the floor permanently
            # (see /var/log/citypulse-backfill.log "[INGEST 502]" runs).
            max_attempts = 6
            base_backoff = 4.0
            for attempt in range(1, max_attempts + 1):
                try:
                    resp = requests.post(BRIDGE_URL, json=payload, timeout=60)
                    sc = resp.status_code
                    if sc == 200:
                        transcribed += 1
                        break
                    if sc in (429, 502, 503, 504):
                        if attempt == max_attempts:
                            print(f"    [INGEST {sc}] gave up after {attempt} attempts: {resp.text[:80]}")
                            break
                        wait = min(60.0, base_backoff * (2 ** (attempt - 1))) + random.uniform(0, 1.5)
                        print(f"    [INGEST {sc}] backoff {wait:.1f}s ({attempt}/{max_attempts})")
                        time.sleep(wait)
                        continue
                    print(f"    [INGEST {sc}] {resp.text[:100]}")
                    break
                except requests.exceptions.RequestException as e:
                    if attempt == max_attempts:
                        print(f"    [INGEST ERROR] gave up after {attempt} attempts: {e}")
                        break
                    wait = min(60.0, base_backoff * (2 ** (attempt - 1))) + random.uniform(0, 1.5)
                    print(f"    [INGEST ERROR] {e!s} — backoff {wait:.1f}s ({attempt}/{max_attempts})")
                    time.sleep(wait)
                except Exception as e:
                    print(f"    [INGEST ERROR] non-retryable: {e}")
                    break

            # Tiny inter-transcript delay so a single archive's 50-100
            # transcripts don't slam the 2GB Hetzner box all at once.
            time.sleep(0.6)

        except Exception as e:
            print(f"    [CHUNK ERROR {ci}] {e}")

    return transcribed


# ── Day list helpers ─────────────────────────────────────────────

def load_day_list(path: str) -> list[str]:
    """Read a file of YYYY-MM-DD dates, one per line."""
    with open(path, "r") as f:
        return [line.strip() for line in f if line.strip() and not line.startswith("#")]


def generate_days_range(days: int) -> list[str]:
    """Generate a contiguous list of the last N days (most recent first)."""
    today = datetime.date.today()
    return [(today - datetime.timedelta(days=d)).isoformat() for d in range(1, days + 1)]


# ── Main ─────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Backfill Broadcastify archives")
    parser.add_argument("--days", type=int, default=None, help="How many days back to go")
    parser.add_argument("--day-list", type=str, default=None, help="File with specific dates to process (one YYYY-MM-DD per line)")
    parser.add_argument("--feed", type=str, default=None, help="Single feed ID to process")
    parser.add_argument("--skip-existing", action="store_true", default=True, help="Skip already-processed feed+day combos")
    parser.add_argument("--config", type=str, default=None,
                        help="Path to a city config YAML (e.g. cities/chattanooga/config.yaml)")
    args = parser.parse_args()

    # Load city config overlay for feeds and initial_prompt
    city_config = _load_city_config(args.config)
    city_name = city_config.get("city", {}).get("name", "Philadelphia")
    city_slug = city_config.get("city", {}).get("slug") or (
        os.path.basename(os.path.dirname(args.config)) if args.config else "philly"
    )

    # Override initial_prompt from city config if present
    global INITIAL_PROMPT
    city_prompt = city_config.get("tuning", {}).get("initial_prompt")
    if city_prompt:
        INITIAL_PROMPT = city_prompt

    if args.day_list:
        day_strings = load_day_list(args.day_list)
        print(f"Loaded {len(day_strings)} dates from {args.day_list}")
    elif args.days:
        day_strings = generate_days_range(args.days)
    else:
        day_strings = generate_days_range(180)

    feeds = city_config.get("feeds", _DEFAULT_PHILLY_FEEDS)
    if args.feed:
        feeds = [f for f in feeds if f["feed_id"] == args.feed]
        if not feeds:
            print(f"Unknown feed ID: {args.feed}")
            return

    print(f"=== {city_name} Pulse Archive Backfill ===")
    print(f"Feeds: {len(feeds)}, Days: {len(day_strings)}, Bridge: {BRIDGE_URL}")
    print(f"Rate-limit settings: {DOWNLOAD_DELAY_BASE}s±{DOWNLOAD_DELAY_JITTER}s between downloads, "
          f"backoff {BACKOFF_BASE}s×{BACKOFF_MULTIPLIER} (max {BACKOFF_MAX}s), "
          f"abort after {CONSECUTIVE_429_ABORT} consecutive 429s")
    print(f"Loading Whisper model '{MODEL_SIZE}'...")

    try:
        import ctranslate2
        cuda_ok = "float16" in ctranslate2.get_supported_compute_types("cuda")
    except Exception:
        cuda_ok = False

    if cuda_ok:
        model = WhisperModel(MODEL_SIZE, device="cuda", compute_type="float16")
        print("  (GPU mode: CUDA float16)")
    else:
        model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8", cpu_threads=4)
        print("  (CPU mode: int8)")
    print("Model loaded.")

    print("Logging into Broadcastify...")
    session = get_broadcastify_session()
    print("Logged in.")

    total_transcribed = 0
    total_archives = 0
    quota_exhausted = False
    session_age = time.time()

    for feed in feeds:
        if quota_exhausted:
            break

        if time.time() - session_age > 1800:
            print("  [SESSION] Refreshing Broadcastify login...")
            try:
                session = get_broadcastify_session()
                session_age = time.time()
            except Exception as e:
                print(f"  [SESSION ERROR] {e} — continuing with old session")

        feed_id = feed["feed_id"]
        feed_label = feed["label"]
        progress = load_progress(feed_id)

        for day_str in day_strings:
            if quota_exhausted:
                break
            if args.skip_existing and progress.get(day_str):
                continue

            print(f"\n[{day_str}] [{feed_label}] Fetching archives...")
            try:
                archives = fetch_archive_links(session, feed_id, day_str)
            except QuotaExhaustedError as e:
                print(f"\n[QUOTA EXHAUSTED] {e}")
                quota_exhausted = True
                break

            if not archives:
                print(f"  No archives available.")
                progress[day_str] = "no_archives"
                save_progress(feed_id, progress)
                continue

            day_progress = progress.get(day_str, {})
            if isinstance(day_progress, str):
                continue
            done_segments: set = set(day_progress.get("done_segments", []))

            print(f"  Found {len(archives)} segments ({len(done_segments)} already done).")
            day_transcribed = 0

            for ai, archive in enumerate(archives):
                seg_id = archive.get("id", str(ai))
                if seg_id in done_segments:
                    continue

                archive_url = archive["url"]
                time_label = archive["time_label"]
                start_ts = archive.get("startTs", 0)
                if start_ts:
                    archive_ts = datetime.datetime.fromtimestamp(start_ts, tz=datetime.timezone.utc).isoformat()
                elif re.match(r'\d{2}:\d{2}', time_label):
                    archive_ts = f"{day_str}T{time_label}"
                else:
                    archive_ts = f"{day_str}T00:00:00"

                with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
                    tmp_path = tmp.name

                try:
                    # Each step prints its own line so the runner's stdout
                    # pump (and therefore the heartbeat) ticks per step
                    # rather than batching the whole try-block onto one line.
                    print(
                        f"  [{ai+1}/{len(archives)}] Downloading {time_label}...",
                        flush=True,
                    )
                    try:
                        if not download_mp3(session, archive_url, tmp_path):
                            continue
                    except QuotaExhaustedError as e:
                        print(f"\n[QUOTA EXHAUSTED] {e}", flush=True)
                        quota_exhausted = True
                        break

                    audio = mp3_to_pcm(tmp_path)
                    if audio is None:
                        print("    (empty/error)", flush=True)
                        continue

                    duration_min = len(audio) / SAMPLE_RATE / 60
                    print(
                        f"    transcribing {duration_min:.1f}min...",
                        flush=True,
                    )

                    count = transcribe_and_post(model, audio, feed_id, feed_label, archive_ts, city=city_slug)
                    day_transcribed += count
                    total_transcribed += count
                    total_archives += 1
                    print(f"    -> {count} transcripts", flush=True)

                    done_segments.add(seg_id)
                    progress[day_str] = {"done_segments": list(done_segments), "transcripts": day_transcribed}
                    save_progress(feed_id, progress)

                finally:
                    if os.path.exists(tmp_path):
                        os.unlink(tmp_path)

                _download_delay()

            if not quota_exhausted:
                progress[day_str] = f"done_{day_transcribed}"
                save_progress(feed_id, progress)
                print(f"  --- Day {day_str} [{feed_label}]: {day_transcribed} transcripts ---")

        if not quota_exhausted:
            print(f"\n=== Feed {feed_label} complete ===")
            cooldown = _jittered_delay(90, 0.3)
            print(f"  Cooling down {cooldown:.0f}s before next feed...")
            time.sleep(cooldown)

    print(f"\n=== Backfill {'stopped (quota exhausted)' if quota_exhausted else 'complete'} ===")
    print(f"Total: {total_transcribed} transcripts from {total_archives} archive segments")
    if quota_exhausted:
        print("Re-run later when the daily download quota resets (likely midnight US-Eastern).")


if __name__ == "__main__":
    main()
