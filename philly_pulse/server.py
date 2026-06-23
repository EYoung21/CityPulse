"""FastAPI server for Pulse platform.

Serves the API: ingest, incidents, admin, health.
Set CITY_CONFIG env var to a city config YAML path to configure for a specific city.
Loads all city configs from the cities/ directory for multi-city LLM/geocode support.
"""

import hmac
import json
import logging
import os
import random
import re
import subprocess
import threading
import time
from datetime import datetime, date, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import httpx
import numpy as np
import yaml
from fastapi import FastAPI, Header, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import admin_events, city_registry, geocode, ingest_location, inhibitor, llm, llm_client, persistence as store, prefilter, push as push_mod, spelling_guard, weights
from .llm_client import LLMConfigError, LLMHTTPError
from .llm import SEVERITY_CATEGORIES

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Free tier read window: unauthenticated callers (and authed free users)
# can only read incidents within this most-recent time horizon. Defaults to
# 24h so the standard 24h map/feed view is usable without Pro; override via env.
FREE_INCIDENT_WINDOW_SECONDS = int(
    os.environ.get("FREE_INCIDENT_WINDOW_SECONDS", str(24 * 60 * 60))
)

# When False, ingest only stores raw transcript+audio — no LLM/inhibitor/geocode.
# Flip to True (or set env PHILLY_PULSE_LLM_AUTO=1) to resume automatic processing.
LLM_AUTO_ENABLED = os.environ.get("PHILLY_PULSE_LLM_AUTO", "0").strip().lower() in ("1", "true", "yes")

# Ask Pulse (Pro): incident RAG + Lambda chat. `PULSE_CHAT_MODEL` overrides
# `LAMBDA_MODEL` for this endpoint only.
PULSE_CHAT_STORE_FETCH = int(os.environ.get("PULSE_CHAT_STORE_FETCH", "450"))
PULSE_CHAT_BUNDLE_MAX = int(os.environ.get("PULSE_CHAT_BUNDLE_MAX", "180"))
PULSE_CHAT_RL_WINDOW_SEC = float(os.environ.get("PULSE_CHAT_RL_WINDOW_SEC", "60"))
PULSE_CHAT_RL_MAX = int(os.environ.get("PULSE_CHAT_RL_MAX", "20"))
_PULSE_CHAT_RL: dict[str, list[float]] = {}
_PULSE_CHAT_RL_LOCK = threading.Lock()

# Ask Pulse tools: in-memory search (0 extra reads) + capped paged Firestore fetch.
PULSE_CHAT_TOOLS_ENABLED = os.environ.get("PULSE_CHAT_TOOLS_ENABLED", "1").strip().lower() in (
    "1",
    "true",
    "yes",
)
PULSE_CHAT_TOOL_ROUNDS_MAX = max(2, min(12, int(os.environ.get("PULSE_CHAT_TOOL_ROUNDS_MAX", "5"))))
PULSE_CHAT_FS_TOOL_FETCHES_MAX = max(0, min(5, int(os.environ.get("PULSE_CHAT_FS_TOOL_FETCHES_MAX", "2"))))
PULSE_CHAT_FS_TOOL_PAGE_CAP = max(20, min(200, int(os.environ.get("PULSE_CHAT_FS_TOOL_PAGE_CAP", "100"))))
PULSE_CHAT_TOOL_RESULT_MAX = max(5, min(60, int(os.environ.get("PULSE_CHAT_TOOL_RESULT_MAX", "35"))))

# ── City config ─────────────────────────────────────────────────────

_city_config_path = os.environ.get("CITY_CONFIG")
_city_config: dict = {}
CITY_NAME = "Philadelphia"
CITY_SLUG = "philly"
if _city_config_path and Path(_city_config_path).exists():
    with open(_city_config_path, "r", encoding="utf-8") as f:
        _city_config = yaml.safe_load(f) or {}
    CITY_NAME = _city_config.get("city", {}).get("name", "Philadelphia")
    CITY_SLUG = _city_config.get("city", {}).get("slug") or Path(_city_config_path).parent.name
    logger.info("Loaded city config: %s from %s", CITY_NAME, _city_config_path)

# ── Multi-city registry + feed labels (cities/*/config.yaml) ───────

CITY_REGISTRY = city_registry.CITY_REGISTRY
FEED_LABELS = city_registry.FEED_LABELS
FEED_META = city_registry.FEED_META


def _resolve_feed_label(feed_id: str | None, req_label: str | None) -> str | None:
    if req_label and str(req_label).strip():
        return str(req_label).strip()
    if not feed_id:
        return None
    return FEED_LABELS.get(str(feed_id).strip())


def _get_city_llm_context(city_slug: str) -> dict | None:
    """Look up LLM context dict for a city slug."""
    return CITY_REGISTRY.get(city_slug)


def _get_city_geo_context(city_slug: str) -> dict | None:
    """Look up geocoder context for a city slug."""
    entry = CITY_REGISTRY.get(city_slug)
    if not entry:
        return None
    return {
        "viewbox": entry["viewbox"],
        "bounds": entry["bounds"],
        "suffix": entry["geocode_suffix"],
    }

app = FastAPI(title=f"{CITY_NAME} Pulse API", version="0.1.0")

# CORS: `Allow-Origin: *` must not be combined with `Allow-Credentials: true`
# (browser will reject). The SPA calls this API with default fetch credentials
# and `Authorization: Bearer …` only — no cross-origin cookies — so credentials
# stay off. (If you add cookie sessions later, switch to explicit `allow_origins`
# and set `allow_credentials=True`.)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load Broadcastify config for audio proxy
_config_path = Path(__file__).resolve().parent.parent / "config.yaml"
_bf_username = ""
_bf_password = ""
_bf_config: dict = {}

_DEFAULT_FEEDS = [
    {"feed_id": "4603",  "label": "PPD Citywide"},
    {"feed_id": "17310", "label": "PPD Central"},
    {"feed_id": "21297", "label": "PPD East"},
    {"feed_id": "45495", "label": "PPD Northeast"},
    {"feed_id": "18836", "label": "PPD Northwest"},
    {"feed_id": "15102", "label": "PPD South"},
    {"feed_id": "15195", "label": "PPD Southwest/West"},
    {"feed_id": "34250", "label": "PFD South Fire/Medics"},
    {"feed_id": "15747", "label": "PFD North Fire"},
]
FEEDS = _city_config.get("feeds", _DEFAULT_FEEDS)
if _config_path.exists():
    try:
        with open(_config_path, "r") as f:
            _cfg = yaml.safe_load(f)
        _bf_username = _cfg.get("credentials", {}).get("username", "")
        _bf_password = _cfg.get("credentials", {}).get("password", "")
        _bf_config = _cfg
    except Exception:
        pass

DATA_DIR = Path(__file__).parent / "data"
SEED_PATH = DATA_DIR / "seed_incidents.json"

CANNED_TRANSCRIPTS = [
    "All units, armed robbery at the CVS on Girard Avenue and Broad Street, suspect fleeing on foot northbound",
    "Medic 3, overdose at Emerald and Allegheny, bystanders performing CPR",
    "Engine 11 responding to a kitchen fire, 1500 block of Spruce Street, smoke visible",
    "Report of shots fired at 22nd and Lehigh, multiple callers, no victims located yet",
    "Two-car MVA with injuries at Cobbs Creek Parkway and Baltimore Avenue, one vehicle flipped",
    "Disturbance at the Gallery mall, security reports a large fight near the food court",
    "52B3 responding to a burglary in progress at 4700 block of Chester Avenue",
    "Medical assist, child fell from playground equipment, Clark Park, 43rd and Baltimore",
]


_AUDIO_CLIPS_DIR = Path(__file__).resolve().parent.parent / "audio_clips"
_RAW_CLIPS_DIR = Path(__file__).resolve().parent.parent / "audio_clips_raw"
_AUDIO_CLIPS_DIR.mkdir(exist_ok=True)
_RAW_CLIPS_DIR.mkdir(exist_ok=True)


class IngestRequest(BaseModel):
    text: str
    timestamp: str | None = None
    segment_start_utc: str | None = None
    feed_id: str | None = None
    feed_label: str | None = None
    audio_clip: str | None = None
    raw_audio_clip: str | None = None
    preprocess_meta: dict | None = None
    variants: list[dict] | None = None
    city: str | None = None
    audio_data: dict | None = None  # {"<clip_id>": "<base64-wav>"} for uploading clips


class RouteDirectionsRequest(BaseModel):
    """Waypoints as [lat, lng] pairs; mode matches frontend TransportMode."""

    waypoints: list[list[float]]
    mode: str = "driving-car"


OSRM_BASE = "https://router.project-osrm.org/route/v1"
OSRM_PROFILES = {
    "foot-walking": "foot",
    "cycling-regular": "bike",
    "driving-car": "car",
}


def _ingest_lag_sec(reported_at: str, ingested_at: str) -> float | None:
    try:
        reported = datetime.fromisoformat(reported_at.replace("Z", "+00:00"))
        ingested = datetime.fromisoformat(ingested_at.replace("Z", "+00:00"))
        return max(0.0, (ingested - reported).total_seconds())
    except (ValueError, TypeError):
        return None


@app.on_event("startup")
async def startup():
    """Ensure the database table exists and configure per-city geocoder/LLM."""
    store.get_conn()  # creates table if missing

    # Configure LLM + geocoder defaults with the primary city.
    # Prefer the explicitly loaded CITY_CONFIG (single-city server), but
    # fall back to the multi-city registry (cities/*/config.yaml) so
    # deployments don't silently revert to the legacy Philly-only bbox.
    default_ctx = _get_city_llm_context(CITY_SLUG)
    if default_ctx:
        llm.configure_llm(
            city_name=default_ctx["city_name"],
            geocode_suffix=default_ctx["geocode_suffix"],
            center_lat=default_ctx["center_lat"],
            center_lng=default_ctx["center_lng"],
            bounds=default_ctx["bounds"],
            llm_local_context=default_ctx.get("llm_local_context", ""),
        )

    geo_cfg = _city_config.get("geocode", {}) if isinstance(_city_config, dict) else {}
    if geo_cfg:
        geocode.configure_geocoder(
            viewbox=geo_cfg.get("viewbox", default_ctx["viewbox"] if default_ctx else "-75.28,39.87,-74.96,40.14"),
            bounds=geo_cfg.get("bounds") or (default_ctx["bounds"] if default_ctx else None),
            suffix=geo_cfg.get("suffix", default_ctx["geocode_suffix"] if default_ctx else ", Philadelphia, PA"),
            city_name=CITY_NAME,
        )
    elif default_ctx:
        geocode.configure_geocoder(
            viewbox=default_ctx.get("viewbox") or "-75.28,39.87,-74.96,40.14",
            bounds=default_ctx.get("bounds"),
            suffix=default_ctx.get("geocode_suffix") or ", Philadelphia, PA",
            city_name=default_ctx.get("city_name") or CITY_NAME,
        )

    logger.info("%s Pulse API starting up (%d cities registered)",
                CITY_NAME, len(CITY_REGISTRY))


@app.get("/api/health")
async def health():
    try:
        count = store.incident_count()
    except Exception:
        count = -1
    return {
        "status": "ok",
        "llm_configured": llm.is_configured(),
        "llm_provider": llm_client.active_provider_name(),
        "llm_model": llm_client.active_model(),
        "pulse_chat_llm_configured": llm_client.is_configured()
        or llm_client.is_deepseek_pulse_fallback_configured(),
        "pulse_chat_deepseek_fallback": llm_client.is_deepseek_pulse_fallback_configured(),
        "inhibitor_configured": inhibitor.GUARDRAIL_MODE not in {"off", "disabled", "none"},
        "incident_count": count,
    }


@app.post("/api/route-directions")
async def route_directions(body: RouteDirectionsRequest):
    """Proxy to OSRM so the browser gets street geometry (avoids public OSRM CORS blocks)."""
    if len(body.waypoints) < 2:
        raise HTTPException(status_code=400, detail="Need at least two waypoints")
    if len(body.waypoints) > 25:
        raise HTTPException(status_code=400, detail="Too many waypoints (max 25)")
    for w in body.waypoints:
        if len(w) != 2:
            raise HTTPException(status_code=400, detail="Each waypoint must be [lat, lng]")
    profile = OSRM_PROFILES.get(body.mode, "car")
    # OSRM expects lon,lat;lon,lat;...
    coord_str = ";".join(f"{w[1]},{w[0]}" for w in body.waypoints)
    url = f"{OSRM_BASE}/{profile}/{coord_str}"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                url,
                params={"overview": "full", "geometries": "geojson"},
                headers={"User-Agent": "PhillyPulse/1.0"},
            )
    except httpx.RequestError as e:
        logger.warning("OSRM request failed: %s", e)
        raise HTTPException(status_code=502, detail="Routing service unreachable") from e

    if resp.status_code != 200:
        raise HTTPException(
            status_code=502, detail=f"OSRM error HTTP {resp.status_code}"
        )
    data = resp.json()
    if data.get("code") not in (None, "Ok"):
        raise HTTPException(
            status_code=404,
            detail=data.get("message") or data.get("code") or "No route",
        )
    routes = data.get("routes") or []
    if not routes:
        raise HTTPException(status_code=404, detail="No route found for these waypoints")
    route = routes[0]
    coords = route.get("geometry", {}).get("coordinates") or []
    if len(coords) < 2:
        raise HTTPException(status_code=502, detail="Invalid route geometry")
    # GeoJSON is [lng, lat]; frontend / Leaflet expect [lat, lng]
    geometry = [[float(pt[1]), float(pt[0])] for pt in coords]
    return {
        "geometry": geometry,
        "distanceKm": route["distance"] / 1000.0,
        "durationMin": route["duration"] / 60.0,
    }


# Firebase Admin SDK expects the GCS bucket name (typically "<project>.appspot.com").
# Some configs mistakenly use "<project>.firebasestorage.app" (web domain), so we
# normalize and try both where possible.
_STORAGE_BUCKET = os.environ.get("FIREBASE_STORAGE_BUCKET", "phlpulse.firebasestorage.app")
_DISCOVERED_STORAGE_BUCKETS: list[str] | None = None


def _infer_firebase_project_id() -> str | None:
    """Best-effort project id resolution for bucket discovery."""
    pid = (
        os.environ.get("FIREBASE_PROJECT_ID")
        or os.environ.get("NEXT_PUBLIC_FIREBASE_PROJECT_ID")
        or ""
    ).strip()
    if pid:
        return pid

    cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    if cred_path and os.path.isfile(cred_path):
        try:
            import json
            with open(cred_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            pid = (data.get("project_id") or "").strip()
            if pid:
                return pid
        except Exception:
            pass

    json_str = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    if json_str:
        try:
            import json
            data = json.loads(json_str)
            pid = (data.get("project_id") or "").strip()
            if pid:
                return pid
        except Exception:
            pass

    return None


def _discover_storage_buckets() -> list[str]:
    """List candidate GCS buckets for the Firebase project once per process.
    (Disabled: synchronous gcs_storage.Client initialization without 
    GOOGLE_APPLICATION_CREDENTIALS hangs the ASGI event loop waiting for GCE metadata.)
    """
    return []


def _storage_bucket_candidates() -> list[str]:
    """Return preferred Firebase Storage bucket names to try."""
    primary = (_STORAGE_BUCKET or "").strip()
    if not primary:
        primary = "phlpulse.firebasestorage.app"
    candidates = [primary]
    if not _STORAGE_BUCKET:
        candidates.append("phlpulse.appspot.com")
    candidates.extend(_discover_storage_buckets())
    return list(dict.fromkeys(candidates))


def _get_storage_bucket(bucket_name: str):
    """Get (or initialize) a Firebase Storage bucket by name."""
    try:
        import firebase_admin
        from firebase_admin import storage as fb_storage
        if not firebase_admin._apps:
            # Should already be initialized by firestore_store, but just in case
            import json
            cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
            json_str = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
            if cred_path and os.path.isfile(cred_path):
                cred = firebase_admin.credentials.Certificate(cred_path)
            elif json_str:
                cred = firebase_admin.credentials.Certificate(json.loads(json_str))
            else:
                return None
            firebase_admin.initialize_app(cred)
        return fb_storage.bucket(bucket_name)
    except Exception as e:
        logger.warning("Firebase Storage not available: %s", e)
        return None


def _upload_to_firebase_storage(clip_id: str, wav_bytes: bytes) -> str | None:
    """Upload a WAV file to Firebase Storage and return the public URL.
    
    Returns the public URL on success, or None on failure.
    """
    for bucket_name in _storage_bucket_candidates():
        bucket = _get_storage_bucket(bucket_name)
        if bucket is None:
            continue
        try:
            blob = bucket.blob(f"audio/{clip_id}.wav")
            blob.upload_from_string(wav_bytes, content_type="audio/wav")
            blob.make_public()
            url = blob.public_url
            logger.info(
                "Uploaded audio clip %s to Firebase Storage bucket %s (%d bytes)",
                clip_id,
                bucket_name,
                len(wav_bytes),
            )
            return url
        except Exception as e:
            logger.error("Failed to upload audio %s to bucket %s: %s", clip_id, bucket_name, e)
    return None


def _save_audio_data(audio_data: dict, only_clip_ids: set[str] | None = None) -> dict[str, str]:
    """Upload base64-encoded audio clips to Firebase Storage.

    audio_data is a dict of {"clip_id": "base64-wav-data", ...}.
    Only saves processed clips (not raw).
    If only_clip_ids is given, only save clips whose ID is in that set.
    
    Returns a dict of {clip_id: public_url} for successfully uploaded clips.
    """
    import base64
    urls: dict[str, str] = {}

    for clip_id, b64_data in audio_data.items():
        # Skip raw clips entirely — they are only used for reprocessing
        if clip_id.endswith("_raw"):
            continue
        if not re.fullmatch(r"[a-f0-9]{12}", clip_id):
            logger.warning("Ignoring invalid clip_id: %s", clip_id)
            continue
        if only_clip_ids is not None and clip_id not in only_clip_ids:
            continue
        try:
            wav_bytes = base64.b64decode(b64_data)
        except Exception as e:
            logger.warning("Failed to decode audio for %s: %s", clip_id, e)
            continue

        # Upload to Firebase Storage (primary)
        url = _upload_to_firebase_storage(clip_id, wav_bytes)
        if url:
            urls[clip_id] = url
        else:
            # Fallback: save to local disk if Firebase Storage fails
            dest = _AUDIO_CLIPS_DIR / f"{clip_id}.wav"
            if not dest.exists():
                dest.write_bytes(wav_bytes)
                logger.info("Saved audio clip %s to disk (Storage fallback, %d bytes)", dest.name, len(wav_bytes))
    
    return urls


class AudioUploadRequest(BaseModel):
    """Batch upload audio clips (used to sync clips to the server)."""
    clips: dict  # {"clip_id": "base64-wav-data"}
    raw_clips: dict | None = None  # {"clip_id": "base64-wav-data"} for raw clips


@app.post("/api/audio/upload")
async def upload_audio(
    req: AudioUploadRequest,
    authorization: Optional[str] = Header(None),
):
    """Receive and save audio clip WAV files. Used by the transcriber bridge."""
    _verify_ingest_secret(authorization)
    import base64
    # Cap per-request fan-out: reject oversized batches outright (413) and skip
    # any single decoded clip larger than 5 MiB so a malicious caller can't fill
    # the disk with one POST.
    _MAX_CLIPS = 50
    _MAX_CLIP_BYTES = 5 * 1024 * 1024
    total_clips = len(req.clips) + (len(req.raw_clips) if req.raw_clips else 0)
    if total_clips > _MAX_CLIPS:
        raise HTTPException(status_code=413, detail="Too many clips in one upload")
    saved = 0
    for clip_id, b64 in req.clips.items():
        if not re.fullmatch(r"[a-f0-9]{12}", clip_id):
            continue
        try:
            wav_bytes = base64.b64decode(b64)
        except Exception:
            continue
        if len(wav_bytes) > _MAX_CLIP_BYTES:
            continue
        dest = _AUDIO_CLIPS_DIR / f"{clip_id}.wav"
        if not dest.exists():
            dest.write_bytes(wav_bytes)
            saved += 1
    if req.raw_clips:
        for clip_id, b64 in req.raw_clips.items():
            if not re.fullmatch(r"[a-f0-9]{12}", clip_id):
                continue
            try:
                wav_bytes = base64.b64decode(b64)
            except Exception:
                continue
            if len(wav_bytes) > _MAX_CLIP_BYTES:
                continue
            dest = _RAW_CLIPS_DIR / f"{clip_id}.wav"
            if not dest.exists():
                dest.write_bytes(wav_bytes)
                saved += 1
    return {"status": "ok", "saved": saved}


@app.post("/api/ingest")
async def ingest(
    req: IngestRequest,
    authorization: Optional[str] = Header(None),
):
    """Ingest a scanner transcript.

    When LLM_AUTO_ENABLED is False (default), only store the raw
    transcript + audio as an extraction — no LLM / inhibitor / geocode.
    When True, run the full pipeline.
    """
    _verify_ingest_secret(authorization)

    feed_id = req.feed_id or "unknown"
    city = req.city or CITY_SLUG
    feed_label = _resolve_feed_label(feed_id, req.feed_label)
    ingested_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    feed_meta = FEED_META.get(str(feed_id).strip(), {})
    jurisdiction_hint = feed_meta.get("jurisdiction_hint")

    # Audio data is saved AFTER the pipeline determines the incident is map-worthy.
    # This avoids wasting disk on rejected/no-location transcripts (~95% reduction).
    _pending_audio_data = req.audio_data

    # Normalize time-only timestamps (e.g. "14:30:00") to full ISO
    ts = req.timestamp
    if ts and re.match(r"^\d{1,2}:\d{2}(:\d{2})?$", ts.strip()):
        ts = f"{date.today().isoformat()}T{ts.strip()}"
    if not ts:
        logger.warning(
            "Ingest missing segment timestamp for feed=%s; using ingest time as reported_at",
            feed_id,
        )
    req_timestamp = ts or ingested_at
    ingest_lag_sec = _ingest_lag_sec(req_timestamp, ingested_at)

    correlation = f"{feed_id}_{req_timestamp}"

    effective_audio_clip = req.audio_clip
    effective_word_timings = None
    if not effective_audio_clip and req.variants:
        for v in req.variants:
            if v.get("name") == "aggressive" and v.get("audio_clip"):
                effective_audio_clip = v["audio_clip"]
                effective_word_timings = v.get("word_timings")
                break
        if not effective_audio_clip and req.variants:
            effective_audio_clip = req.variants[0].get("audio_clip")
            effective_word_timings = req.variants[0].get("word_timings")
    elif req.variants:
        for v in req.variants:
            if v.get("audio_clip") == effective_audio_clip:
                effective_word_timings = v.get("word_timings")
                break

    # Broadcast: transcript received
    await admin_events.broadcast({
        "type": "transcript_received",
        "correlation": correlation,
        "feed_id": feed_id,
        "text": req.text,
        "timestamp": req_timestamp,
    })

    # ── Collection-only mode (LLM paused) ──────────────────────────
    if not LLM_AUTO_ENABLED:
        store.insert_extraction(
            feed_id=feed_id,
            raw_text=req.text,
            reported_at=req_timestamp,
            audio_clip=effective_audio_clip,
            raw_audio_clip=req.raw_audio_clip,
            preprocess_meta=req.preprocess_meta,
            variants=req.variants,
            city=city,
        )
        return {"status": "collected", "reason": "LLM auto-processing paused, raw transcript stored"}

    # ── Cheap regex prefilter (saves LLM $$$) ──────────────────────
    # Drop confirmed-junk lines (acks, hallucinated prompt fragments,
    # punctuation-only segments) before paying for gpt-4o-mini. The
    # prefilter is paranoid by default: any line that contains a real
    # incident keyword bypasses the noise check. See
    # philly_pulse/prefilter.py and cities/<slug>/prefilter.yaml.
    pf_keep, pf_reason = prefilter.is_dispatch_likely(req.text, city=city)
    if not pf_keep:
        await admin_events.broadcast({
            "type": "prefilter_skip",
            "correlation": correlation,
            "feed_id": feed_id,
            "reason": pf_reason,
        })
        store.insert_extraction(
            feed_id=feed_id,
            raw_text=req.text,
            reported_at=req_timestamp,
            audio_clip=effective_audio_clip,
            raw_audio_clip=req.raw_audio_clip,
            preprocess_meta=req.preprocess_meta,
            variants=req.variants,
            llm_relevant=False,
            llm_confidence=0.0,
            city=city,
            prefilter_status="skipped",
            prefilter_reason=pf_reason,
        )
        return {"status": "prefiltered", "reason": pf_reason}

    # ── Full pipeline mode ──────────────────────────────────────────
    await admin_events.broadcast({
        "type": "llm_started",
        "correlation": correlation,
        "feed_id": feed_id,
    })

    city_llm_ctx = _get_city_llm_context(city)
    city_geo_ctx = _get_city_geo_context(city)

    # Adjacent-radio context: pull the last few transcripts on this same
    # talkgroup within the past minute so the LLM can attach follow-ups
    # ("show me responding") to the original dispatch's location instead
    # of failing to extract one. See plan: adjacent_radio_context.
    prior_context: list[str] = []
    try:
        recent = store.get_recent_extractions(
            feed_id=feed_id,
            before_iso=req_timestamp,
            within_seconds=60,
            limit=3,
        )
        prior_context = [
            r.get("raw_text", "") for r in recent if r.get("raw_text")
        ]
    except Exception as e:
        logger.debug("prior_context lookup failed (non-fatal): %s", e)

    try:
        extraction = await llm.extract_incident(
            req.text,
            city_context=city_llm_ctx,
            prior_context=prior_context or None,
            feed_label=feed_label,
            jurisdiction_hint=jurisdiction_hint,
        )
    except llm.LLMError as e:
        await admin_events.broadcast({
            "type": "llm_error",
            "correlation": correlation,
            "feed_id": feed_id,
            "error": str(e),
        })
        logger.warning("LLM failed, storing raw extraction: %s", e)
        store.insert_extraction(
            feed_id=feed_id,
            raw_text=req.text,
            reported_at=req_timestamp,
            audio_clip=effective_audio_clip,
            raw_audio_clip=req.raw_audio_clip,
            preprocess_meta=req.preprocess_meta,
            variants=req.variants,
            city=city,
        )
        return {"status": "collected", "reason": f"LLM error, raw stored: {e}"}

    if extraction is None:
        await admin_events.broadcast({
            "type": "llm_result",
            "correlation": correlation,
            "feed_id": feed_id,
            "is_relevant": False,
            "category": "admin_or_noise",
            "confidence": 0,
            "location_text": None,
        })
        store.insert_extraction(
            feed_id=feed_id,
            raw_text=req.text,
            reported_at=req_timestamp,
            audio_clip=effective_audio_clip,
            raw_audio_clip=req.raw_audio_clip,
            preprocess_meta=req.preprocess_meta,
            variants=req.variants,
            llm_relevant=False,
            llm_confidence=0.0,
            city=city,
        )
        return {"status": "rejected", "reason": "Not dispatch-relevant"}

    category = extraction["severity_category"]

    # Deterministic anti-hallucination backstop: a severe category on a line that
    # is dominated by phonetic-alphabet spelling / unit-number readbacks (e.g. an
    # officer spelling "Bird" as Boy-Ida-Robert-David, mis-heard as "murder") is
    # almost always a mis-transcription, not a real incident. High-precision; only
    # ever acts on severe categories. See spelling_guard.assess().
    guard = spelling_guard.assess(req.text, category)
    if guard.suppress:
        logger.info(
            "spelling_guard suppressed %s (%s): %s",
            category,
            guard.reason,
            req.text[:160],
        )
        await admin_events.broadcast({
            "type": "llm_result",
            "correlation": correlation,
            "feed_id": feed_id,
            "is_relevant": False,
            "category": "admin_or_noise",
            "confidence": 0,
            "location_text": None,
            "guard_reason": guard.reason,
        })
        store.insert_extraction(
            feed_id=feed_id,
            raw_text=req.text,
            reported_at=req_timestamp,
            audio_clip=effective_audio_clip,
            raw_audio_clip=req.raw_audio_clip,
            preprocess_meta=req.preprocess_meta,
            variants=req.variants,
            llm_relevant=False,
            llm_category=category,
            llm_confidence=0.0,
            city=city,
        )
        return {"status": "rejected", "reason": f"guard: {guard.reason}"}

    location_text = extraction["location_text"]
    geo_suffix = (city_geo_ctx or {}).get("suffix") or (city_llm_ctx or {}).get("geocode_suffix") or ""
    if location_text and geo_suffix:
        location_text = geocode.normalize_location_text_for_geocode(
            location_text, suffix=geo_suffix
        )
    confidence = extraction["confidence"]
    description = extraction.get("description")
    s_base = weights.get_s_base(category)

    await admin_events.broadcast({
        "type": "llm_result",
        "correlation": correlation,
        "feed_id": feed_id,
        "is_relevant": True,
        "category": category,
        "confidence": confidence,
        "location_text": location_text,
        "s_base": s_base,
    })

    # Inhibitor ethical guardrail
    inh = await inhibitor.check_incident(
        raw_transcript=req.text,
        severity_category=category,
        location_text=location_text,
        confidence=confidence,
    )

    await admin_events.broadcast({
        "type": "inhibitor_result",
        "correlation": correlation,
        "feed_id": feed_id,
        "status": inh.status,
        "reason": inh.reason,
    })

    location_confidence = extraction.get("location_confidence", "none")

    # Redact-and-publish: the guardrail never blocks an incident. It masks PII
    # *values* (phone, SSN, payment card, email, DOB date) in everything we
    # store and display, while req.text stays intact for geocoding and LLM
    # refinement. When a transcript is redacted we also drop word_timings — the
    # per-word audio-sync array would otherwise re-expose the masked spans — and
    # the plain redacted transcript renders instead. (Audio still contains the
    # spoken words; redaction protects the searchable/displayed text.)
    stored_raw_text, _redactions = inhibitor.redact_pii(req.text)
    stored_word_timings = None if _redactions else effective_word_timings

    # Geocode the location text via Nominatim. We no longer fall back to
    # LLM-predicted coords — the model hallucinates the city center when it
    # doesn't actually know the address, which caused unrelated incidents to
    # cluster at one point. If Nominatim can't resolve the text, the
    # incident is dropped (or, post-repair, soft-hidden by the unmapped queue).
    location_confidence = extraction.get("location_confidence", "none")

    geocode_attempts_all: list[dict] = []
    location_result = None
    for attempt_idx in range(1, ingest_location.max_extract_attempts() + 1):
        location_result = await ingest_location.resolve_validated_location(
            raw_text=req.text,
            location_text=location_text,
            location_confidence=location_confidence,
            city=city,
            geo_ctx=city_geo_ctx,
            feed_meta=feed_meta,
        )
        geocode_attempts_all.extend(location_result.geocode_attempts)
        if location_result.lat is not None and location_result.lng is not None:
            location_text = location_result.location_text or location_text
            break
        if attempt_idx >= ingest_location.max_extract_attempts():
            break
        validation_error = (
            location_result.validation.reason
            if location_result.validation and location_result.validation.reason
            else location_result.geocode_status
        )
        try:
            extraction = await llm.refine_incident_extraction(
                req.text,
                city_context=city_llm_ctx,
                prior_context=prior_context or None,
                feed_label=feed_label,
                jurisdiction_hint=jurisdiction_hint,
                prior_extraction=extraction,
                validation_error=validation_error or "geocode_failed",
            )
        except llm.LLMError as e:
            logger.warning("LLM refine failed on attempt %s: %s", attempt_idx, e)
            break
        if extraction is None:
            break
        category = extraction["severity_category"]
        location_text = extraction["location_text"]
        if location_text and geo_suffix:
            location_text = geocode.normalize_location_text_for_geocode(
                location_text, suffix=geo_suffix
            )
        confidence = extraction["confidence"]
        description = extraction.get("description")
        s_base = weights.get_s_base(category)
        location_confidence = extraction.get("location_confidence", "none")

    lat, lng = None, None
    geocode_status = location_result.geocode_status if location_result else "failed"
    if location_result and location_result.lat is not None and location_result.lng is not None:
        lat, lng = location_result.lat, location_result.lng
        geocode_status = location_result.geocode_status

    await admin_events.broadcast({
        "type": "geocode_result",
        "correlation": correlation,
        "feed_id": feed_id,
        "lat": lat,
        "lng": lng,
        "method": geocode_status,
        "location_confidence": location_confidence,
    })

    # Only create an incident if we have a real location (Tier 1 or 2)
    incident_id = None
    incident: dict | None = None
    merge_outcome: str | None = None
    if lat is not None and lng is not None:
        # Save the audio first so the resulting URL can be embedded in
        # whichever path we take (new incident, or appended mention on a
        # dedup match). Previously this only ran on the create path; now
        # it has to run before we decide.
        audio_url = None
        if _pending_audio_data and effective_audio_clip:
            try:
                urls = _save_audio_data(_pending_audio_data, only_clip_ids={effective_audio_clip})
                audio_url = urls.get(effective_audio_clip)
            except OSError as e:
                logger.error("Failed to save audio clip (disk full?): %s", e)

        # Build the mention payload that represents *this* transmission.
        # Used both as the seed entry on a brand-new incident and as the
        # appended entry on a dedup merge. description is finalized by the
        # refine loop above, so redact it here.
        stored_description = (
            inhibitor.redact_pii(description)[0] if description else description
        )
        mention = {
            "at": req_timestamp,
            "raw_text": stored_raw_text,
            "audio_clip": effective_audio_clip,
            "audio_url": audio_url,
            "feed_id": feed_id,
            "location_text": location_text,
            "location_confidence": location_confidence,
            "confidence": confidence,
            "severity_category": category,
            "s_base": s_base,
            "description": stored_description,
        }

        # Dedup: if a recent same-category incident exists within ~200m
        # in the past 15 min, append this transmission as an "Update"
        # instead of creating a duplicate pin. See plan: incident_dedup.
        existing = None
        try:
            existing = store.find_recent_duplicate(
                city=city,
                lat=lat,
                lng=lng,
                severity_category=category,
                reported_at=req_timestamp,
            )
        except Exception as e:
            logger.debug("dedup lookup failed (non-fatal): %s", e)

        if existing:
            try:
                merged = store.append_mention(existing["id"], mention)
                if merged is not None:
                    incident = merged
                    incident_id = existing["id"]
                    merge_outcome = "merged"
            except Exception as e:
                logger.warning("append_mention failed for %s: %s", existing.get("id"), e)

        if incident_id is None:
            incident = store.insert_incident(
                raw_text=stored_raw_text,
                severity_category=category,
                s_base=s_base,
                confidence=confidence,
                location_text=location_text,
                lat=lat,
                lng=lng,
                geocode_status=geocode_status,
                location_confidence=location_confidence,
                inhibitor_status=inh.status,
                inhibitor_reason=inh.reason,
                reported_at=req_timestamp,
                ingested_at=ingested_at,
                audio_clip=effective_audio_clip,
                feed_id=feed_id,
                description=stored_description,
                word_timings=stored_word_timings,
                city=city,
                mentions=[mention],
            )
            incident_id = incident["id"]
            merge_outcome = "created"

            # Set audio_url on the incident root for the create path so
            # the existing player UI keeps working without having to
            # always read the latest mention. (Merged incidents keep the
            # original pin's audio_url; the new clip is reachable via
            # the mentions stack.)
            if audio_url:
                try:
                    store.update_incident(incident_id, {"audio_url": audio_url})
                except Exception as e:
                    logger.warning("Failed to store audio_url: %s", e)

        await admin_events.broadcast({
            "type": "incident_stored",
            "correlation": correlation,
            "feed_id": feed_id,
            "outcome": merge_outcome or "created",
            "incident_id": incident_id,
            "category": category,
            "confidence": confidence,
            "location_text": location_text,
            "lat": lat,
            "lng": lng,
        })

        # Server-backed Web Push fan-out for closed-tab subscribers.
        # We run this best-effort and *after* the incident is stored
        # so a push failure can never block the ingest pipeline. The
        # severity / confidence / inhibitor gates live inside
        # notify_nearby_incident so this call site stays a one-liner.
        # Skip on merges: the original incident already fanned out;
        # follow-up mentions shouldn't double-notify the same users.
        if merge_outcome == "created":
            try:
                push_stats = push_mod.notify_nearby_incident(
                    incident_id=incident_id,
                    city=city,
                    lat=lat,
                    lng=lng,
                    severity_category=category,
                    s_base=s_base,
                    location_text=location_text,
                    location_confidence=location_confidence,
                    inhibitor_status=inh.status,
                )
                if push_stats.get("sent"):
                    logger.info(
                        "Web Push fan-out for incident %s: %s",
                        incident_id, push_stats,
                    )
            except Exception as e:  # pragma: no cover — defensive
                logger.warning(
                    "Web Push fan-out failed for incident %s: %s",
                    incident_id, e,
                )

        # Keyword-watch fan-out runs on every transmission (created and
        # merged) because each new transcript can newly match a watch
        # phrase that the original incident didn't trigger. Per-watch
        # cooldown inside notify_keyword_watches keeps a chatty incident
        # from flooding subscribers.
        try:
            kw_stats = push_mod.notify_keyword_watches(
                incident_id=incident_id,
                city=city,
                raw_text=req.text or "",
                severity_category=category,
                s_base=s_base,
                location_text=location_text,
            )
            if kw_stats.get("sent"):
                logger.info(
                    "Keyword-watch fan-out for incident %s: %s",
                    incident_id, kw_stats,
                )
        except Exception as e:  # pragma: no cover — defensive
            logger.warning(
                "Keyword-watch fan-out failed for incident %s: %s",
                incident_id, e,
            )

    store.insert_extraction(
        feed_id=feed_id,
        raw_text=stored_raw_text,
        reported_at=req_timestamp,
        ingested_at=ingested_at,
        segment_start_utc=req.segment_start_utc,
        ingest_lag_sec=ingest_lag_sec,
        audio_clip=effective_audio_clip,
        raw_audio_clip=req.raw_audio_clip,
        preprocess_meta=req.preprocess_meta,
        variants=req.variants,
        llm_relevant=True,
        llm_category=category,
        llm_confidence=confidence,
        llm_location_text=location_text,
        location_confidence=location_confidence,
        inhibitor_status=inh.status,
        inhibitor_reason=inh.reason,
        geocode_status=geocode_status,
        geocode_attempts=geocode_attempts_all,
        incident_id=incident_id,
        city=city,
    )

    if incident_id:
        return {"status": merge_outcome or "created", "incident": incident}
    return {"status": "no_location", "extraction_only": True}


@app.get("/api/incidents")
def get_incidents(
    response: Response,
    since: str | None = Query(None, description="ISO timestamp filter"),
    category: str | None = Query(None, description="Severity category filter"),
    authorization: Optional[str] = Header(None),
):
    """Return all displayable incidents with computed w_eff."""
    decoded = _try_verify_firebase_token(authorization)
    is_pro = bool(decoded) and _is_pro_uid(decoded or {})
    effective_since, clamped = _apply_free_since(since, is_pro)
    if clamped:
        response.headers["X-Pulse-Clamped"] = "1"
        response.headers["X-Pulse-Free-Window-Sec"] = str(FREE_INCIDENT_WINDOW_SECONDS)
    elif not is_pro:
        response.headers["X-Pulse-Free-Window-Sec"] = str(FREE_INCIDENT_WINDOW_SECONDS)
    try:
        incidents = store.list_incidents(since=effective_since, category=category)
        incidents = weights.enrich_incidents(incidents)
    except Exception:
        incidents = []
    meta = {
        "tier": "pro" if is_pro else "free",
        "freeWindowSec": FREE_INCIDENT_WINDOW_SECONDS,
        "clamped": bool(clamped),
        "effectiveSince": effective_since,
    }
    return {"incidents": incidents, "meta": meta}


def _normalize_search_term(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip()).lower()


def _incident_matches_query(inc: dict, terms: list[str]) -> bool:
    """All terms must appear (case-insensitive) in at least one searchable
    field. Multi-term queries behave as AND so e.g. `shooting temple`
    finds shootings near Temple even though those words live in
    different fields.
    """
    haystacks = [
        str(inc.get("raw_text") or ""),
        str(inc.get("severity_category") or ""),
        str(inc.get("description") or ""),
        str(inc.get("location_text") or ""),
    ]
    blob = " ".join(haystacks).lower()
    return all(t in blob for t in terms)


@app.get("/api/incidents/page")
def page_incidents(
    response: Response,
    cursor: str | None = Query(None, description="Opaque cursor: ISO reported_at of the last row from the prior page"),
    limit: int = Query(20, ge=1, le=50, description="Page size"),
    since: str | None = Query(None, description="Lower bound (defaults to now-24h)"),
    category: str | None = Query(None, description="Severity category filter"),
    city: str | None = Query(None, description="City slug filter"),
    near_lat: float | None = Query(None, ge=-90.0, le=90.0),
    near_lng: float | None = Query(None, ge=-180.0, le=180.0),
    authorization: Optional[str] = Header(None),
):
    """Cursor-paginated feed for the full-screen `/feed` route.

    Cursor is the `reported_at` of the last row on the previous page;
    the next page is "everything strictly older than that". When
    `near_lat`/`near_lng` are supplied we sort by distance instead of
    time (which makes "near me" feel right even when an old incident
    is geographically closer than a fresher one). Default `since` is
    24h to match the map's default window — the caller passes a
    longer `since` for power users on Pro tiers.
    """
    decoded = _try_verify_firebase_token(authorization)
    is_pro = bool(decoded) and _is_pro_uid(decoded or {})
    if not since:
        since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    effective_since, clamped = _apply_free_since(since, is_pro)
    if clamped:
        response.headers["X-Pulse-Clamped"] = "1"
        response.headers["X-Pulse-Free-Window-Sec"] = str(FREE_INCIDENT_WINDOW_SECONDS)
    elif not is_pro:
        response.headers["X-Pulse-Free-Window-Sec"] = str(FREE_INCIDENT_WINDOW_SECONDS)

    # If a free caller paginates past the allowed window, return an empty
    # page rather than leaking older incidents.
    if not is_pro and cursor:
        cursor_dt = _parse_iso_datetime(cursor)
        if cursor_dt and cursor_dt < _free_since_dt():
            response.headers["X-Pulse-Clamped"] = "1"
            return {
                "incidents": [],
                "next_cursor": None,
                "mode": "recent",
                "meta": {
                    "tier": "free",
                    "freeWindowSec": FREE_INCIDENT_WINDOW_SECONDS,
                    "clamped": True,
                    "effectiveSince": effective_since,
                    "paywalled": "history",
                },
            }
    try:
        if city and near_lat is None and near_lng is None:
            incidents = store.list_incidents_for_city(
                city,
                since=effective_since,
                category=category,
                before_iso=cursor,
                limit=limit,
            )
        elif city:
            incidents = store.list_incidents_for_city(
                city,
                since=effective_since,
                category=category,
                limit=500,
            )
        else:
            incidents = store.list_incidents(since=effective_since, category=category)
    except Exception:
        incidents = []
    # Apply cursor *before* sorting in proximity mode: the cursor is
    # only meaningful for chronological pagination. Proximity pages
    # don't paginate by cursor (the user expects the closest items
    # first; "load more" just bumps the limit on the next call).
    if near_lat is not None and near_lng is not None:
        scored: list[tuple[float, dict]] = []
        for inc in incidents:
            lat = inc.get("lat")
            lng = inc.get("lng")
            if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
                continue
            try:
                d = _haversine_km_inline(near_lat, near_lng, float(lat), float(lng))
            except Exception:
                continue
            scored.append((d, inc))
        scored.sort(key=lambda t: t[0])
        page = [
            {**inc, "distance_km": round(d, 3)}
            for d, inc in scored[:limit]
        ]
        return {
            "incidents": weights.enrich_incidents(page) if page else [],
            "next_cursor": None,
            "mode": "near",
            "meta": {
                "tier": "pro" if is_pro else "free",
                "freeWindowSec": FREE_INCIDENT_WINDOW_SECONDS,
                "clamped": bool(clamped),
                "effectiveSince": effective_since,
            },
        }

    incidents.sort(key=lambda i: i.get("reported_at") or "", reverse=True)
    if city and near_lat is None and near_lng is None:
        page = incidents
    else:
        if cursor:
            incidents = [i for i in incidents if (i.get("reported_at") or "") < cursor]
        page = incidents[:limit]
    next_cursor = (
        page[-1].get("reported_at") if len(page) == limit and page else None
    )
    try:
        page = weights.enrich_incidents(page)
    except Exception:
        pass
    return {
        "incidents": page,
        "next_cursor": next_cursor,
        "mode": "recent",
        "meta": {
            "tier": "pro" if is_pro else "free",
            "freeWindowSec": FREE_INCIDENT_WINDOW_SECONDS,
            "clamped": bool(clamped),
            "effectiveSince": effective_since,
        },
    }


def _haversine_km_inline(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    import math
    R = 6371.0088
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = rlat2 - rlat1
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


@app.get("/api/incidents/search")
def search_incidents(
    response: Response,
    q: str = Query(..., description="Free-text query"),
    since: str | None = Query(None, description="ISO lower bound (default: today-3h)"),
    until: str | None = Query(None, description="ISO upper bound (default: now)"),
    category: str | None = Query(None, description="Severity category filter"),
    limit: int = Query(50, ge=1, le=200, description="Max results"),
    city: str | None = Query(None, description="City slug filter"),
    authorization: Optional[str] = Header(None),
):
    """Full-text search over incident title/category/description/transcript.

    Adheres to the time window the caller passes in. The frontend uses
    this so that "search results match what the user is already looking
    at" — the same time-filter chip drives both the map and search. Pro
    callers pass an `since` that extends back further than the free 3-hr
    floor; gating is enforced by the frontend.
    """
    norm = _normalize_search_term(q)
    if not norm:
        return {"results": [], "total": 0, "query": q}

    terms = [t for t in norm.split(" ") if t]

    decoded = _try_verify_firebase_token(authorization)
    is_pro = bool(decoded) and _is_pro_uid(decoded or {})
    effective_since, clamped = _apply_free_since(since, is_pro)
    if clamped:
        response.headers["X-Pulse-Clamped"] = "1"
    if not is_pro:
        response.headers["X-Pulse-Free-Window-Sec"] = str(FREE_INCIDENT_WINDOW_SECONDS)

    try:
        if city:
            incidents = store.list_incidents_for_city(
                city,
                since=effective_since,
                category=category,
                limit=500,
            )
        else:
            incidents = store.list_incidents(since=effective_since, category=category)
    except Exception:
        incidents = []

    if until:
        incidents = [i for i in incidents if (i.get("reported_at") or "") <= until]

    matched = [i for i in incidents if _incident_matches_query(i, terms)]
    matched.sort(key=lambda i: i.get("reported_at") or "", reverse=True)

    truncated = matched[:limit]
    try:
        truncated = weights.enrich_incidents(truncated)
    except Exception:
        pass

    return {
        "results": truncated,
        "total": len(matched),
        "query": q,
        "terms": terms,
        "meta": {
            "tier": "pro" if is_pro else "free",
            "freeWindowSec": FREE_INCIDENT_WINDOW_SECONDS,
            "clamped": bool(clamped),
            "effectiveSince": effective_since,
        },
    }


@app.post("/api/seed")
async def seed(authorization: Optional[str] = Header(None)):
    """Load pre-built demo incidents into the database. Idempotent panic button."""
    _verify_firebase_admin(authorization)
    if not SEED_PATH.exists():
        raise HTTPException(status_code=404, detail="Seed data file not found")
    s_base_map = {cat: weights.get_s_base(cat) for cat in llm.SEVERITY_CATEGORIES}
    count = store.seed_from_json(str(SEED_PATH), s_base_map)
    logger.info("Seeded %d demo incidents on demand", count)
    return {"status": "seeded", "count": count}


@app.post("/api/simulate")
async def simulate(authorization: Optional[str] = Header(None)):
    """Ingest a random canned transcript through the full pipeline. For demos."""
    _verify_firebase_admin(authorization)
    transcript = random.choice(CANNED_TRANSCRIPTS)
    req = IngestRequest(text=transcript)
    # Re-use the ingest pipeline. The admin token above already authorized this
    # call, so pass the machine ingest secret (when configured) so the inner
    # `_verify_ingest_secret` check accepts the internal hand-off.
    inner_auth = f"Bearer {_PULSE_INGEST_SECRET}" if _PULSE_INGEST_SECRET else None
    return await ingest(req, authorization=inner_auth)


_SUMMARY_CACHE: dict = {"summary": None, "incident_count": 0, "expires_at": 0.0}

@app.get("/api/summary")
async def summary(
    response: Response,
    authorization: Optional[str] = Header(None),
):
    """AI-generated natural language summary of recent activity."""
    decoded = _try_verify_firebase_token(authorization)
    is_pro = bool(decoded) and _is_pro_uid(decoded or {})
    effective_since, clamped = _apply_free_since(None, is_pro)
    if not is_pro:
        response.headers["X-Pulse-Free-Window-Sec"] = str(FREE_INCIDENT_WINDOW_SECONDS)

    import starlette.concurrency
    import time
    
    if not is_pro:
        incidents = await starlette.concurrency.run_in_threadpool(lambda: store.list_incidents(since=effective_since))
    else:
        incidents = await starlette.concurrency.run_in_threadpool(lambda: store.list_incidents())
    recent = incidents[:20]

    if not recent:
        return {
            "summary": "No recent incidents to summarize.",
            "incident_count": 0,
            "meta": {
                "tier": "pro" if is_pro else "free",
                "freeWindowSec": FREE_INCIDENT_WINDOW_SECONDS,
                "clamped": bool(clamped),
                "effectiveSince": effective_since,
            },
        }

    # Use cached summary if available and valid for the current incident count
    now = time.time()
    if _SUMMARY_CACHE["expires_at"] > now and _SUMMARY_CACHE["incident_count"] == len(recent) and _SUMMARY_CACHE["summary"]:
        return {
            "summary": _SUMMARY_CACHE["summary"],
            "incident_count": len(recent),
            "meta": {
                "tier": "pro" if is_pro else "free",
                "freeWindowSec": FREE_INCIDENT_WINDOW_SECONDS,
                "clamped": bool(clamped),
                "effectiveSince": effective_since,
            },
        }

    if not llm.is_configured():
        lines = [
            f"- {inc['severity_category'].replace('_', ' ').title()}: "
            f"{inc.get('location_text', 'Unknown location')}"
            for inc in recent[:10]
        ]
        return {
            "summary": f"{len(recent)} recent incidents in {CITY_NAME}:\n" + "\n".join(lines),
            "incident_count": len(recent),
            "meta": {
                "tier": "pro" if is_pro else "free",
                "freeWindowSec": FREE_INCIDENT_WINDOW_SECONDS,
                "clamped": bool(clamped),
                "effectiveSince": effective_since,
            },
        }

    # Build a summary prompt from recent incidents
    incident_lines = []
    for inc in recent[:15]:
        loc = inc.get("location_text", "Unknown location")
        cat = inc["severity_category"].replace("_", " ")
        incident_lines.append(f"- {cat} at {loc} (confidence: {inc.get('confidence', 'N/A')})")

    prompt = (
        "You are a helpful assistant that summarizes recent public safety activity "
        f"in {CITY_NAME}. Given the following recent incidents extracted from police "
        "scanner audio (all UNVERIFIED), write a brief 2-3 sentence summary suitable "
        "for display on a community safety dashboard. Be factual, mention specific "
        "neighborhoods, and note that all data is unverified scanner audio.\n\n"
        "Recent incidents:\n" + "\n".join(incident_lines)
    )

    try:
        # Reduced timeout to 8s to prevent 502/504 errors from Vercel/Caddy
        text = await llm_client.chat_completion(
            [{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=200,
            timeout=8.0,
        )
        final_summary = text.strip()
        _SUMMARY_CACHE["summary"] = final_summary
        _SUMMARY_CACHE["incident_count"] = len(recent)
        _SUMMARY_CACHE["expires_at"] = now + 300.0  # Cache for 5 minutes
        return {
            "summary": final_summary,
            "incident_count": len(recent),
            "meta": {
                "tier": "pro" if is_pro else "free",
                "freeWindowSec": FREE_INCIDENT_WINDOW_SECONDS,
                "clamped": bool(clamped),
                "effectiveSince": effective_since,
            },
        }
    except Exception as e:
        logger.warning("Summary LLM call failed: %s", e)

    fallback_summary = f"{len(recent)} recent incidents across {CITY_NAME}. Check the map for details."
    _SUMMARY_CACHE["summary"] = fallback_summary
    _SUMMARY_CACHE["incident_count"] = len(recent)
    _SUMMARY_CACHE["expires_at"] = now + 60.0  # Cache fallback for 1 minute
    
    return {
        "summary": fallback_summary,
        "incident_count": len(recent),
        "meta": {
            "tier": "pro" if is_pro else "free",
            "freeWindowSec": FREE_INCIDENT_WINDOW_SECONDS,
            "clamped": bool(clamped),
            "effectiveSince": effective_since,
        },
    }


class PulseChatMessage(BaseModel):
    role: str
    content: str


class PulseChatRequest(BaseModel):
    """Pro-only chat over incident RAG. Client sends recent conversation tail."""

    city: Optional[str] = None
    since: Optional[str] = None
    messages: list[PulseChatMessage]


def _pulse_chat_rate_ok(uid: str) -> bool:
    """Fixed-window rate limit per uid (default 20 requests / 60s)."""
    now = time.time()
    floor = now - PULSE_CHAT_RL_WINDOW_SEC
    with _PULSE_CHAT_RL_LOCK:
        hits = _PULSE_CHAT_RL.setdefault(uid, [])
        while hits and hits[0] < floor:
            hits.pop(0)
        if len(hits) >= PULSE_CHAT_RL_MAX:
            return False
        hits.append(now)
    return True


def _normalize_pulse_city_slug(city: Optional[str]) -> str:
    slug = (city or "").strip().lower() or (CITY_SLUG or "").strip().lower()
    if not slug:
        raise HTTPException(status_code=400, detail="Missing city slug")
    if slug in CITY_REGISTRY or slug == (CITY_SLUG or "").strip().lower():
        return slug
    raise HTTPException(status_code=400, detail=f"Unknown city: {slug}")


def _trim_incident_for_pulse_bundle(inc: dict) -> dict:
    text = inc.get("raw_text") or inc.get("description") or ""
    text = str(text).replace("\n", " ").strip()[:480]
    return {
        "id": inc.get("id"),
        "reported_at": inc.get("reported_at"),
        "category": inc.get("severity_category"),
        "location": inc.get("location_text"),
        "text": text,
    }


_GUNISH_USER_RE = re.compile(
    r"\b(gun|guns|firearm|firearms|weapon|weapons|shoot|shooting|shooter|shot\b|"
    r"shots?\s+fired|pistol|rifle|gunfire|gunshot|handgun|ammo|magazine|armed|discharge)\b",
    re.I,
)


def _pulse_chat_last_user_message(chat_tail: list[dict[str, str]]) -> str:
    for m in reversed(chat_tail):
        if m.get("role") == "user":
            return str(m.get("content") or "")
    return ""


def _incident_gun_related(inc: dict) -> bool:
    """Heuristic match for firearm / shots / weapon language in scanner text."""
    cat = str(inc.get("severity_category") or "").lower()
    if cat in ("violent_weapon", "shots_heard"):
        return True
    blob = " ".join(
        [
            str(inc.get("raw_text") or ""),
            str(inc.get("description") or ""),
            str(inc.get("location_text") or ""),
        ]
    ).lower()
    needles = (
        "gun",
        "guns",
        "shoot",
        "shooting",
        "shot",
        "shots fired",
        "firearm",
        "weapon",
        "rifle",
        "pistol",
        "gunfire",
        "gunshot",
        "handgun",
        "magazine",
        "armed person",
        "person with a gun",
        "pgun",
        "gunsht",
    )
    return any(n in blob for n in needles)


def _build_pulse_chat_bundle(
    fetched: list[dict],
    last_user: str,
    bundle_max: int,
) -> tuple[list[dict], bool, bool]:
    """Build trimmed rows for the LLM. When the user message looks firearm-related,
    prepend up to `topic_cap` matching rows from the same `fetched` list (still
    bounded by fetch size), then fill with newest incidents. This is not a
    full-history scan — only rows present in `fetched`.
    """
    gunish = bool(_GUNISH_USER_RE.search(last_user))
    topic_cap = min(96, max(24, bundle_max // 2)) if gunish else 0

    seen: set[str] = set()
    bundle: list[dict] = []

    if gunish and topic_cap > 0:
        for inc in fetched:
            if len(bundle) >= topic_cap:
                break
            iid = str(inc.get("id") or "")
            if not iid or iid in seen:
                continue
            if not _incident_gun_related(inc):
                continue
            seen.add(iid)
            bundle.append(_trim_incident_for_pulse_bundle(inc))

    for inc in fetched:
        if len(bundle) >= bundle_max:
            break
        iid = str(inc.get("id") or "")
        if not iid or iid in seen:
            continue
        seen.add(iid)
        bundle.append(_trim_incident_for_pulse_bundle(inc))

    truncated_fetch = len(fetched) > len(bundle)
    return bundle, truncated_fetch, gunish


def _pulse_tokenize_keywords(q: str) -> list[str]:
    normalized = re.sub(r"[,;|]+", " ", (q or "").strip())
    return [t.lower() for t in normalized.split() if len(t) >= 2][:12]


def _pulse_incident_match_blob(inc: dict) -> str:
    parts = [
        str(inc.get("raw_text") or ""),
        str(inc.get("description") or ""),
        str(inc.get("location_text") or ""),
        str(inc.get("severity_category") or ""),
    ]
    return " ".join(parts).lower()


_LEAKED_TOOL_MARKERS = re.compile(
    r"<\|?\s*DSML|</?\s*(?:invoke|parameter|tool_call|tool_calls|function)\b|<\|\s*tool_calls",
    re.IGNORECASE,
)


def _looks_like_leaked_tool_call(text: str) -> bool:
    """True when the model emitted tool-call SYNTAX as plain text instead of a
    structured ``tool_calls`` field. DeepSeek's OpenAI-compatible endpoint
    sometimes returns ``<|DSML| |invoke name="search_incidents">...`` as content;
    the loop below uses this to retry in plain-text mode instead of leaking it."""
    return bool(text) and bool(_LEAKED_TOOL_MARKERS.search(text))


def _strip_leaked_tool_markup(text: str) -> str:
    """Defensively remove any leaked tool-call markup so raw syntax never reaches
    the user (final safety net behind the plain-text retry)."""
    if not text:
        return ""
    # Whole DSML tool_calls block, including the parameter values inside it.
    text = re.sub(
        r"<\|?\s*DSML[^>]*tool_calls\s*>.*?</\|?\s*DSML[^>]*tool_calls\s*>",
        "",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    # Generic invoke/parameter/tool_call blocks (Anthropic-style) with content.
    text = re.sub(
        r"<\s*(invoke|parameter|tool_call|tool_calls|function)\b[^>]*>.*?</\s*\1\s*>",
        "",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    # Any remaining stray DSML / pipe / tag tokens.
    text = re.sub(r"</?\|?\s*DSML\s*\|?[^>]*>", "", text, flags=re.IGNORECASE)
    text = re.sub(
        r"</?\s*(invoke|parameter|tool_call|tool_calls|function)\b[^>]*>",
        "",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"<\|[^>]*\|?>", "", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


_INCIDENT_ID_RE = re.compile(r"\b([0-9a-f]{12})\b")

_CARD_FIELDS = (
    "id", "reported_at", "severity_category", "s_base", "confidence",
    "description", "location_text", "lat", "lng", "raw_text", "audio_clip",
    "audio_url", "word_timings", "mention_count", "last_mention_at",
    "geocode_status", "location_confidence",
)


def _trim_incident_for_card(inc: dict) -> dict:
    """Slim an incident row down to the fields the frontend IncidentCard needs."""
    return {k: inc.get(k) for k in _CARD_FIELDS if k in inc}


def _pulse_inline_incident_cards(
    reply: str, by_id: dict[str, dict]
) -> tuple[str, list[dict]]:
    """Rewrite the reply so each cited incident id becomes a standalone block
    marker ``[[INC:<id>]]`` on its own line — the client renders these as full
    incident cards inline in the message flow. Markers go AFTER the citing line
    for prose/bullets and AFTER the whole table block for table rows, so a card
    never breaks a sentence or a markdown table. Returns (annotated_reply,
    cited_incidents) with incidents in first-cited order."""
    if not reply or not by_id:
        return reply, []

    def _ids_in(line: str) -> list[str]:
        seen_local: list[str] = []
        for iid in _INCIDENT_ID_RE.findall(line):
            if iid in by_id and iid not in seen_local:
                seen_local.append(iid)
        return seen_local

    def _strip_ids(line: str, ids: list[str]) -> str:
        for iid in ids:
            # "(id: ID)" / "(incident ID)" / "[ID]" wrappers, then a bare/`ID`.
            line = re.sub(
                r"[\(\[]\s*(?:incident|id)?\s*:?\s*`?" + iid + r"`?\s*[\)\]]",
                "",
                line,
                flags=re.IGNORECASE,
            )
            line = re.sub(r"`?\b" + iid + r"\b`?", "", line)
        # tidy trailing/duplicate punctuation left behind (e.g. "... activity  —  .")
        line = re.sub(r"[ \t]{2,}", " ", line)
        line = re.sub(r"\s+([.,;:])", r"\1", line)
        return line.rstrip().rstrip("—-–").rstrip()

    def _is_table_row(line: str) -> bool:
        s = line.strip()
        return s.startswith("|") and s.count("|") >= 2

    order: list[str] = []
    seen: set[str] = set()
    marked: set[str] = set()
    out: list[str] = []
    table_buf: list[str] = []
    in_table = False

    def _emit(iid: str) -> None:
        if iid not in marked:
            marked.add(iid)
            out.append(f"[[INC:{iid}]]")

    def _flush_table() -> None:
        nonlocal table_buf
        if table_buf:
            out.append("")
            for iid in table_buf:
                _emit(iid)
            table_buf = []

    for line in reply.split("\n"):
        ids = _ids_in(line)
        for iid in ids:
            if iid not in seen:
                seen.add(iid)
                order.append(iid)
        is_tbl = _is_table_row(line)
        if in_table and not is_tbl:
            _flush_table()
        out.append(_strip_ids(line, ids))
        if is_tbl:
            for iid in ids:
                if iid not in marked and iid not in table_buf:
                    table_buf.append(iid)
        else:
            for iid in ids:
                _emit(iid)
        in_table = is_tbl
    _flush_table()

    cited = [_trim_incident_for_card(by_id[iid]) for iid in order]
    return "\n".join(out), cited


def pulse_chat_tool_specs() -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "function": {
                "name": "search_incidents",
                "description": (
                    "Search incidents already loaded for this Ask Pulse request (initial fetch plus any "
                    "pages from fetch_older_incidents). Substring match on text, location, and category — "
                    "does not query the database (no Firestore reads)."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "keywords": {
                            "type": "string",
                            "description": (
                                "Comma or whitespace separated tokens. Default OR semantics (any token matches). "
                                "Example: shooting, gun, shots, firearm."
                            ),
                        },
                        "match_all_keywords": {
                            "type": "boolean",
                            "description": "If true, every keyword must appear in the incident text or category.",
                        },
                        "severity_category": {
                            "type": "string",
                            "description": "If set, incident.severity_category must match exactly.",
                        },
                        "since_reported_at": {
                            "type": "string",
                            "description": "If set, reported_at must be >= this ISO timestamp.",
                        },
                        "until_reported_at": {
                            "type": "string",
                            "description": "If set, reported_at must be <= this ISO timestamp.",
                        },
                        "limit": {"type": "integer", "description": "Max incidents to return (server capped)."},
                    },
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "fetch_older_incidents",
                "description": (
                    "Load ONE page of older incidents from storage with reported_at strictly before "
                    "before_reported_at. Uses Firestore document reads (budget is tiny per chat). "
                    "Call only when search_incidents on the current pool is not enough — e.g. pass the "
                    "oldest reported_at you have loaded."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "before_reported_at": {
                            "type": "string",
                            "description": "ISO timestamp upper bound (exclusive): rows are strictly older.",
                        },
                        "limit": {"type": "integer", "description": "Page size (server capped)."},
                    },
                    "required": ["before_reported_at"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "count_incidents",
                "description": (
                    "Cheap aggregate COUNT for this chat's city — answers 'how many X in time window Y' "
                    "without paging the rows. ALWAYS prefer this over fetch_older_incidents for "
                    "questions about totals, frequencies, or 'has anything happened in the last N days'. "
                    "Returns a single number plus the window/category you asked about. Costs roughly "
                    "one Firestore op regardless of result size. If you need the actual incident text, "
                    "follow up with search_incidents or fetch_older_incidents."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "severity_category": {
                            "type": "string",
                            "enum": list(SEVERITY_CATEGORIES),
                            "description": (
                                "Exact match against incident.severity_category. Omit to count all "
                                "categories. Phrase → category mapping: shot/shooting/gun fired → "
                                "violent_weapon; gunshots heard/shots heard (no target confirmed) → "
                                "shots_heard; stabbing/fight/assault without firearm → violent_no_weapon; "
                                "robbery → robbery; burglary/break-in → burglary_in_progress; medical "
                                "emergency/cardiac/stroke → medical_priority; non-urgent medical → "
                                "medical_other; fire/smoke/hazmat → fire_hazmat; crash WITH injury → "
                                "traffic_crash_injury; fender-bender/no injury → traffic_crash_no_injury; "
                                "loud noise/disturbance/argument → disorder; admin/test transmission → "
                                "admin_or_noise. Two related questions (e.g. 'gunshots') usually need "
                                "two calls: one for violent_weapon and one for shots_heard."
                            ),
                        },
                        "since": {
                            "type": "string",
                            "description": (
                                "ISO-8601 lower bound (inclusive) on reported_at. e.g. "
                                "'2026-05-02T00:00:00Z' for 'last 2 weeks' from 2026-05-16."
                            ),
                        },
                        "until": {
                            "type": "string",
                            "description": "ISO-8601 upper bound (exclusive). Defaults to now.",
                        },
                    },
                },
            },
        },
    ]


def _pulse_tool_exec_search(pool_by_id: dict[str, dict], args: dict[str, Any]) -> dict[str, Any]:
    keywords = _pulse_tokenize_keywords(str(args.get("keywords") or ""))
    match_all = bool(args.get("match_all_keywords"))
    cat = (args.get("severity_category") or "").strip() or None
    since = (args.get("since_reported_at") or "").strip() or None
    until = (args.get("until_reported_at") or "").strip() or None
    lim = int(args.get("limit") or 20)
    lim = max(1, min(40, lim, PULSE_CHAT_TOOL_RESULT_MAX))

    if not keywords and not cat and not since and not until:
        return {
            "error": "Provide keywords, severity_category, and/or since/until to avoid scanning the whole pool.",
            "incidents": [],
            "match_count": 0,
        }

    hits: list[dict] = []
    for inc in pool_by_id.values():
        ra = str(inc.get("reported_at") or "")
        if since and ra < since:
            continue
        if until and ra > until:
            continue
        if cat and str(inc.get("severity_category") or "") != cat:
            continue
        blob = _pulse_incident_match_blob(inc)
        if keywords:
            if match_all:
                if not all(k in blob for k in keywords):
                    continue
            elif not any(k in blob for k in keywords):
                continue
        hits.append(inc)

    hits.sort(key=lambda i: i.get("reported_at") or "", reverse=True)
    hits = hits[:lim]
    trimmed = [_trim_incident_for_pulse_bundle(i) for i in hits]
    return {
        "match_count": len(trimmed),
        "incidents": trimmed,
        "hint": "Subset of incidents loaded for this chat; not guaranteed full city coverage.",
    }


def _pulse_tool_exec_fetch_older(
    *,
    city_slug: str,
    effective_since: str | None,
    before_iso: str,
    page_limit: int,
    pool_by_id: dict[str, dict],
    fs_used: list[int],
) -> dict[str, Any]:
    """Synchronous store fetch; invoke via ``run_in_threadpool`` from the Ask Pulse handler."""
    if fs_used[0] >= PULSE_CHAT_FS_TOOL_FETCHES_MAX:
        return {
            "error": "fetch_budget_exhausted",
            "detail": f"At most {PULSE_CHAT_FS_TOOL_FETCHES_MAX} older-page fetches per Ask Pulse request.",
            "incidents": [],
            "added_new_ids": 0,
            "documents_returned": 0,
        }
    bio = (before_iso or "").strip()
    if not bio:
        return {"error": "missing_before_reported_at", "incidents": [], "added_new_ids": 0, "documents_returned": 0}

    rows = store.list_incidents_for_city(
        city_slug,
        since=effective_since,
        before_iso=bio,
        limit=page_limit,
        include_blocked=False,
    )
    fs_used[0] += 1
    added = 0
    for inc in rows:
        iid = str(inc.get("id") or "")
        if not iid or iid in pool_by_id:
            continue
        pool_by_id[iid] = inc
        added += 1
    rows.sort(key=lambda x: x.get("reported_at") or "", reverse=True)
    cap = min(PULSE_CHAT_TOOL_RESULT_MAX, max(1, page_limit))
    trimmed = [_trim_incident_for_pulse_bundle(i) for i in rows[:cap]]
    return {
        "documents_returned": len(rows),
        "added_new_ids": added,
        "pool_size": len(pool_by_id),
        "firestore_pages_used": fs_used[0],
        "incidents": trimmed,
        "hint": "One page, newest-first within the page; may repeat fetch if budget allows and history goes deeper.",
    }


def _pulse_tool_exec_count(
    *,
    city_slug: str,
    effective_since: str | None,
    args: dict[str, Any],
) -> dict[str, Any]:
    """Single-shot aggregate count for the `count_incidents` tool.

    Bounded by the caller's free-tier window (`effective_since`) so a free
    user can't cheaply probe deeper history than the rest of the API gives
    them. Returns -1-style sentinels via an `error` key if the backend
    can't satisfy the count (e.g. dev SQLite with no city column)."""
    cat = (str(args.get("severity_category") or "")).strip() or None
    since_arg = (str(args.get("since") or "")).strip() or None
    until_arg = (str(args.get("until") or "")).strip() or None

    # Pull the lower bound up to the caller's allowed window — don't let
    # the LLM pretend a free user can ask "how many in the last year".
    since = since_arg
    if effective_since:
        if not since or since < effective_since:
            since = effective_since
    until = until_arg

    try:
        n = store.count_city_incidents_filtered(
            city_slug,
            since_iso=since,
            until_iso=until,
            severity_category=cat,
        )
    except Exception as e:
        logger.warning("pulse-chat count_incidents failed: %s", e)
        return {"error": "count_unavailable", "detail": str(e)[:120]}

    if n < 0:
        return {
            "error": "count_unavailable",
            "detail": "Backend does not support aggregate count on this deployment.",
        }
    return {
        "count": n,
        "city": city_slug,
        "severity_category": cat,
        "since": since,
        "until": until,
        "clamped_to_user_window": bool(effective_since) and (since == effective_since) and bool(since_arg) and since_arg < (effective_since or ""),
        "hint": "Aggregate from Firestore .count(); not a list of incidents. Pair with search_incidents if the user needs the text.",
    }


@app.post("/api/pulse-chat")
async def pulse_chat(
    body: PulseChatRequest,
    authorization: Optional[str] = Header(None),
):
    """Pro-only natural-language Q&A over a bounded slice of scanner-sourced incidents.

    Uses the same Lambda/OpenAI-compatible stack as the rest of the API
    (:mod:`philly_pulse.llm_client`). Retrieval is RAG (not model training).
    """
    decoded = _try_verify_firebase_token(authorization)
    if not decoded:
        raise HTTPException(status_code=401, detail="Authentication required")
    if decoded.get("firebase", {}).get("sign_in_provider") == "anonymous":
        raise HTTPException(status_code=403, detail="Ask Pulse requires a non-anonymous account")
    if not _is_pro_uid(decoded):
        raise HTTPException(status_code=403, detail="CityPulse Pro required for Ask Pulse")
    uid = str(decoded.get("uid") or "")
    if not _pulse_chat_rate_ok(uid):
        raise HTTPException(status_code=429, detail="Too many Ask Pulse requests; try again shortly")

    if not body.messages:
        raise HTTPException(status_code=400, detail="messages must be non-empty")
    chat_tail: list[dict[str, str]] = []
    total_user_chars = 0
    for m in body.messages[-40:]:
        role = (m.role or "").strip().lower()
        if role not in ("user", "assistant"):
            continue
        c = (m.content or "")[:12000]
        if role == "user":
            total_user_chars += len(c)
        chat_tail.append({"role": role, "content": c})
    if total_user_chars > 80000:
        raise HTTPException(status_code=400, detail="Request too large")
    if not chat_tail or chat_tail[-1]["role"] != "user":
        raise HTTPException(status_code=400, detail="Last message must be a user message")

    city_slug = _normalize_pulse_city_slug(body.city)
    effective_since, _clamped = _apply_free_since(body.since, is_pro=True)
    last_user = _pulse_chat_last_user_message(chat_tail)

    import starlette.concurrency

    fetch_cap = min(PULSE_CHAT_STORE_FETCH, 800)
    if _GUNISH_USER_RE.search(last_user):
        fetch_cap = min(800, max(fetch_cap, 700))

    def _load():
        return store.list_incidents_for_city(
            city_slug,
            since=effective_since,
            limit=fetch_cap,
            include_blocked=False,
        )

    fetched = await starlette.concurrency.run_in_threadpool(_load)
    fetched.sort(key=lambda i: i.get("reported_at") or "", reverse=True)
    bundle, truncated_fetch, topic_boost = _build_pulse_chat_bundle(
        fetched, last_user, PULSE_CHAT_BUNDLE_MAX
    )
    bundle_json = json.dumps(bundle, ensure_ascii=False)

    registry_entry = CITY_REGISTRY.get(city_slug) or {}
    city_display = registry_entry.get("city_name") or CITY_NAME

    tool_block = ""
    if PULSE_CHAT_TOOLS_ENABLED:
        tool_block = (
            "\n- Tools: you may call ``search_incidents`` to filter the incidents already loaded for this "
            f"request (up to {len(fetched)} from the server prefetch; no extra database reads). You may call "
            f"``fetch_older_incidents`` at most {PULSE_CHAT_FS_TOOL_FETCHES_MAX} time(s) total — each call loads "
            f"one older page (capped at {PULSE_CHAT_FS_TOOL_PAGE_CAP} rows; uses Firestore document reads). "
            "Prefer search_incidents first; use fetch_older_incidents only when the prefetch window is not enough.\n"
            "- ``count_incidents`` returns a TRUE aggregate count (one Firestore op, full city history within the "
            "user's allowed window) for questions about totals / frequencies / 'has anything happened in the last N "
            "days'. ALWAYS use it before guessing from the JSON sample — the sample is the latest few hundred "
            "incidents, NOT the year/month total, so counting it is wrong. See the tool's severity_category enum "
            "for the exact category names and phrase mapping; multi-faceted questions (e.g. 'how many shootings') "
            "often need two calls — one for violent_weapon and one for shots_heard — and then a sum.\n"
            "- Ground factual claims in the initial JSON, tool outputs, and user messages. If tools return no "
            "matches or fetch budget is exhausted, say that in one short sentence. Never count occurrences of "
            "a word inside a transcript and report it as 'happened N times'.\n"
        )

    system = (
        "You are Ask Pulse, a careful assistant for CityPulse — a scanner-derived public safety feed. "
        "All incident data below is UNVERIFIED, may be incomplete or mistaken, and is not official "
        "police reporting. Never present it as confirmed fact.\n"
        "Rules:\n"
        "- Answer only using the incident JSON below"
        + (", tool results from this session," if PULSE_CHAT_TOOLS_ENABLED else ",")
        + " and the user's messages. If the answer is not "
        "supported by those sources, say you don't have enough in the current window and suggest "
        "broadening the time range or checking the map.\n"
        "- The JSON list is a trimmed sample of the most recent incidents (size capped, newest first). "
        "It is not guaranteed to cover every calendar span the user names; if their window likely "
        "extends beyond these rows, say that in one short sentence and answer from what is present.\n"
        "- For firearm- or shooting-related questions, the list may start with extra rows that match "
        "gun/shots/weapon language (still from the same capped fetch — not a full database or year tally).\n"
        + tool_block
        + "- CARD UI: the app renders a playable incident card for every incident you tag with "
        "its id. Whenever you mention a specific incident, write it as its own bullet that ends "
        "with its id in this EXACT form: `(id: <the 12-character id from the JSON>)`. Example:\n"
        "  `- 34th and 4th (10:00 UTC) — suspicious activity (id: 3b63a5ba37dd)`\n"
        "  Tag EVERY specific incident this way, copy the id exactly from the JSON, and do not put "
        "incidents inside tables.\n"
        "- Do not invent incidents, addresses, ids, or outcomes.\n"
        f"- City context: {city_display} ({city_slug}).\n\n"
        f"The following {len(bundle)} incidents (of {len(fetched)} fetched) are in context"
        + (" (truncated for size)" if truncated_fetch else "")
        + ":\n"
        + bundle_json
    )

    chat_model = (os.environ.get("PULSE_CHAT_MODEL") or "").strip() or None

    messages_out: list[dict[str, Any]] = [{"role": "system", "content": system}] + chat_tail

    if not llm_client.is_configured() and not llm_client.is_deepseek_pulse_fallback_configured():
        raise HTTPException(
            status_code=503,
            detail="Ask Pulse is unavailable: set LAMBDA_API_KEY / OPENAI_API_KEY or DEEPSEEK_API_KEY on the server",
        )

    reply = ""
    tool_rounds_used = 0
    firestore_tool_fetches = 0
    pool_size = len(fetched)

    try:
        if not PULSE_CHAT_TOOLS_ENABLED:
            reply = await llm_client.pulse_chat_completion(
                messages_out,
                model=chat_model,
                temperature=0.25,
                max_tokens=1400,
                timeout=75.0,
            )
            reply = (reply or "").strip()
        else:
            tools = pulse_chat_tool_specs()
            pool_by_id: dict[str, dict] = {}
            for inc in fetched:
                iid = str(inc.get("id") or "")
                if iid:
                    pool_by_id[iid] = inc
            fs_used = [0]
            messages_loop: list[dict[str, Any]] = [dict(x) for x in messages_out]
            tool_round_idx = 0
            leaked_retry = False
            while tool_round_idx < PULSE_CHAT_TOOL_ROUNDS_MAX:
                force_text = leaked_retry or tool_round_idx >= PULSE_CHAT_TOOL_ROUNDS_MAX - 1
                asst = await llm_client.pulse_chat_completion_message(
                    messages_loop,
                    model=chat_model,
                    temperature=0.25,
                    max_tokens=1400,
                    timeout=75.0,
                    tools=tools,
                    tool_choice="none" if force_text else "auto",
                )
                tool_round_idx += 1
                tool_rounds_used = tool_round_idx
                tcalls = asst.get("tool_calls")
                content = (asst.get("content") or "").strip()
                if not tcalls:
                    # Some providers (notably DeepSeek via the OpenAI-compat API)
                    # emit tool calls as TEXT in content instead of a structured
                    # tool_calls field. Don't leak that markup: nudge once to
                    # answer in plain text (the incident JSON is already in
                    # context), then fall back to stripping if it persists.
                    if (not force_text) and _looks_like_leaked_tool_call(content):
                        leaked_retry = True
                        messages_loop.append({
                            "role": "system",
                            "content": (
                                "Do not output tool-call syntax or XML. Answer the user "
                                "directly in plain text using the incident JSON already provided."
                            ),
                        })
                        continue
                    reply = _strip_leaked_tool_markup(content)
                    break
                if force_text:
                    reply = _strip_leaked_tool_markup(content)
                    if not reply:
                        reply = (
                            "I could not fully answer within the tool budget; try narrowing the time range "
                            "or checking the map for more context."
                        )
                    break
                msg_a: dict[str, Any] = {"role": "assistant", "content": (asst.get("content") or "") or ""}
                msg_a["tool_calls"] = tcalls
                messages_loop.append(msg_a)
                for tc in tcalls:
                    fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
                    name = str((fn or {}).get("name") or "")
                    raw_args = (fn or {}).get("arguments") or "{}"
                    tid_raw = tc.get("id")
                    tid = str(tid_raw) if tid_raw is not None else ""
                    if not tid:
                        tid = f"call_{name}_{tool_round_idx}"
                    try:
                        if isinstance(raw_args, str):
                            args = json.loads(raw_args)
                        elif isinstance(raw_args, dict):
                            args = raw_args
                        else:
                            args = {}
                    except json.JSONDecodeError:
                        args = {}
                    if not isinstance(args, dict):
                        args = {}
                    if name == "search_incidents":
                        out = _pulse_tool_exec_search(pool_by_id, args)
                    elif name == "fetch_older_incidents":
                        bio = str(args.get("before_reported_at") or "")
                        plim = int(args.get("limit") or 80)
                        plim = max(1, min(PULSE_CHAT_FS_TOOL_PAGE_CAP, plim))

                        def _fetch_sync():
                            return _pulse_tool_exec_fetch_older(
                                city_slug=city_slug,
                                effective_since=effective_since,
                                before_iso=bio,
                                page_limit=plim,
                                pool_by_id=pool_by_id,
                                fs_used=fs_used,
                            )

                        out = await starlette.concurrency.run_in_threadpool(_fetch_sync)
                    elif name == "count_incidents":
                        # Aggregate counts are cheap (one Firestore op
                        # regardless of result size); not subject to the
                        # fs_used page budget.
                        def _count_sync():
                            return _pulse_tool_exec_count(
                                city_slug=city_slug,
                                effective_since=effective_since,
                                args=args,
                            )

                        out = await starlette.concurrency.run_in_threadpool(_count_sync)
                    else:
                        out = {"error": "unknown_tool", "name": name}
                    messages_loop.append(
                        {
                            "role": "tool",
                            "tool_call_id": tid,
                            "content": json.dumps(out, ensure_ascii=False)[:29000],
                        }
                    )
            firestore_tool_fetches = fs_used[0]
            if not reply:
                reply = "I could not produce an answer from the available data and tools."
            pool_size = len(pool_by_id)
    except LLMConfigError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except LLMHTTPError as e:
        logger.warning("pulse-chat LLM HTTP error: %s", e)
        raise HTTPException(status_code=502, detail="Upstream LLM error") from e
    except Exception as e:
        logger.warning("pulse-chat LLM failed: %s", e)
        raise HTTPException(status_code=502, detail="LLM request failed") from e

    # Final safety net: never return raw tool-call markup to the client.
    reply = _strip_leaked_tool_markup(reply or "")
    if not reply:
        reply = "I couldn't produce a clean answer for that. Try rephrasing or narrowing the time range."

    # Turn cited incident ids into inline card markers + return the full rows so
    # the client can render each as a card in the message flow.
    incidents_by_id: dict[str, dict] = {}
    for inc in fetched:
        iid = str(inc.get("id") or "")
        if iid:
            incidents_by_id[iid] = inc
    reply, cited_incidents = _pulse_inline_incident_cards(reply, incidents_by_id)

    citations = [
        {"id": row["id"], "reported_at": row.get("reported_at"), "category": row.get("category")}
        for row in bundle
        if row.get("id")
    ]
    return {
        "reply": reply.strip(),
        "citations": citations,
        "cited_incidents": cited_incidents,
        "meta": {
            "city": city_slug,
            "effective_since": effective_since,
            "incidents_in_context": len(bundle),
            "incidents_fetched": len(fetched),
            "truncated": truncated_fetch,
            "fetch_cap": fetch_cap,
            "topic_boost": "firearms" if topic_boost else None,
            "tools_enabled": bool(PULSE_CHAT_TOOLS_ENABLED),
            "tool_rounds": tool_rounds_used if PULSE_CHAT_TOOLS_ENABLED else 0,
            "firestore_tool_fetches": firestore_tool_fetches if PULSE_CHAT_TOOLS_ENABLED else 0,
            "pool_incidents": pool_size,
        },
    }


@app.get("/api/stats")
def stats():
    """Inhibitor audit stats for the transparency page."""
    return {
        "total_incidents": store.incident_count(),
        "inhibitor_stats": store.inhibitor_stats(),
    }


@app.get("/api/city-stats/{slug}")
def city_stats(slug: str):
    """Landing-page numbers for a single city.

    Returns scanner feed count (from that city's config.yaml), incident
    counts (total + last 24h), and the city display name. Negative counts
    signal "unavailable" — the frontend falls back to static metadata.
    """
    cities_dir = Path(__file__).resolve().parent.parent / "cities"
    cfg_path = cities_dir / slug / "config.yaml"
    if not cfg_path.exists():
        raise HTTPException(status_code=404, detail=f"Unknown city: {slug}")

    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
    except Exception as e:
        logger.warning("Failed to read city config %s: %s", cfg_path, e)
        cfg = {}

    feeds = cfg.get("feeds", []) or []
    city_name = cfg.get("city", {}).get("name", slug)

    # Last-24h incident count (Firestore supports city filter; SQLite
    # dev returns -1).
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    try:
        incidents_24h = store.count_city_incidents(slug, since_iso=since)
    except Exception:
        incidents_24h = -1
    try:
        incidents_total = store.count_city_incidents(slug)
    except Exception:
        incidents_total = -1

    freshness = {}
    try:
        freshness = store.get_city_pipeline_freshness(slug, hours=6)
    except Exception:
        freshness = {}

    return {
        "slug": slug,
        "city_name": city_name,
        "scanner_feeds": len(feeds),
        "incidents_24h": incidents_24h,
        "incidents_total": incidents_total,
        "newest_incident_at": freshness.get("newest_incident_at"),
        "newest_extraction_at": freshness.get("newest_extraction_at"),
        "promotion_rate_6h": freshness.get("promotion_rate_6h"),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


# ── Admin endpoints ─────────────────────────────────────────────────

@app.websocket("/ws/admin")
async def admin_ws(ws: WebSocket):
    """WebSocket stream of all pipeline events for the admin panel.

    Browsers can't set request headers on a WebSocket, so the admin
    Firebase ID token is passed as the `token` query param. Verify it
    before accepting the socket — on any failure close with 1008
    (policy violation) prior to `accept()`.
    """
    token = ws.query_params.get("token")
    try:
        _verify_firebase_admin(f"Bearer {token}" if token else None)
    except HTTPException:
        await ws.close(code=1008)
        return
    await admin_events.connect(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await admin_events.disconnect(ws)


@app.get("/api/admin/feeds")
def admin_feeds(
    request: Request,
    city: str | None = Query(
        None,
        description="Pulse city slug (e.g. nyc, philly). Defaults from Host header, then server FEEDS.",
    ),
):
    """List of Broadcastify feeds — scoped per city when known.

    Intentionally PUBLIC (no auth). It returns only non-sensitive Broadcastify
    feed IDs + human-readable labels, which the public map page consumes to
    label incident sources (frontend/src/app/page.tsx). The admin panel also
    calls this (with a token), which is simply ignored here — unlike the other
    /api/admin/* routes, this one exposes no sensitive data or mutating action."""
    slug = (city or "").strip().lower()
    if not slug:
        raw_host = (request.headers.get("host") or "").lower()
        host = raw_host.split(":")[0]
        if host.startswith("www."):
            host = host[4:]
        slug = city_registry.DOMAIN_TO_SLUG.get(host, "")
    rows = city_registry.CITY_FEEDS.get(slug) if slug else None
    if rows:
        return {"feeds": rows}
    return {"feeds": FEEDS}


@app.get("/api/admin/prefilter/metrics")
async def admin_prefilter_metrics(authorization: Optional[str] = Header(None)):
    """In-process counters for the regex prefilter, per city.

    Each city entry has `seen` (total lines), `kept` (passed to LLM),
    and `skipped` (dropped before LLM). Resets when the worker restarts.
    """
    _verify_firebase_admin(authorization)
    return {"enabled": prefilter.PREFILTER_ENABLED, "metrics": prefilter.get_metrics()}


class PredictRequest(BaseModel):
    extraction_id: str


class VisibilityRequest(BaseModel):
    hidden: bool


@app.post("/api/admin/incident/{incident_id}/visibility")
async def admin_toggle_visibility(
    incident_id: str,
    req: VisibilityRequest,
    authorization: Optional[str] = Header(None),
):
    """Toggle an incident's visibility on the public map."""
    _verify_firebase_admin(authorization)
    result = store.update_incident(incident_id, {"hidden": req.hidden})
    if result is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    return {"status": "ok", "incident_id": incident_id, "hidden": req.hidden}


@app.delete("/api/admin/incident/{incident_id}")
async def admin_delete_incident(
    incident_id: str,
    authorization: Optional[str] = Header(None),
):
    """Permanently delete an incident."""
    _verify_firebase_admin(authorization)
    ok = store.delete_incident(incident_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Incident not found")
    return {"status": "deleted", "incident_id": incident_id}


@app.post("/api/admin/predict")
async def admin_predict(
    req: PredictRequest,
    authorization: Optional[str] = Header(None),
):
    """Run the full LLM + inhibitor + geocode pipeline on a stored extraction.

    Used for manual evaluation when LLM_AUTO_ENABLED is off.
    """
    _verify_firebase_admin(authorization)
    ext = store.get_extraction(req.extraction_id)
    if ext is None:
        raise HTTPException(status_code=404, detail="Extraction not found")

    raw_text = ext.get("raw_text", "")
    feed_id = ext.get("feed_id", "unknown")
    audio_clip = ext.get("audio_clip")
    reported_at = ext.get("reported_at")
    ext_city = ext.get("city", CITY_SLUG)
    if reported_at and re.match(r"^\d{1,2}:\d{2}(:\d{2})?$", str(reported_at).strip()):
        reported_at = f"{date.today().isoformat()}T{str(reported_at).strip()}"

    predict_llm_ctx = _get_city_llm_context(ext_city)
    predict_geo_ctx = _get_city_geo_context(ext_city)
    predict_feed_label = _resolve_feed_label(str(feed_id), None)

    # Adjacent-radio context (same as ingest path).
    prior_context: list[str] = []
    if reported_at:
        try:
            recent = store.get_recent_extractions(
                feed_id=feed_id,
                before_iso=reported_at,
                within_seconds=60,
                limit=3,
            )
            prior_context = [
                r.get("raw_text", "")
                for r in recent
                if r.get("raw_text") and r.get("id") != req.extraction_id
            ]
        except Exception as e:
            logger.debug("prior_context lookup failed (non-fatal): %s", e)

    try:
        result = await llm.extract_incident(
            raw_text,
            city_context=predict_llm_ctx,
            prior_context=prior_context or None,
            feed_label=predict_feed_label,
        )
    except llm.LLMError as e:
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")

    if result is None:
        store.update_extraction(req.extraction_id, {
            "llm_relevant": False,
            "llm_confidence": 0.0,
            "llm_category": None,
            "llm_location_text": None,
        })
        return {"status": "not_relevant", "extraction_id": req.extraction_id}

    category = result["severity_category"]
    location_text = result["location_text"]
    pred_suffix = (predict_geo_ctx or {}).get("suffix") or (predict_llm_ctx or {}).get("geocode_suffix") or ""
    if location_text and pred_suffix:
        location_text = geocode.normalize_location_text_for_geocode(
            location_text, suffix=pred_suffix
        )
    confidence = result["confidence"]
    s_base = weights.get_s_base(category)

    # Inhibitor
    inh = await inhibitor.check_incident(
        raw_transcript=raw_text,
        severity_category=category,
        location_text=location_text,
        confidence=confidence,
    )

    # Geocode via Nominatim only. See ingest path / plan: incident_geocode_hallucination.
    location_confidence = result.get("location_confidence", "none")
    lat, lng = None, None
    geocode_status = "failed"
    if location_text:
        coords = await geocode.geocode(location_text, geo_ctx=predict_geo_ctx)
        if coords:
            lat, lng = coords
            geocode_status = f"success_{location_confidence}"
        else:
            geocode_status = f"no_result_{location_confidence}"

    store.update_extraction(req.extraction_id, {
        "llm_relevant": True,
        "llm_category": category,
        "llm_confidence": confidence,
        "llm_location_text": location_text,
        "location_confidence": location_confidence,
        "inhibitor_status": inh.status,
        "inhibitor_reason": inh.reason,
        "geocode_status": geocode_status,
    })

    return {
        "status": "predicted",
        "extraction_id": req.extraction_id,
        "llm_relevant": True,
        "category": category,
        "confidence": confidence,
        "location_text": location_text,
        "location_confidence": location_confidence,
        "inhibitor_status": inh.status,
        "inhibitor_reason": inh.reason,
        "geocode_status": geocode_status,
        "lat": lat,
        "lng": lng,
    }


class RetranscribeRequest(BaseModel):
    extraction_id: str
    highpass_hz: int = 100
    vad_aggressiveness: int | None = 1
    norm_percentile: int | None = 95
    beam_size: int = 5


@app.post("/api/admin/retranscribe")
async def admin_retranscribe(
    req: RetranscribeRequest,
    authorization: Optional[str] = Header(None),
):
    """Re-preprocess + re-transcribe an extraction with custom params.

    Reads the raw audio clip from disk, applies the specified preprocessing,
    runs Whisper, saves a new processed clip, and appends the result to the
    extraction's variants array as 'custom_N'.
    """
    _verify_firebase_admin(authorization)
    from .preprocess import VariantConfig, preprocess_audio

    ext = store.get_extraction(req.extraction_id)
    if ext is None:
        raise HTTPException(status_code=404, detail="Extraction not found")

    raw_clip_id = ext.get("raw_audio_clip")
    if not raw_clip_id:
        raise HTTPException(status_code=400, detail="No raw audio clip stored for this extraction")

    raw_path = Path("audio_clips_raw") / f"{raw_clip_id}.wav"
    if not raw_path.exists():
        raise HTTPException(status_code=404, detail="Raw audio file not found on disk")

    import wave as _wave
    with _wave.open(str(raw_path), "r") as wf:
        n_frames = wf.getnframes()
        raw_bytes = wf.readframes(n_frames)
        raw_pcm = np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float32) / 32768.0

    cfg = VariantConfig(
        name="custom",
        highpass_hz=req.highpass_hz,
        vad_aggressiveness=req.vad_aggressiveness,
        norm_percentile=req.norm_percentile,
    )
    processed, meta = preprocess_audio(raw_pcm, cfg)

    from faster_whisper import WhisperModel as _WM

    _model_size = _bf_config.get("tuning", {}).get("model_size", "base") if _bf_config else "base"
    _language = _bf_config.get("tuning", {}).get("language", "en") if _bf_config else "en"
    _initial_prompt = _bf_config.get("tuning", {}).get("initial_prompt", "") if _bf_config else ""
    _no_speech = _bf_config.get("tuning", {}).get("no_speech_threshold", 0.6) if _bf_config else 0.6

    whisper = _WM(_model_size, device="cpu", compute_type="int8", cpu_threads=2)
    segments, _info = whisper.transcribe(
        processed,
        language=_language,
        initial_prompt=_initial_prompt,
        condition_on_previous_text=False,
        temperature=0.0,
        beam_size=req.beam_size,
        patience=1.5,
        suppress_blank=True,
        no_speech_threshold=_no_speech,
    )
    segments = list(segments)
    text = " ".join(s.text for s in segments).strip()
    no_speech_prob = max((s.no_speech_prob for s in segments), default=0)
    duration_s = round(len(processed) / 16000, 2)

    import uuid as _uuid
    clip_id = _uuid.uuid4().hex[:12]
    clip_path = Path("audio_clips") / f"{clip_id}.wav"
    pcm_out = (processed * 32767).astype(np.int16)
    with _wave.open(str(clip_path), "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(pcm_out.tobytes())

    existing_variants = ext.get("variants") or []
    custom_count = sum(1 for v in existing_variants if v.get("name", "").startswith("custom"))

    new_variant = {
        "name": f"custom_{custom_count + 1}",
        "audio_clip": clip_id,
        "transcript": text,
        "preprocess_meta": meta,
        "whisper_meta": {
            "no_speech_prob": round(no_speech_prob, 4),
            "duration_s": duration_s,
        },
    }

    existing_variants.append(new_variant)
    store.update_extraction(req.extraction_id, {"variants": existing_variants})

    del whisper
    import gc
    gc.collect()

    return {"status": "ok", "variant": new_variant}


@app.get("/api/admin/stream/{feed_id}")
async def admin_stream(feed_id: str, token: str = Query("")):
    """Proxy a Broadcastify MP3 stream for the admin audio player.

    Played via an <audio> element, which can't set request headers, so
    the admin Firebase ID token arrives as the `token` query param.
    """
    _verify_firebase_admin(f"Bearer {token}")
    if not _bf_username or not _bf_password:
        raise HTTPException(status_code=503, detail="Broadcastify credentials not configured")

    valid_ids = {f["feed_id"] for f in FEEDS}
    if feed_id not in valid_ids:
        raise HTTPException(status_code=404, detail=f"Unknown feed_id: {feed_id}")

    url = f"http://{_bf_username}:{_bf_password}@audio.broadcastify.com/{feed_id}.mp3"

    def stream_audio():
        proc = subprocess.Popen(
            [
                "ffmpeg", "-reconnect", "1", "-reconnect_streamed", "1",
                "-reconnect_delay_max", "5", "-i", url,
                "-acodec", "libmp3lame", "-ab", "64k", "-ar", "22050", "-ac", "1",
                "-f", "mp3", "-loglevel", "quiet", "-",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        try:
            while True:
                chunk = proc.stdout.read(4096)
                if not chunk:
                    break
                yield chunk
        finally:
            proc.kill()
            proc.wait()

    return StreamingResponse(stream_audio(), media_type="audio/mpeg")


# ── Web Push (VAPID) ────────────────────────────────────────────────
#
# All push endpoints require a Firebase ID token in the Authorization
# header (`Bearer …`) so a subscription is always tied to a real user
# UID. We deliberately don't rely on a session cookie here: the client
# already speaks Firebase Auth for everything else, and ID tokens are
# the same trust signal Firestore enforces for everything else.

def _verify_firebase_token(authorization: Optional[str]) -> dict:
    """Returns the decoded token dict on success, raises 401 otherwise."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    try:
        from firebase_admin import auth as fb_auth
        # `check_revoked=False` keeps the round-trip cheap; if a user
        # revokes a session we'll still expire them at the next token
        # refresh (1h max), which is fine for push subscription scope.
        decoded = fb_auth.verify_id_token(token, check_revoked=False)
    except Exception as e:
        logger.info("Firebase token verification failed: %s", e)
        raise HTTPException(status_code=401, detail="Invalid Firebase ID token") from e
    if not decoded.get("uid"):
        raise HTTPException(status_code=401, detail="Token missing uid")
    # Anonymous users can read but not subscribe — push is per-account
    # by design (otherwise we'd send to whatever device the next anon
    # session lands on and that's a fast way to spook a stranger).
    if decoded.get("firebase", {}).get("sign_in_provider") == "anonymous":
        raise HTTPException(
            status_code=403, detail="Push requires a non-anonymous account"
        )
    return decoded


# Keep in sync with ADMIN_EMAILS in frontend/src/contexts/AuthContext.tsx
# and the isAdmin() function in firestore.rules. All three places must
# reference the same set or the admin surface goes inconsistent — a
# user could see admin UI and have their writes silently rejected, or
# vice versa.
_ADMIN_EMAILS = {
    "eliyoung4now@gmail.com",
    "kethansany@gmail.com",
    "rickywhy@gmail.com",
}


_TIER_CACHE: dict[str, tuple[float, str]] = {}
def _user_tier(uid: str) -> str:
    """Read the calling user's billing tier from `users/{uid}.tier`.

    Returns one of "free", "pro", "enterprise" — matches the values
    the AuthContext writes from the frontend. Anything unrecognised
    or any read failure falls back to "free" so the caller never
    accidentally grants Pro on a Firestore outage."""
    import time
    now = time.time()
    if uid in _TIER_CACHE and _TIER_CACHE[uid][0] > now:
        return _TIER_CACHE[uid][1]

    try:
        from .firestore_store import _ensure_client
        snap = _ensure_client().collection("users").document(uid).get()
        if snap.exists:
            t = ((snap.to_dict() or {}).get("tier") or "free")
            if t in ("free", "pro", "enterprise"):
                _TIER_CACHE[uid] = (now + 300, t)
                return t
    except Exception as e:
        logger.debug("_user_tier read failed for %s: %s", uid, e)
    _TIER_CACHE[uid] = (now + 60, "free")
    return "free"


def _is_pro_uid(decoded: dict) -> bool:
    """Pro check used by Pro-gated endpoints. Admins always count as
    Pro because they need to be able to dogfood the gated features."""
    email = (decoded.get("email") or "").lower()
    if email and email in _ADMIN_EMAILS:
        return True
    uid = decoded.get("uid") or ""
    if not uid:
        return False
    return _user_tier(uid) in ("pro", "enterprise")


def _require_pro(decoded: dict) -> None:
    if not _is_pro_uid(decoded):
        raise HTTPException(status_code=402, detail="Pro subscription required")


_TOKEN_CACHE: dict[str, tuple[float, dict]] = {}
def _try_verify_firebase_token(authorization: Optional[str]) -> dict | None:
    """Best-effort Firebase token verification.

    Returns decoded token dict when valid; otherwise returns None.
    Unlike `_verify_firebase_token`, this never raises — it exists so
    read endpoints can treat missing/invalid auth as "free".
    """
    if not authorization or not str(authorization).lower().startswith("bearer "):
        return None
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        return None
        
    import time
    now = time.time()
    if token in _TOKEN_CACHE and _TOKEN_CACHE[token][0] > now:
        return _TOKEN_CACHE[token][1]

    try:
        from firebase_admin import auth as fb_auth
        decoded = fb_auth.verify_id_token(token, check_revoked=False)
    except Exception:
        return None
    if not decoded or not decoded.get("uid"):
        return None
        
    _TOKEN_CACHE[token] = (now + 300, decoded)
    return decoded


def _parse_iso_datetime(s: str | None) -> datetime | None:
    """Best-effort ISO-8601 parser.

    Returns an aware datetime in UTC when possible; None on failure.
    """
    if not s:
        return None
    raw = str(s).strip()
    if not raw:
        return None
    try:
        # Accept trailing Z.
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _free_since_dt(now: datetime | None = None) -> datetime:
    base = now or datetime.now(timezone.utc)
    return base - timedelta(seconds=FREE_INCIDENT_WINDOW_SECONDS)


def _apply_free_since(
    requested_since_iso: str | None,
    is_pro: bool,
) -> tuple[str | None, bool]:
    """Return (effective_since_iso, clamped) for incident read endpoints."""
    if is_pro:
        return requested_since_iso, False
    cutoff = _free_since_dt()
    cutoff_iso = cutoff.isoformat()
    dt = _parse_iso_datetime(requested_since_iso)
    if not dt:
        return cutoff_iso, False
    if dt < cutoff:
        return cutoff_iso, True
    return requested_since_iso or cutoff_iso, False


def _verify_firebase_admin(authorization: Optional[str]) -> dict:
    """Strict variant of `_verify_firebase_token`: also requires the
    decoded token's email to be in the admin allow-list AND email-
    verified. Raises 403 if the user is signed in but not an admin,
    so the frontend can distinguish "you're not allowed" from "you
    aren't authenticated"."""
    decoded = _verify_firebase_token(authorization)
    email = (decoded.get("email") or "").lower()
    if not email or email not in _ADMIN_EMAILS:
        raise HTTPException(status_code=403, detail="Admin only")
    if not decoded.get("email_verified"):
        # We require email verification specifically for admin actions
        # so a stolen-not-yet-verified Google account can't immediately
        # take destructive moderation actions. Regular auth doesn't
        # enforce this.
        raise HTTPException(status_code=403, detail="Verify email to act as admin")
    return decoded


# Shared secret for machine ingest endpoints (transcriber pipeline -> server).
# Read once at module load, like `_COMMUTE_TICK_SECRET`. When set we enforce it;
# when unset we warn once and allow, so a deploy that hasn't configured the env
# var yet doesn't kill the live transcriber feed.
_PULSE_INGEST_SECRET = os.getenv("PULSE_INGEST_SECRET")
_INGEST_SECRET_WARNED = False


def _verify_ingest_secret(authorization: Optional[str]) -> None:
    """Authenticate a machine ingest request via the `PULSE_INGEST_SECRET`
    shared secret passed as a Bearer token.

    Enforce-when-set: a missing or mismatched secret raises 401 (constant-time
    compare). Allow-when-unset: log a single warning and permit the request so
    the live pipeline keeps working during a non-breaking rollout.
    """
    global _INGEST_SECRET_WARNED
    if not _PULSE_INGEST_SECRET:
        if not _INGEST_SECRET_WARNED:
            logger.warning(
                "PULSE_INGEST_SECRET is not set; ingest endpoints are unauthenticated. "
                "Set it to require a Bearer secret from the transcriber pipeline."
            )
            _INGEST_SECRET_WARNED = True
        return
    expected = f"Bearer {_PULSE_INGEST_SECRET}"
    if not authorization or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Bad ingest credentials")


class PushSubscribeRequest(BaseModel):
    """Mirrors `PushSubscription.toJSON()` plus a tiny client context.

    `notifyLat`/`notifyLng`/`notifyRadiusKm` are optional alert-area
    fields. When set, the user wants closed-tab pings for nearby
    high-severity scanner incidents. Omitting them means "subscribe
    me to direct messages only" — useful for users who want test
    pings + future direct alerts but don't want neighborhood-wide
    notifications."""
    endpoint: str
    p256dh: str
    auth: str
    userAgent: str | None = None
    city: str | None = None
    notifyLat: float | None = None
    notifyLng: float | None = None
    notifyRadiusKm: float | None = None


@app.get("/api/push/public-key")
async def push_public_key():
    """Public-readable VAPID key for the browser's `pushManager.subscribe`."""
    key = push_mod.public_key_b64url()
    return {
        "publicKey": key,
        "configured": bool(key) and push_mod.push_available(),
    }


@app.post("/api/push/subscribe")
async def push_subscribe(
    body: PushSubscribeRequest,
    authorization: Optional[str] = Header(None),
):
    """Idempotent — same endpoint URL upserts the existing row so a
    user who toggles the setting off+on doesn't accumulate ghost
    rows in Firestore."""
    decoded = _verify_firebase_token(authorization)
    uid = decoded["uid"]
    if not push_mod.push_available():
        # We accept the subscription anyway so a deploy that turns
        # push on later can immediately push to existing subscribers
        # without round-tripping the user. The frontend surfaces the
        # "configured: false" state to set expectations.
        logger.info("Accepting push subscription while server-side push is not configured")

    try:
        sub = push_mod.PushSubscription(
            endpoint=body.endpoint,
            p256dh=body.p256dh,
            auth=body.auth,
            uid=uid,
            user_agent=(body.userAgent or "")[:200],  # bound it; some UA strings are huge
            city=(body.city or "")[:64],
            notify_lat=body.notifyLat,
            notify_lng=body.notifyLng,
            notify_radius_km=body.notifyRadiusKm if body.notifyRadiusKm is not None else 3.0,
        )
        doc_id = push_mod.upsert_subscription(sub)
    except Exception as e:
        logger.warning("push subscription upsert failed: %s", e)
        raise HTTPException(status_code=500, detail="Failed to store subscription") from e
    return {"status": "ok", "id": doc_id}


class PushUnsubscribeRequest(BaseModel):
    endpoint: str


@app.post("/api/push/unsubscribe")
async def push_unsubscribe(
    body: PushUnsubscribeRequest,
    authorization: Optional[str] = Header(None),
):
    decoded = _verify_firebase_token(authorization)
    uid = decoded["uid"]
    try:
        ok = push_mod.delete_subscription(body.endpoint, expected_uid=uid)
    except Exception as e:
        logger.warning("push subscription delete failed: %s", e)
        raise HTTPException(status_code=500, detail="Failed to remove subscription") from e
    return {"status": "ok" if ok else "not_found"}


@app.get("/api/push/devices")
async def push_list_devices(authorization: Optional[str] = Header(None)):
    """List the calling user's push subscriptions across devices.

    The endpoint URL is intentionally truncated in the response so
    the client doesn't accidentally render a 250-char FCM URL into
    the UI; the doc id (a hash of the endpoint) is the stable
    handle for revoke calls. UA + alert area are surfaced so users
    can recognize "this is my old phone" without leaking the
    underlying push-service identifiers."""
    decoded = _verify_firebase_token(authorization)
    uid = decoded["uid"]
    try:
        subs = push_mod.list_subscriptions_for_uid(uid)
    except Exception as e:
        logger.warning("push devices list failed: %s", e)
        raise HTTPException(status_code=500, detail="Failed to list devices") from e

    out = []
    for s in subs:
        endpoint = str(s.get("endpoint") or "")
        # Show enough of the endpoint to disambiguate identical
        # user-agents (e.g. two Chromes on different desktops) but
        # not enough to be a meaningful credential.
        endpoint_hint = endpoint[-12:] if endpoint else ""
        out.append({
            "id": s.get("id"),
            "userAgent": s.get("userAgent") or "",
            "city": s.get("city") or "",
            "createdAtMs": int(s.get("createdAtMs") or 0),
            "lastUsedMs": int(s.get("lastUsedMs") or 0),
            "lastNearbyPushMs": int(s.get("lastNearbyPushMs") or 0),
            "notifyLat": s.get("notifyLat"),
            "notifyLng": s.get("notifyLng"),
            "notifyRadiusKm": s.get("notifyRadiusKm"),
            "endpointHint": endpoint_hint,
        })
    # Sort newest first so the most recent registration is on top.
    out.sort(key=lambda r: r["createdAtMs"], reverse=True)
    return {"devices": out}


class PushRevokeDeviceRequest(BaseModel):
    """Revoke a single device by its subscription doc id (the SHA-256
    hash of the endpoint URL). Using the id rather than the raw
    endpoint URL avoids ever needing to round-trip the (long, push-
    service-credentialed) endpoint string back to the server."""
    deviceId: str


@app.post("/api/push/revoke-device")
async def push_revoke_device(
    body: PushRevokeDeviceRequest,
    authorization: Optional[str] = Header(None),
):
    decoded = _verify_firebase_token(authorization)
    uid = decoded["uid"]
    try:
        result = push_mod.revoke_subscription_by_id(body.deviceId, uid)
    except Exception as e:
        logger.warning("push revoke-device failed: %s", e)
        raise HTTPException(status_code=500, detail="Failed to revoke device") from e
    if result == "forbidden":
        raise HTTPException(status_code=403, detail="Not your device")
    return {"status": result}


# ── Keyword scanner watches (Pro) ───────────────────────────────────
#
# These endpoints back the "notify me when 'shooting' is mentioned"
# feature. The store layer lives in push.py; the API surface enforces
# Pro-tier gating, normalizes input, and caps per-user watch count
# so a single account can't spawn an unbounded number of fanouts.

_MAX_WATCHES_PER_USER = 25
_MAX_KEYWORD_LEN = 64


class KeywordWatchCreateRequest(BaseModel):
    keyword: str
    city: Optional[str] = None
    severityFloor: Optional[float] = 0.0


class KeywordWatchUpdateRequest(BaseModel):
    active: Optional[bool] = None
    severityFloor: Optional[float] = None


def _watch_to_response(w: dict) -> dict:
    return {
        "id": w.get("id"),
        "keyword": w.get("keyword") or "",
        "city": w.get("city") or "",
        "severityFloor": float(w.get("severityFloor") or 0.0),
        "active": bool(w.get("active", True)),
        "createdAtMs": int(w.get("createdAtMs") or 0),
        "lastFiredMs": int(w.get("lastFiredMs") or 0),
        "lastIncidentId": w.get("lastIncidentId") or None,
    }


@app.get("/api/keyword-watches")
async def list_keyword_watches(authorization: Optional[str] = Header(None)):
    """Return every keyword watch the calling user owns. Read-only is
    allowed for free users so the UI can show the existing watches and
    a Pro-upsell when they try to add another."""
    decoded = _verify_firebase_token(authorization)
    uid = decoded["uid"]
    try:
        watches = push_mod.list_keyword_watches_for_uid(uid)
    except Exception as e:
        logger.warning("list_keyword_watches failed: %s", e)
        raise HTTPException(status_code=500, detail="Failed to list watches") from e
    watches.sort(key=lambda w: w.get("createdAtMs") or 0, reverse=True)
    return {
        "watches": [_watch_to_response(w) for w in watches],
        "isPro": _is_pro_uid(decoded),
        "maxWatches": _MAX_WATCHES_PER_USER,
    }


@app.post("/api/keyword-watches")
async def create_keyword_watch(
    body: KeywordWatchCreateRequest,
    authorization: Optional[str] = Header(None),
):
    """Pro-only. Creates a watch and returns the newly-created doc."""
    decoded = _verify_firebase_token(authorization)
    _require_pro(decoded)
    uid = decoded["uid"]

    keyword = (body.keyword or "").strip()
    if not keyword or len(keyword) > _MAX_KEYWORD_LEN:
        raise HTTPException(status_code=400, detail="Keyword must be 1-64 chars")
    # Don't allow nakedly broad single-letter watches.
    if len(keyword.strip('"')) < 2:
        raise HTTPException(status_code=400, detail="Keyword too short")

    try:
        existing = push_mod.list_keyword_watches_for_uid(uid)
    except Exception as e:
        logger.warning("list watches failed: %s", e)
        existing = []
    if len(existing) >= _MAX_WATCHES_PER_USER:
        raise HTTPException(status_code=400, detail=f"Watch limit reached ({_MAX_WATCHES_PER_USER})")
    # Prevent dupes (case-insensitive). Keeps the user's settings page
    # from silently filling with copies on rapid double-submits.
    norm = keyword.lower()
    if any((str(w.get("keyword") or "").lower() == norm) for w in existing):
        raise HTTPException(status_code=400, detail="Watch already exists")

    severity_floor = float(body.severityFloor or 0.0)
    if severity_floor < 0.0 or severity_floor > 1.0:
        severity_floor = max(0.0, min(1.0, severity_floor))

    city = (body.city or "").strip()
    now_ms = int(time.time() * 1000)
    doc_ref = (
        push_mod._db().collection("keywordWatches").document()  # type: ignore[attr-defined]
    )
    payload = {
        "uid": uid,
        "keyword": keyword,
        "city": city,
        "severityFloor": severity_floor,
        "active": True,
        "createdAtMs": now_ms,
        "lastFiredMs": 0,
        "lastIncidentId": None,
    }
    doc_ref.set(payload)
    return {"watch": _watch_to_response({"id": doc_ref.id, **payload})}


@app.patch("/api/keyword-watches/{watch_id}")
async def update_keyword_watch(
    watch_id: str,
    body: KeywordWatchUpdateRequest,
    authorization: Optional[str] = Header(None),
):
    """Toggle active or change severity floor. No keyword edits — those
    require deleting and re-creating so the change is intentional."""
    decoded = _verify_firebase_token(authorization)
    uid = decoded["uid"]
    ref = push_mod._db().collection("keywordWatches").document(watch_id)  # type: ignore[attr-defined]
    snap = ref.get()
    if not snap.exists:
        raise HTTPException(status_code=404, detail="Watch not found")
    data = snap.to_dict() or {}
    if data.get("uid") != uid:
        raise HTTPException(status_code=403, detail="Not your watch")

    updates: dict[str, Any] = {}
    if body.active is not None:
        updates["active"] = bool(body.active)
    if body.severityFloor is not None:
        sf = max(0.0, min(1.0, float(body.severityFloor)))
        updates["severityFloor"] = sf
    if not updates:
        return {"watch": _watch_to_response({"id": watch_id, **data})}
    # Pro check only if turning a watch back on — disabling is always
    # allowed (so a user who downgrades doesn't get stuck with active
    # watches they can't silence).
    if updates.get("active") is True and not _is_pro_uid(decoded):
        raise HTTPException(status_code=402, detail="Pro subscription required")
    ref.update(updates)
    merged = {**data, **updates, "id": watch_id}
    return {"watch": _watch_to_response(merged)}


@app.delete("/api/keyword-watches/{watch_id}")
async def delete_keyword_watch(
    watch_id: str,
    authorization: Optional[str] = Header(None),
):
    decoded = _verify_firebase_token(authorization)
    uid = decoded["uid"]
    ref = push_mod._db().collection("keywordWatches").document(watch_id)  # type: ignore[attr-defined]
    snap = ref.get()
    if not snap.exists:
        return {"status": "not_found"}
    data = snap.to_dict() or {}
    if data.get("uid") != uid:
        raise HTTPException(status_code=403, detail="Not your watch")
    ref.delete()
    return {"status": "ok"}


_COMMUTE_TICK_SECRET = os.getenv("PHILLY_PULSE_COMMUTE_TICK_SECRET")


@app.post("/api/push/tick-commutes")
async def push_tick_commutes(authorization: Optional[str] = Header(None)):
    """Cron-driven scan that fires commute prediction pushes for any
    schedules whose typical departure window contains "now".

    Auth model: a shared secret (`PHILLY_PULSE_COMMUTE_TICK_SECRET`)
    passed as a Bearer token. Using a static secret rather than a
    Firebase token means the cron job (GitHub Actions, Cloud
    Scheduler, etc.) doesn't need to mint user credentials. If the
    secret isn't configured, the endpoint refuses every request to
    avoid an accidentally-public commute scan in development."""
    if not _COMMUTE_TICK_SECRET:
        raise HTTPException(status_code=503, detail="Commute tick not configured")
    expected = f"Bearer {_COMMUTE_TICK_SECRET}"
    if not authorization or authorization != expected:
        raise HTTPException(status_code=401, detail="Bad tick credentials")
    try:
        result = push_mod.notify_due_commutes()
    except Exception as e:
        logger.warning("commute tick failed: %s", e)
        raise HTTPException(status_code=500, detail="Commute tick failed") from e
    return {"status": "ok", **result}


@app.post("/api/push/test")
async def push_test(authorization: Optional[str] = Header(None)):
    """Send a verification ping to every device the calling user has
    subscribed. The response includes per-device counts so the UI can
    surface "we tried 2 devices, 1 succeeded" rather than a blunt
    pass/fail."""
    decoded = _verify_firebase_token(authorization)
    uid = decoded["uid"]
    if not push_mod.push_available():
        raise HTTPException(
            status_code=503,
            detail="Server-side push is not configured (missing VAPID env vars).",
        )
    payload = {
        "kind": "test",
        "title": f"{CITY_NAME} Pulse push is working",
        "body": "You'll get alerts here when something nearby happens.",
        "tag": "pp:push-test",
    }
    result = push_mod.send_to_uid(uid, payload, ttl_seconds=120)
    if result["sent"] == 0 and result["failed"] == 0 and result["gone"] == 0:
        # Don't 404 — just tell the truth so the UI can prompt
        # "looks like you haven't subscribed any devices yet."
        return {"status": "no_devices", **result}
    return {"status": "ok", **result}


@app.get("/api/audio/{clip_id}")
async def get_audio_clip(clip_id: str):
    """Serve an audio clip — local disk first, else proxy bytes from Firebase Storage.

    Do not redirect to ``storage.googleapis.com``: the SPA uses ``fetch()`` to
    decode waveforms; a 302 makes the browser enforce CORS on the final URL, and
    public buckets typically omit ``Access-Control-Allow-Origin`` for web apps.
    """
    if not re.fullmatch(r"[a-f0-9]{12}", clip_id):
        raise HTTPException(status_code=400, detail="Invalid clip ID")

    # Try local disk first (for backward compatibility with existing clips)
    clip_path = _AUDIO_CLIPS_DIR / f"{clip_id}.wav"
    if clip_path.exists():
        from fastapi.responses import FileResponse
        return FileResponse(
            path=str(clip_path),
            media_type="audio/wav",
            headers={"Cache-Control": "public, max-age=86400"},
        )

    object_path = f"audio/{clip_id}.wav"
    last_status: int | None = None
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            for bucket in _storage_bucket_candidates():
                url = f"https://storage.googleapis.com/{bucket}/{object_path}"
                resp = await client.get(url)
                last_status = resp.status_code
                if resp.status_code == 200:
                    return Response(
                        content=resp.content,
                        media_type="audio/wav",
                        headers={"Cache-Control": "public, max-age=86400"},
                    )
    except httpx.RequestError as e:
        logger.warning("Failed to fetch audio clip %s from storage: %s", clip_id, e)
        raise HTTPException(status_code=502, detail="Storage unreachable") from e

    if last_status == 404:
        raise HTTPException(status_code=404, detail="Audio clip not found")
    raise HTTPException(
        status_code=502,
        detail=f"Storage returned HTTP {last_status}" if last_status else "Storage error",
    )


@app.get("/api/audio-raw/{clip_id}")
async def get_raw_audio_clip(clip_id: str):
    """Serve a saved raw (pre-normalization) audio clip WAV file."""
    if not re.fullmatch(r"[a-f0-9]{12}", clip_id):
        raise HTTPException(status_code=400, detail="Invalid clip ID")

    clip_path = _RAW_CLIPS_DIR / f"{clip_id}.wav"
    if not clip_path.exists():
        raise HTTPException(status_code=404, detail="Raw audio clip not found")

    from fastapi.responses import FileResponse
    return FileResponse(
        path=str(clip_path),
        media_type="audio/wav",
        headers={"Cache-Control": "public, max-age=86400"},
    )
