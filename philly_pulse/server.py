"""FastAPI server for PhillyPulse."""

import json
import logging
import os
import random
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import geocode, inhibitor, llm, store, weights

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


@app.on_event("startup")
async def startup():
    """Seed the database with demo data if empty."""
    if store.incident_count() == 0 and SEED_PATH.exists():
        s_base_map = {
            cat: weights.get_s_base(cat) for cat in llm.SEVERITY_CATEGORIES
        }
        count = store.seed_from_json(str(SEED_PATH), s_base_map)
        logger.info("Seeded %d demo incidents", count)


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "llm_configured": bool(llm.OPENAI_API_KEY),
        "inhibitor_configured": bool(inhibitor.INHIBITOR_API_KEY),
        "incident_count": store.incident_count(),
    }


@app.post("/api/ingest")
async def ingest(req: IngestRequest):
    """Ingest a scanner transcript: LLM extract -> Inhibitor check -> geocode -> store."""

    # Step 1: LLM extraction
    try:
        extraction = await llm.extract_incident(req.text)
    except llm.LLMError as e:
        raise HTTPException(status_code=502, detail=f"LLM error: {e}")

    if extraction is None:
        return {"status": "rejected", "reason": "Not dispatch-relevant"}

    category = extraction["severity_category"]
    location_text = extraction["location_text"]
    confidence = extraction["confidence"]
    s_base = weights.get_s_base(category)

    # Step 2: Inhibitor ethical guardrail
    inh = await inhibitor.check_incident(
        raw_transcript=req.text,
        severity_category=category,
        location_text=location_text,
        confidence=confidence,
    )

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
        return {
            "status": "blocked",
            "reason": inh.reason,
            "incident_id": incident["id"],
        }

    # Step 3: Geocode
    lat, lng = None, None
    geocode_status = "failed"
    if location_text:
        coords = await geocode.geocode(location_text)
        if coords:
            lat, lng = coords
            geocode_status = "success"
        else:
            geocode_status = "no_result"

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
