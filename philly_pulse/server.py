"""FastAPI server for PhillyPulse."""

import json
import logging
import os
import random
import subprocess
from pathlib import Path

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import admin_events, geocode, inhibitor, llm, persistence as store, verifier, weights

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="PhillyPulse API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load Broadcastify config for audio proxy
_config_path = Path(__file__).resolve().parent.parent / "config.yaml"
_bf_username = ""
_bf_password = ""
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
]
if _config_path.exists():
    try:
        with open(_config_path, "r") as f:
            _cfg = yaml.safe_load(f)
        _bf_username = _cfg.get("credentials", {}).get("username", "")
        _bf_password = _cfg.get("credentials", {}).get("password", "")
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


class IngestRequest(BaseModel):
    text: str
    timestamp: str | None = None
    feed_id: str | None = None


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
    """Ensure the database table exists (but don't auto-seed)."""
    store.get_conn()  # creates table if missing


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "llm_configured": bool(llm.OPENAI_API_KEY),
        "inhibitor_configured": bool(inhibitor.INHIBITOR_API_KEY),
        "incident_count": store.incident_count(),
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


@app.post("/api/ingest")
async def ingest(req: IngestRequest):
    """Ingest a scanner transcript: LLM extract -> Inhibitor check -> geocode -> store."""

    feed_id = req.feed_id or "unknown"
    correlation = f"{feed_id}_{req.timestamp or ''}"

    # Broadcast: transcript received
    await admin_events.broadcast({
        "type": "transcript_received",
        "correlation": correlation,
        "feed_id": feed_id,
        "text": req.text,
        "timestamp": req.timestamp,
    })

    # Step 1: LLM extraction
    await admin_events.broadcast({
        "type": "llm_started",
        "correlation": correlation,
        "feed_id": feed_id,
    })

    try:
        extraction = await llm.extract_incident(req.text)
    except llm.LLMError as e:
        await admin_events.broadcast({
            "type": "llm_error",
            "correlation": correlation,
            "feed_id": feed_id,
            "error": str(e),
        })
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")

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
        return {"status": "rejected", "reason": "Not dispatch-relevant"}

    category = extraction["severity_category"]
    location_text = extraction["location_text"]
    confidence = extraction["confidence"]
    llm_lat = extraction.get("llm_lat")
    llm_lng = extraction.get("llm_lng")
    s_base = weights.get_s_base(category)

    await admin_events.broadcast({
        "type": "llm_result",
        "correlation": correlation,
        "feed_id": feed_id,
        "is_relevant": True,
        "category": category,
        "confidence": confidence,
        "location_text": location_text,
        "llm_lat": llm_lat,
        "llm_lng": llm_lng,
        "s_base": s_base,
    })

    # Step 2: Inhibitor ethical guardrail
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

    if inh.status == "blocked":
        incident = store.insert_incident(
            raw_text=req.text,
            severity_category=category,
            s_base=s_base,
            confidence=confidence,
            location_text=location_text,
            inhibitor_status="blocked",
            inhibitor_reason=inh.reason,
        )
        await admin_events.broadcast({
            "type": "incident_stored",
            "correlation": correlation,
            "feed_id": feed_id,
            "outcome": "blocked",
            "incident_id": incident["id"],
        })
        return {
            "status": "blocked",
            "reason": inh.reason,
            "incident_id": incident["id"],
        }

    # Step 3: Geocode (Nominatim first, LLM coordinates as fallback)
    lat, lng = None, None
    geocode_status = "failed"
    if location_text:
        coords = await geocode.geocode(location_text)
        if coords:
            lat, lng = coords
            geocode_status = "success"
        elif llm_lat is not None and llm_lng is not None:
            lat, lng = llm_lat, llm_lng
            geocode_status = "llm_fallback"
        else:
            geocode_status = "no_result"
    elif llm_lat is not None and llm_lng is not None:
        lat, lng = llm_lat, llm_lng
        geocode_status = "llm_fallback"

    await admin_events.broadcast({
        "type": "geocode_result",
        "correlation": correlation,
        "feed_id": feed_id,
        "lat": lat,
        "lng": lng,
        "method": geocode_status,
    })

    # Step 4: Store
    incident = store.insert_incident(
        raw_text=req.text,
        severity_category=category,
        s_base=s_base,
        confidence=confidence,
        location_text=location_text,
        lat=lat,
        lng=lng,
        geocode_status=geocode_status,
        inhibitor_status=inh.status,
        inhibitor_reason=inh.reason,
        reported_at=req.timestamp,
    )

    await admin_events.broadcast({
        "type": "incident_stored",
        "correlation": correlation,
        "feed_id": feed_id,
        "outcome": "created",
        "incident_id": incident["id"],
        "category": category,
        "confidence": confidence,
        "location_text": location_text,
        "lat": lat,
        "lng": lng,
    })

    return {"status": "created", "incident": incident}


@app.get("/api/incidents")
async def get_incidents(
    since: str | None = Query(None, description="ISO timestamp filter"),
    category: str | None = Query(None, description="Severity category filter"),
):
    """Return all displayable incidents with computed w_eff."""
    incidents = store.list_incidents(since=since, category=category)
    incidents = weights.enrich_incidents(incidents)
    return {"incidents": incidents}


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

    if not llm.OPENAI_API_KEY:
        lines = [
            f"- {inc['severity_category'].replace('_', ' ').title()}: "
            f"{inc.get('location_text', 'Unknown location')}"
            for inc in recent[:10]
        ]
        return {
            "summary": f"{len(recent)} recent incidents in Philadelphia:\n" + "\n".join(lines),
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
        "in Philadelphia. Given the following recent incidents extracted from police "
        "scanner audio (all UNVERIFIED), write a brief 2-3 sentence summary suitable "
        "for display on a community safety dashboard. Be factual, mention specific "
        "neighborhoods, and note that all data is unverified scanner audio.\n\n"
        "Recent incidents:\n" + "\n".join(incident_lines)
    )

    import httpx
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(
                llm.OPENAI_URL,
                headers={
                    "Authorization": f"Bearer {llm.OPENAI_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": llm.OPENAI_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.3,
                    "max_tokens": 200,
                },
            )
        if resp.status_code == 200:
            text = resp.json()["choices"][0]["message"]["content"].strip()
            return {"summary": text, "incident_count": len(recent)}
    except Exception as e:
        logger.warning("Summary LLM call failed: %s", e)

    return {
        "summary": f"{len(recent)} recent incidents across Philadelphia. Check the map for details.",
        "incident_count": len(recent),
    }


@app.get("/api/stats")
async def stats():
    """Inhibitor audit stats for the transparency page."""
    return {
        "total_incidents": store.incident_count(),
        "inhibitor_stats": store.inhibitor_stats(),
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
    return {"feeds": PHILLY_FEEDS}


@app.get("/api/admin/stream/{feed_id}")
async def admin_stream(feed_id: str):
    """Proxy a Broadcastify MP3 stream for the admin audio player."""
    if not _bf_username or not _bf_password:
        raise HTTPException(status_code=503, detail="Broadcastify credentials not configured")

    valid_ids = {f["feed_id"] for f in PHILLY_FEEDS}
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
