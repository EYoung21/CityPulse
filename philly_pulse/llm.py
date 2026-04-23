"""LLM structured extraction for CityPulse.

Takes a raw scanner transcript line and returns structured incident data
with a closed severity enum, location text, and confidence score.

Supports multi-city operation: call configure_llm() at startup or pass
city_context to extract_incident() for per-request city awareness.

The actual HTTP call goes through :mod:`philly_pulse.llm_client`, which
routes to Lambda Inference (preferred) or OpenAI (fallback) based on
env vars. This module only knows about the *prompt* and the *schema*.
"""

import json
import logging
import os
from typing import Optional

from . import llm_client

logger = logging.getLogger(__name__)

# ── Backwards-compat shims ──────────────────────────────────────────
# Older code (and external scripts) read these module-level constants
# directly to gate behavior. They stay here so nothing else needs to
# change, but they now reflect the *active* provider rather than always
# being OpenAI-specific.
#
# `OPENAI_API_KEY` in particular is used as a truthy "is some LLM
# configured?" check throughout the codebase. We make it return the
# active provider's key so legacy `if llm.OPENAI_API_KEY:` blocks light
# up correctly under Lambda too.

def __getattr__(name: str):
    # Lazy attribute lookup so env changes after import are honored
    # (matches the call-time resolution used inside llm_client).
    if name == "OPENAI_API_KEY":
        # Truthy whenever ANY provider is configured. Preserves the
        # old "is the LLM available?" semantic at every existing call site.
        return _active_api_key()
    if name == "OPENAI_MODEL":
        return llm_client.active_model() or os.environ.get("OPENAI_MODEL", llm_client.DEFAULT_OPENAI_MODEL)
    if name == "OPENAI_URL":
        # Kept for the small handful of places that still reference it
        # directly; they should migrate to llm_client.chat_completion.
        return f"{llm_client.DEFAULT_OPENAI_BASE_URL}/chat/completions"
    raise AttributeError(name)


def _active_api_key() -> str:
    """Return the active provider's API key (Lambda > OpenAI > '')."""
    return (
        os.environ.get("LAMBDA_API_KEY", "")
        or os.environ.get("LLM_API_KEY", "")
        or os.environ.get("OPENAI_API_KEY", "")
    )


def is_configured() -> bool:
    """True if any LLM provider is reachable. Prefer this over the
    legacy ``OPENAI_API_KEY`` truthiness check in new code."""
    return llm_client.is_configured()

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

    return f"""\
You are an AI assistant that extracts structured incident data from {city} \
police/fire/EMS radio scanner transcripts.

Given a raw transcript line, output ONLY a JSON object with these fields:

- "is_dispatch_relevant": boolean. true if this describes an actual dispatch-worthy \
incident (crime, medical, fire, crash). false for administrative chatter, test tones, \
unit check-ins, or ambiguous fragments.
- "severity_category": one of {json.dumps(SEVERITY_CATEGORIES)}. Pick the single \
best match. Use "admin_or_noise" for non-dispatch content.
- "location_text": string or null. The most specific location mentioned in direct \
connection to the incident (intersection, block, address, landmark). Include \
"{suffix}" for geocoding. null if no location is directly associated with the incident.
- "context_location_text": string or null. If "location_text" is null, look for \
ANY location mentioned elsewhere in the transcript, even if it is not in the same \
sentence as the incident. Officers often state their position before reporting an \
event. Extract the most recent/relevant location from the full transcript. null only \
if truly no location appears anywhere.
- "location_confidence": one of "direct", "context", "none". "direct" if \
location_text is set (location explicitly tied to the incident), "context" if only \
context_location_text is available, "none" if no location at all.
- "description": string. One plain-English sentence summarizing the incident \
for a civilian reader. No jargon, no police codes. No em dashes and no semicolons. \
Decode any radio codes into plain language.
- "confidence": float 0.0-1.0. Your confidence that the extraction is accurate. \
Lower if the transcript is garbled, ambiguous, or partially inaudible.

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
- Aggressively extract locations: block numbers, intersections, landmarks, highway \
references, unit positions.
- When you see codes like "10-32", "PGUN", "302", decode them to determine the \
correct severity_category.
- Do NOT guess coordinates. Geocoding is handled downstream from the location text \
you extract; never invent lat/lng values.
"""


# Legacy module-level prompt (backward compat for imports)
SYSTEM_PROMPT = _build_system_prompt(_default_city_context)


class LLMError(Exception):
    """Raised when the LLM call fails or returns unusable data."""
    pass


def _format_prior_context(prior_context: list[str] | None) -> str | None:
    """Render prior transmissions as a chronological brief for the LLM.

    Each entry should already be a plain transcript string. Empty / falsy
    entries are dropped. Returns None if nothing usable remains.
    """
    if not prior_context:
        return None
    cleaned = [p.strip() for p in prior_context if p and p.strip()]
    if not cleaned:
        return None
    lines = [f"  {i + 1}. {t}" for i, t in enumerate(cleaned)]
    return (
        "Earlier transmissions on this same talkgroup, oldest first:\n"
        + "\n".join(lines)
        + "\n\nIf the current transmission is a follow-up to one of the above "
        "(acknowledgment, en-route notification, status update, on-scene "
        "report, suspect description), reuse the location from that prior "
        "dispatch when extracting context_location_text and set "
        "location_confidence to 'context'. Do NOT invent a new location."
    )


async def extract_incident(
    raw_text: str,
    city_context: dict | None = None,
    prior_context: list[str] | None = None,
) -> Optional[dict]:
    """Extract structured incident data from a raw transcript line.

    city_context, if provided, overrides the default city for this call.
    Expected keys: city_name, geocode_suffix, center_lat, center_lng, bounds.

    prior_context, if provided, is a chronological list of recent transcript
    strings on the same talkgroup. Used to attach officer follow-ups to the
    location of the original dispatch (see plan: adjacent_radio_context).

    Returns a dict with is_dispatch_relevant, severity_category,
    location_text, and confidence. Returns None if the LLM says
    the transcript is not dispatch-relevant.

    Raises LLMError if the API key is missing or the call fails.
    """
    if not llm_client.is_configured():
        raise LLMError(
            "No LLM provider configured. Set LAMBDA_API_KEY (preferred) "
            "or OPENAI_API_KEY in the environment."
        )

    ctx = city_context or _default_city_context
    prompt = _build_system_prompt(ctx)

    messages: list[dict] = [{"role": "system", "content": prompt}]
    prior_block = _format_prior_context(prior_context)
    if prior_block:
        messages.append({"role": "system", "content": prior_block})
    messages.append({"role": "user", "content": raw_text})

    try:
        content = await llm_client.chat_completion(
            messages,
            temperature=0.0,
            max_tokens=300,
            timeout=30.0,
        )
    except llm_client.LLMHTTPError as e:
        raise LLMError(str(e)) from e
    except llm_client.LLMConfigError as e:
        raise LLMError(str(e)) from e

    content = content.strip()

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

    # Coordinate fields are intentionally not parsed. The LLM was previously
    # asked for `lat`/`lng` and would hallucinate the city center whenever
    # it didn't actually know — causing unrelated incidents to pile up at
    # one coord. Geocoding is now exclusively Nominatim against the
    # extracted location text. See plan: incident_geocode_hallucination.

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
    }
