"""OpenAI LLM structured extraction for CityPulse.

Takes a raw scanner transcript line and returns structured incident data
with a closed severity enum, location text, and confidence score.

Supports multi-city operation: call configure_llm() at startup or pass
city_context to extract_incident() for per-request city awareness.
"""

import json
import logging
import os
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_URL = "https://api.openai.com/v1/chat/completions"

SEVERITY_CATEGORIES = [
    "violent_weapon",
    "violent_no_weapon",
    "shots_heard",
    "robbery",
    "burglary_in_progress",
    "medical_priority",
    "medical_other",
    "fire_hazmat",
    "traffic_crash_injury",
    "traffic_crash_no_injury",
    "disorder",
    "admin_or_noise",
]

# ── Per-city LLM context ────────────────────────────────────────────

_PHILLY_BOUNDS = {"lat_min": 39.85, "lat_max": 40.15, "lng_min": -75.30, "lng_max": -74.94}
_PHILLY_CENTER = (39.9526, -75.1652)

_default_city_context: dict = {
    "city_name": "Philadelphia",
    "geocode_suffix": "Philadelphia, PA",
    "center_lat": _PHILLY_CENTER[0],
    "center_lng": _PHILLY_CENTER[1],
    "bounds": _PHILLY_BOUNDS,
}


def configure_llm(
    city_name: str = "Philadelphia",
    geocode_suffix: str = "Philadelphia, PA",
    center_lat: float = 39.9526,
    center_lng: float = -75.1652,
    bounds: dict | None = None,
):
    """Set default city context for the LLM. Call once on startup."""
    global _default_city_context
    _default_city_context = {
        "city_name": city_name,
        "geocode_suffix": geocode_suffix,
        "center_lat": center_lat,
        "center_lng": center_lng,
        "bounds": bounds or _PHILLY_BOUNDS,
    }
    logger.info("LLM configured for %s (center: %.4f, %.4f)", city_name, center_lat, center_lng)


def _build_system_prompt(ctx: dict) -> str:
    city = ctx["city_name"]
    suffix = ctx["geocode_suffix"]
    clat = ctx["center_lat"]
    clng = ctx["center_lng"]

    return f"""\
You are an AI assistant that extracts structured incident data from {city} \
police/fire/EMS radio scanner transcripts.

Given a raw transcript line, output ONLY a JSON object with these fields:

- "is_dispatch_relevant": boolean — true if this describes an actual dispatch-worthy \
incident (crime, medical, fire, crash). false for administrative chatter, test tones, \
unit check-ins, or ambiguous fragments.
- "severity_category": one of {json.dumps(SEVERITY_CATEGORIES)} — pick the single \
best match. Use "admin_or_noise" for non-dispatch content.
- "location_text": string or null — the most specific location mentioned in direct \
connection to the incident (intersection, block, address, landmark). Include \
"{suffix}" for geocoding. null if no location is directly associated with the incident.
- "context_location_text": string or null — if "location_text" is null, look for \
ANY location mentioned elsewhere in the transcript, even if it is not in the same \
sentence as the incident. Officers often state their position before reporting an \
event. Extract the most recent/relevant location from the full transcript. null only \
if truly no location appears anywhere.
- "location_confidence": one of "direct", "context", "none" — "direct" if \
location_text is set (location explicitly tied to the incident), "context" if only \
context_location_text is available, "none" if no location at all.
- "description": string — one plain-English sentence summarizing the incident \
for a civilian reader. No jargon, no police codes. Decode any radio codes into \
plain language.
- "confidence": float 0.0-1.0 — your confidence that the extraction is accurate. \
Lower if the transcript is garbled, ambiguous, or partially inaudible.
- "lat": float or null — approximate latitude of the incident location in \
{city} (WGS-84). Use your knowledge of {city} geography. Derive from \
location_text first, then context_location_text. null if unknown.
- "lng": float or null — approximate longitude. null if unknown.

## Common Radio Codes
Decode these codes when they appear in transcripts:

10-Codes: 10-0=Caution, 10-4=Acknowledged, 10-7=Out of service, 10-8=In service, \
10-17=En route, 10-18=Urgent, 10-20=Location, 10-22=Cancel, 10-23=On scene, \
10-24=Assignment completed, 10-30=Danger, 10-31=Crime in progress, \
10-32=Man with gun, 10-33=Emergency/need assistance, 10-40=Fight in progress, \
10-43=In pursuit, 10-45=Bomb threat, 10-46=Bank alarm, 10-50=Vehicle accident, \
10-52=Dispatch ambulance, 10-54=Hit and run, 10-55=DUI, 10-60=Suspicious vehicle, \
10-61=Traffic stop, 10-62=B&E in progress, 10-64=Crime in progress, \
10-65=Armed robbery, 10-73=Mental subject, 10-80=Domestic disturbance, \
10-99=Wanted person.

Priority Events: PGUN=Person with gun, PWEA=Person with weapon, ROBP=Robbery in progress, \
BIP=Burglary in progress, GUNSHT=Gunshots, DOM=Domestic, HC=Hospital case, \
HCACC=Auto accident with injuries, 302=Mental health/psychiatric emergency.

Rules:
- Output ONLY valid JSON. No markdown, no explanation, no extra text.
- If the transcript is not dispatch-relevant, set is_dispatch_relevant to false and \
severity_category to "admin_or_noise".
- Prefer specific intersections over vague areas.
- If multiple incidents are mentioned, extract the most severe one.
- For lat/lng, use your best estimate for {city} locations. {city} center is \
roughly {clat}, {clng}. Only provide coordinates you are reasonably confident about.
- Aggressively extract locations: block numbers, intersections, landmarks, highway \
references, unit positions.
- When you see codes like "10-32", "PGUN", "302", decode them to determine the \
correct severity_category.
"""


# Legacy module-level prompt (backward compat for imports)
SYSTEM_PROMPT = _build_system_prompt(_default_city_context)


class LLMError(Exception):
    """Raised when the LLM call fails or returns unusable data."""
    pass


async def extract_incident(
    raw_text: str,
    city_context: dict | None = None,
) -> Optional[dict]:
    """Extract structured incident data from a raw transcript line.

    city_context, if provided, overrides the default city for this call.
    Expected keys: city_name, geocode_suffix, center_lat, center_lng, bounds.

    Returns a dict with is_dispatch_relevant, severity_category,
    location_text, and confidence. Returns None if the LLM says
    the transcript is not dispatch-relevant.

    Raises LLMError if the API key is missing or the call fails.
    """
    if not OPENAI_API_KEY:
        raise LLMError("OPENAI_API_KEY is not set. LLM extraction is required.")

    ctx = city_context or _default_city_context
    prompt = _build_system_prompt(ctx)
    bounds = ctx.get("bounds", _PHILLY_BOUNDS)

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            OPENAI_URL,
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": OPENAI_MODEL,
                "messages": [
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": raw_text},
                ],
                "temperature": 0.0,
                "max_tokens": 300,
            },
        )

    if resp.status_code != 200:
        raise LLMError(f"OpenAI API returned {resp.status_code}: {resp.text}")

    body = resp.json()
    content = body["choices"][0]["message"]["content"].strip()

    # Strip markdown fences if present
    if content.startswith("```"):
        lines = content.split("\n")
        lines = [l for l in lines if not l.startswith("```")]
        content = "\n".join(lines).strip()

    try:
        data = json.loads(content)
    except json.JSONDecodeError as e:
        raise LLMError(f"LLM returned invalid JSON: {e}\nRaw: {content}")

    if not isinstance(data.get("is_dispatch_relevant"), bool):
        raise LLMError(f"Missing or invalid is_dispatch_relevant: {data}")

    if not data["is_dispatch_relevant"]:
        return None

    cat = data.get("severity_category", "")
    if cat not in SEVERITY_CATEGORIES:
        raise LLMError(f"Invalid severity_category '{cat}'. Must be one of {SEVERITY_CATEGORIES}")

    llm_lat = data.get("lat")
    llm_lng = data.get("lng")
    if llm_lat is not None and llm_lng is not None:
        try:
            llm_lat, llm_lng = float(llm_lat), float(llm_lng)
            if not (bounds["lat_min"] <= llm_lat <= bounds["lat_max"]
                    and bounds["lng_min"] <= llm_lng <= bounds["lng_max"]):
                llm_lat, llm_lng = None, None
        except (ValueError, TypeError):
            llm_lat, llm_lng = None, None

    location_text = data.get("location_text")
    context_location = data.get("context_location_text")
    loc_confidence = data.get("location_confidence", "none")
    if loc_confidence not in ("direct", "context", "none"):
        loc_confidence = "direct" if location_text else ("context" if context_location else "none")

    effective_location = location_text or context_location

    return {
        "is_dispatch_relevant": True,
        "severity_category": cat,
        "location_text": effective_location,
        "location_confidence": loc_confidence,
        "context_location_text": context_location,
        "confidence": float(data.get("confidence", 0.7)),
        "description": data.get("description"),
        "llm_lat": llm_lat,
        "llm_lng": llm_lng,
    }
