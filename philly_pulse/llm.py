"""OpenAI LLM structured extraction for PhillyPulse.

Takes a raw scanner transcript line and returns structured incident data
with a closed severity enum, location text, and confidence score.
"""

import json
import os
from typing import Optional

import httpx

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

SYSTEM_PROMPT = f"""\
You are an AI assistant that extracts structured incident data from Philadelphia \
police/fire/EMS radio scanner transcripts.

Given a raw transcript line, output ONLY a JSON object with these fields:

- "is_dispatch_relevant": boolean — true if this describes an actual dispatch-worthy \
incident (crime, medical, fire, crash). false for administrative chatter, test tones, \
unit check-ins, or ambiguous fragments.
- "severity_category": one of {json.dumps(SEVERITY_CATEGORIES)} — pick the single \
best match. Use "admin_or_noise" for non-dispatch content.
- "location_text": string or null — the most specific location mentioned \
(intersection, block, landmark). Include "Philadelphia" for geocoding. null if no \
location is discernible.
- "confidence": float 0.0-1.0 — your confidence that the extraction is accurate. \
Lower if the transcript is garbled, ambiguous, or partially inaudible.
- "lat": float or null — approximate latitude of the incident location in \
Philadelphia (WGS-84). Use your knowledge of Philly geography. null if unknown.
- "lng": float or null — approximate longitude. null if unknown.

Rules:
- Output ONLY valid JSON. No markdown, no explanation, no extra text.
- If the transcript is not dispatch-relevant, set is_dispatch_relevant to false and \
severity_category to "admin_or_noise".
- Prefer specific intersections ("5th and Market") over vague areas ("downtown").
- If multiple incidents are mentioned, extract the most severe one.
- For lat/lng, use your best estimate for Philadelphia locations. Philly center is \
roughly 39.9526, -75.1652. Only provide coordinates you are reasonably confident about.
"""


class LLMError(Exception):
    """Raised when the LLM call fails or returns unusable data."""
    pass


async def extract_incident(raw_text: str) -> Optional[dict]:
    """Extract structured incident data from a raw transcript line.

    Returns a dict with is_dispatch_relevant, severity_category,
    location_text, and confidence. Returns None if the LLM says
    the transcript is not dispatch-relevant.

    Raises LLMError if the API key is missing or the call fails.
    """
    if not OPENAI_API_KEY:
        raise LLMError("OPENAI_API_KEY is not set. LLM extraction is required.")

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
                    {"role": "system", "content": SYSTEM_PROMPT},
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
            if not (39.85 <= llm_lat <= 40.15 and -75.30 <= llm_lng <= -74.94):
                llm_lat, llm_lng = None, None
        except (ValueError, TypeError):
            llm_lat, llm_lng = None, None

    return {
        "is_dispatch_relevant": True,
        "severity_category": cat,
        "location_text": data.get("location_text"),
        "confidence": float(data.get("confidence", 0.7)),
        "llm_lat": llm_lat,
        "llm_lng": llm_lng,
    }
