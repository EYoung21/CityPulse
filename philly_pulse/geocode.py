"""Nominatim geocoder restricted to the Philadelphia bounding box."""

import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"

# Philadelphia bounding box (west, south, east, north)
PHILLY_VIEWBOX = "-75.28,39.87,-74.96,40.14"

_cache: dict[str, tuple[float, float] | None] = {}


async def geocode(location_text: str) -> Optional[tuple[float, float]]:
    """Geocode a location string to (lat, lng) within Philadelphia.

    Uses Nominatim with a bounded viewbox. Caches results by
    normalized location text. Returns None if geocoding fails.
    """
    if not location_text:
        return None

    key = location_text.strip().lower()
    if key in _cache:
        return _cache[key]

    params = {
        "q": location_text,
        "format": "json",
        "limit": "1",
        "viewbox": PHILLY_VIEWBOX,
        "bounded": "1",
    }
    headers = {
        "User-Agent": "PhillyPulse/0.1 (codefest hackathon project)",
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(NOMINATIM_URL, params=params, headers=headers)

        if resp.status_code != 200:
            logger.warning("Nominatim returned %d for '%s'", resp.status_code, location_text)
            _cache[key] = None
            return None

        results = resp.json()
        if not results:
            logger.info("No geocode results for '%s'", location_text)
            _cache[key] = None
            return None

        lat = float(results[0]["lat"])
        lng = float(results[0]["lon"])
        _cache[key] = (lat, lng)
        logger.info("Geocoded '%s' -> (%f, %f)", location_text, lat, lng)
        return (lat, lng)

    except Exception as e:
        logger.warning("Geocode error for '%s': %s", location_text, e)
        _cache[key] = None
        return None
