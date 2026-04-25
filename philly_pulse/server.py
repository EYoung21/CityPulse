"""FastAPI server for Pulse platform.

Serves the API: ingest, incidents, admin, health.
Set CITY_CONFIG env var to a city config YAML path to configure for a specific city.
Loads all city configs from the cities/ directory for multi-city LLM/geocode support.
"""

import json
import logging
import os
import random
import re
import subprocess
from datetime import datetime, date, timedelta, timezone
from pathlib import Path
from typing import Optional

import httpx
import numpy as np
import yaml
from fastapi import FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import admin_events, city_registry, geocode, inhibitor, llm, llm_client, persistence as store, prefilter, push as push_mod, weights

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# When False, ingest only stores raw transcript+audio — no LLM/inhibitor/geocode.
# Flip to True (or set env PHILLY_PULSE_LLM_AUTO=1) to resume automatic processing.
LLM_AUTO_ENABLED = os.environ.get("PHILLY_PULSE_LLM_AUTO", "0").strip().lower() in ("1", "true", "yes")

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
        "inhibitor_configured": inhibitor.GUARDRAIL_MODE not in {"off", "disabled", "none"},
        "incident_count": count,
    }


@app.post("/api/route-directions")
async def route_directions(body: RouteDirectionsRequest):
    """Proxy to OSRM so the browser gets street geometry (avoids public OSRM CORS blocks)."""
    if len(body.waypoints) < 2:
        raise HTTPException(status_code=400, detail="Need at least two waypoints")
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
    """List candidate GCS buckets for the Firebase project once per process."""
    global _DISCOVERED_STORAGE_BUCKETS
    if _DISCOVERED_STORAGE_BUCKETS is not None:
        return _DISCOVERED_STORAGE_BUCKETS

    project_id = _infer_firebase_project_id()
    if not project_id:
        _DISCOVERED_STORAGE_BUCKETS = []
        return _DISCOVERED_STORAGE_BUCKETS

    try:
        from google.cloud import storage as gcs_storage

        client = gcs_storage.Client(project=project_id)
        names = [b.name for b in client.list_buckets(max_results=50)]
        # Prefer canonical Firebase/GCS bucket patterns first.
        names.sort(
            key=lambda n: (
                0 if n.endswith(".firebasestorage.app") else
                1 if n.endswith(".appspot.com") else
                2
            )
        )
        _DISCOVERED_STORAGE_BUCKETS = list(dict.fromkeys(names))
        if _DISCOVERED_STORAGE_BUCKETS:
            logger.info("Discovered storage buckets for project %s: %s", project_id, _DISCOVERED_STORAGE_BUCKETS)
        else:
            logger.warning("No storage buckets discovered for Firebase project %s", project_id)
    except Exception as e:
        logger.warning("Failed to discover Firebase storage buckets: %s", e)
        _DISCOVERED_STORAGE_BUCKETS = []

    return _DISCOVERED_STORAGE_BUCKETS


def _storage_bucket_candidates() -> list[str]:
    """Return preferred Firebase Storage bucket names to try."""
    primary = (_STORAGE_BUCKET or "").strip()
    if not primary:
        primary = "phlpulse.firebasestorage.app"
    candidates = [primary]
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
async def upload_audio(req: AudioUploadRequest):
    """Receive and save audio clip WAV files. Used by the transcriber bridge."""
    import base64
    saved = 0
    for clip_id, b64 in req.clips.items():
        if not re.fullmatch(r"[a-f0-9]{12}", clip_id):
            continue
        try:
            wav_bytes = base64.b64decode(b64)
        except Exception:
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
            dest = _RAW_CLIPS_DIR / f"{clip_id}.wav"
            if not dest.exists():
                dest.write_bytes(wav_bytes)
                saved += 1
    return {"status": "ok", "saved": saved}


@app.post("/api/ingest")
async def ingest(req: IngestRequest):
    """Ingest a scanner transcript.

    When LLM_AUTO_ENABLED is False (default), only store the raw
    transcript + audio as an extraction — no LLM / inhibitor / geocode.
    When True, run the full pipeline.
    """

    feed_id = req.feed_id or "unknown"
    city = req.city or CITY_SLUG
    feed_label = _resolve_feed_label(feed_id, req.feed_label)

    # Audio data is saved AFTER the pipeline determines the incident is map-worthy.
    # This avoids wasting disk on rejected/no-location transcripts (~95% reduction).
    _pending_audio_data = req.audio_data

    # Normalize time-only timestamps (e.g. "14:30:00") to full ISO
    ts = req.timestamp
    if ts and re.match(r"^\d{1,2}:\d{2}(:\d{2})?$", ts.strip()):
        ts = f"{date.today().isoformat()}T{ts.strip()}"
    req_timestamp = ts or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

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

    if inh.status == "blocked":
        incident = store.insert_incident(
            raw_text=req.text,
            severity_category=category,
            s_base=s_base,
            confidence=confidence,
            location_text=location_text,
            inhibitor_status="blocked",
            inhibitor_reason=inh.reason,
            feed_id=feed_id,
            audio_clip=effective_audio_clip,
            location_confidence=location_confidence,
            description=description,
            word_timings=effective_word_timings,
            city=city,
        )
        await admin_events.broadcast({
            "type": "incident_stored",
            "correlation": correlation,
            "feed_id": feed_id,
            "outcome": "blocked",
            "incident_id": incident["id"],
        })
        store.insert_extraction(
            feed_id=feed_id,
            raw_text=req.text,
            reported_at=req_timestamp,
            audio_clip=effective_audio_clip,
            raw_audio_clip=req.raw_audio_clip,
            preprocess_meta=req.preprocess_meta,
            variants=req.variants,
            llm_relevant=True,
            llm_category=category,
            llm_confidence=confidence,
            llm_location_text=location_text,
            location_confidence=location_confidence,
            inhibitor_status="blocked",
            inhibitor_reason=inh.reason,
            incident_id=incident["id"],
            city=city,
        )
        return {
            "status": "blocked",
            "reason": inh.reason,
            "incident_id": incident["id"],
        }

    # Geocode the location text via Nominatim. We no longer fall back to
    # LLM-predicted coords — the model hallucinates the city center when it
    # doesn't actually know the address, which caused unrelated incidents to
    # cluster at one point. If Nominatim can't resolve the text, the
    # incident is dropped (or, post-repair, soft-hidden by the unmapped queue).
    location_confidence = extraction.get("location_confidence", "none")
    lat, lng = None, None
    geocode_status = "failed"

    if location_text:
        coords = await geocode.geocode(location_text, geo_ctx=city_geo_ctx)
        if coords:
            lat, lng = coords
            geocode_status = f"success_{location_confidence}"
        else:
            geocode_status = f"no_result_{location_confidence}"

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
        # appended entry on a dedup merge.
        mention = {
            "at": req_timestamp,
            "raw_text": req.text,
            "audio_clip": effective_audio_clip,
            "audio_url": audio_url,
            "feed_id": feed_id,
            "location_text": location_text,
            "location_confidence": location_confidence,
            "confidence": confidence,
            "severity_category": category,
            "s_base": s_base,
            "description": description,
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
                raw_text=req.text,
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
                audio_clip=effective_audio_clip,
                feed_id=feed_id,
                description=description,
                word_timings=effective_word_timings,
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
        raw_text=req.text,
        reported_at=req_timestamp,
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
        incident_id=incident_id,
        city=city,
    )

    if incident_id:
        return {"status": merge_outcome or "created", "incident": incident}
    return {"status": "no_location", "extraction_only": True}


@app.get("/api/incidents")
async def get_incidents(
    since: str | None = Query(None, description="ISO timestamp filter"),
    category: str | None = Query(None, description="Severity category filter"),
):
    """Return all displayable incidents with computed w_eff."""
    try:
        incidents = store.list_incidents(since=since, category=category)
        incidents = weights.enrich_incidents(incidents)
    except Exception:
        incidents = []
    return {"incidents": incidents}


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
async def page_incidents(
    cursor: str | None = Query(None, description="Opaque cursor: ISO reported_at of the last row from the prior page"),
    limit: int = Query(20, ge=1, le=50, description="Page size"),
    since: str | None = Query(None, description="Lower bound (defaults to now-24h)"),
    category: str | None = Query(None, description="Severity category filter"),
    city: str | None = Query(None, description="City slug filter"),
    near_lat: float | None = Query(None, ge=-90.0, le=90.0),
    near_lng: float | None = Query(None, ge=-180.0, le=180.0),
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
    if not since:
        since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    try:
        incidents = store.list_incidents(since=since, category=category)
    except Exception:
        incidents = []
    if city:
        incidents = [i for i in incidents if i.get("city") == city]
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
        }

    incidents.sort(key=lambda i: i.get("reported_at") or "", reverse=True)
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
    return {"incidents": page, "next_cursor": next_cursor, "mode": "recent"}


def _haversine_km_inline(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    import math
    R = 6371.0088
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = rlat2 - rlat1
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


@app.get("/api/incidents/search")
async def search_incidents(
    q: str = Query(..., description="Free-text query"),
    since: str | None = Query(None, description="ISO lower bound (default: today-3h)"),
    until: str | None = Query(None, description="ISO upper bound (default: now)"),
    category: str | None = Query(None, description="Severity category filter"),
    limit: int = Query(50, ge=1, le=200, description="Max results"),
    city: str | None = Query(None, description="City slug filter"),
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

    try:
        incidents = store.list_incidents(since=since, category=category)
    except Exception:
        incidents = []

    if until:
        incidents = [i for i in incidents if (i.get("reported_at") or "") <= until]
    if city:
        incidents = [i for i in incidents if i.get("city") == city]

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
    }


@app.post("/api/seed")
async def seed():
    """Load pre-built demo incidents into the database. Idempotent panic button."""
    if not SEED_PATH.exists():
        raise HTTPException(status_code=404, detail="Seed data file not found")
    s_base_map = {cat: weights.get_s_base(cat) for cat in llm.SEVERITY_CATEGORIES}
    count = store.seed_from_json(str(SEED_PATH), s_base_map)
    logger.info("Seeded %d demo incidents on demand", count)
    return {"status": "seeded", "count": count}


@app.post("/api/simulate")
async def simulate():
    """Ingest a random canned transcript through the full pipeline. For demos."""
    transcript = random.choice(CANNED_TRANSCRIPTS)
    req = IngestRequest(text=transcript)
    return await ingest(req)


@app.get("/api/summary")
async def summary():
    """AI-generated natural language summary of recent activity."""
    incidents = store.list_incidents()
    recent = incidents[:20]

    if not recent:
        return {"summary": "No recent incidents to summarize.", "incident_count": 0}

    if not llm.is_configured():
        lines = [
            f"- {inc['severity_category'].replace('_', ' ').title()}: "
            f"{inc.get('location_text', 'Unknown location')}"
            for inc in recent[:10]
        ]
        return {
            "summary": f"{len(recent)} recent incidents in {CITY_NAME}:\n" + "\n".join(lines),
            "incident_count": len(recent),
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
        text = await llm_client.chat_completion(
            [{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=200,
            timeout=20.0,
        )
        return {"summary": text.strip(), "incident_count": len(recent)}
    except Exception as e:
        logger.warning("Summary LLM call failed: %s", e)

    return {
        "summary": f"{len(recent)} recent incidents across {CITY_NAME}. Check the map for details.",
        "incident_count": len(recent),
    }


@app.get("/api/stats")
async def stats():
    """Inhibitor audit stats for the transparency page."""
    return {
        "total_incidents": store.incident_count(),
        "inhibitor_stats": store.inhibitor_stats(),
    }


@app.get("/api/city-stats/{slug}")
async def city_stats(slug: str):
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

    return {
        "slug": slug,
        "city_name": city_name,
        "scanner_feeds": len(feeds),
        "incidents_24h": incidents_24h,
        "incidents_total": incidents_total,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


# ── Admin endpoints ─────────────────────────────────────────────────

@app.websocket("/ws/admin")
async def admin_ws(ws: WebSocket):
    """WebSocket stream of all pipeline events for the admin panel."""
    await admin_events.connect(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await admin_events.disconnect(ws)


@app.get("/api/admin/feeds")
async def admin_feeds():
    """List of available Broadcastify feeds."""
    return {"feeds": FEEDS}


@app.get("/api/admin/prefilter/metrics")
async def admin_prefilter_metrics():
    """In-process counters for the regex prefilter, per city.

    Each city entry has `seen` (total lines), `kept` (passed to LLM),
    and `skipped` (dropped before LLM). Resets when the worker restarts.
    """
    return {"enabled": prefilter.PREFILTER_ENABLED, "metrics": prefilter.get_metrics()}


class PredictRequest(BaseModel):
    extraction_id: str


class VisibilityRequest(BaseModel):
    hidden: bool


@app.post("/api/admin/incident/{incident_id}/visibility")
async def admin_toggle_visibility(incident_id: str, req: VisibilityRequest):
    """Toggle an incident's visibility on the public map."""
    result = store.update_incident(incident_id, {"hidden": req.hidden})
    if result is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    return {"status": "ok", "incident_id": incident_id, "hidden": req.hidden}


@app.delete("/api/admin/incident/{incident_id}")
async def admin_delete_incident(incident_id: str):
    """Permanently delete an incident."""
    ok = store.delete_incident(incident_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Incident not found")
    return {"status": "deleted", "incident_id": incident_id}


@app.post("/api/admin/predict")
async def admin_predict(req: PredictRequest):
    """Run the full LLM + inhibitor + geocode pipeline on a stored extraction.

    Used for manual evaluation when LLM_AUTO_ENABLED is off.
    """
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
async def admin_retranscribe(req: RetranscribeRequest):
    """Re-preprocess + re-transcribe an extraction with custom params.

    Reads the raw audio clip from disk, applies the specified preprocessing,
    runs Whisper, saves a new processed clip, and appends the result to the
    extraction's variants array as 'custom_N'.
    """
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
async def admin_stream(feed_id: str):
    """Proxy a Broadcastify MP3 stream for the admin audio player."""
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


def _user_tier(uid: str) -> str:
    """Read the calling user's billing tier from `users/{uid}.tier`.

    Returns one of "free", "pro", "enterprise" — matches the values
    the AuthContext writes from the frontend. Anything unrecognised
    or any read failure falls back to "free" so the caller never
    accidentally grants Pro on a Firestore outage."""
    try:
        from .firestore_store import _ensure_client
        snap = _ensure_client().collection("users").document(uid).get()
        if snap.exists:
            t = ((snap.to_dict() or {}).get("tier") or "free")
            if t in ("free", "pro", "enterprise"):
                return t
    except Exception as e:
        logger.debug("_user_tier read failed for %s: %s", uid, e)
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
    """Serve an audio clip — checks local disk first, then redirects to Firebase Storage."""
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

    # Try Firebase Storage — construct the public URL and redirect
    storage_url = f"https://storage.googleapis.com/{_STORAGE_BUCKET}/audio/{clip_id}.wav"
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url=storage_url, status_code=302)


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
