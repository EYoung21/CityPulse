"""Nominatim geocoder with configurable city bounding box.

Nominatim is poor at intersection queries ("X and Y Street"), so we
try multiple reformulations before giving up.

Supports two modes:
  1. Global default: call configure_geocoder() on startup (single-city server).
  2. Per-request: pass a geo_ctx dict to geocode() for multi-city operation.
"""

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

from .location_aliases import expand_location_aliases

logger = logging.getLogger(__name__)

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"

# ── Configurable per-city (defaults = Philadelphia) ─────────────────

_VIEWBOX = "-75.28,39.87,-74.96,40.14"
_BOUNDS = {"lat_min": 39.85, "lat_max": 40.15, "lng_min": -75.30, "lng_max": -74.94}
_SUFFIX = ", Philadelphia, PA"
_USER_AGENT = "Pulse/0.1 (safety awareness platform)"
HEADERS = {"User-Agent": _USER_AGENT}


def configure_geocoder(
    viewbox: str = "-75.28,39.87,-74.96,40.14",
    bounds: dict | None = None,
    suffix: str = ", Philadelphia, PA",
    city_name: str = "Philadelphia",
):
    """Set up geocoder for a specific city. Call once on startup."""
    global _VIEWBOX, _BOUNDS, _SUFFIX, _USER_AGENT, HEADERS
    _VIEWBOX = viewbox
    if bounds:
        _BOUNDS = bounds
    _SUFFIX = suffix
    _USER_AGENT = f"Pulse-{city_name}/0.1 (safety awareness platform)"
    HEADERS = {"User-Agent": _USER_AGENT}
    logger.info("Geocoder configured for %s: viewbox=%s suffix=%s", city_name, viewbox, suffix)

_cache: dict[str, tuple[float, float] | None] = {}


_STRIP_PREFIXES = re.compile(
    r"^(?:near\s+|outside\s+|in\s+front\s+of\s+|behind\s+|at\s+(?:the\s+)?)"
    r"|(?:\b(?:CVS|Wawa|7-Eleven|McDonald'?s|Dunkin|Target|Walmart)\b\s*(?:on|at|near)?\s*)",
    re.IGNORECASE,
)
_BLOCK_RE = re.compile(r"\b\d+\s+block\s+of\s+", re.IGNORECASE)


def _clean_location(loc: str) -> str:
    """Strip business names, 'block of' phrasing, etc."""
    s = loc.strip()
    s = _STRIP_PREFIXES.sub("", s).strip(", ")
    s = _BLOCK_RE.sub("", s).strip(", ")
    return s


def _make_queries(loc: str, suffix: str | None = None) -> list[str]:
    """Generate multiple query reformulations to maximise Nominatim hit rate."""
    queries: list[str] = []
    if suffix is None:
        suffix = _SUFFIX

    clean = _clean_location(loc)
    suffix_parts = [p.strip() for p in suffix.strip(", ").split(",") if p.strip()]
    city_part = suffix_parts[0] if suffix_parts else ""
    state_part = suffix_parts[-1] if len(suffix_parts) > 1 else ""
    clean_has_city = bool(city_part and re.search(re.escape(city_part), clean, re.IGNORECASE))
    clean_has_state = bool(state_part and re.search(rf"\b{re.escape(state_part)}\b", clean, re.IGNORECASE))
    if clean_has_city and clean_has_state:
        suffix = ""
    elif clean_has_city and state_part:
        suffix = ", " + state_part

    queries.append(f"{clean}{suffix}")

    m = re.match(
        r"^(.+?)\s+(?:and|&|at)\s+(.+?)(?:,\s*" + re.escape(city_part) + r")?$",
        clean, re.IGNORECASE,
    )
    if m:
        a, b = m.group(1).strip(), m.group(2).strip()
        queries.append(f"{a} & {b}{suffix}")
        if not re.search(r"(?:street|avenue|ave|blvd|road|rd|drive|dr|place|pl|way)\s*$", a, re.IGNORECASE):
            queries.append(f"{a} Street & {b} Avenue{suffix}")
            queries.append(f"{a} Avenue & {b} Street{suffix}")

    has_road_type = bool(
        re.search(
            r"\b(?:street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|"
            r"lane|ln|place|pl|way|court|ct|circle|cir|terrace|ter|"
            r"parkway|pkwy|highway|hwy)\b",
            clean,
            re.IGNORECASE,
        )
    )
    if not m and not has_road_type:
        queries.append(f"{clean} Street{suffix}")

    return queries


# Nominatim result classes that are too coarse to count as a real
# incident location. When the LLM extracts a vague string like
# "Philadelphia, PA", "highway", "downtown", or "Walmart", Nominatim
# happily resolves it to the city centroid / a single arbitrary POI —
# and then *every* unrelated incident with that same vague text ends
# up stacked at one pin. We saw this in production: 154 incidents
# clustered at Philly City Hall, 104 at a single Chattanooga point,
# all with location_text values like "Philadelphia, PA" or
# "Walmart, Chattanooga, TN".
#
# Reject anything whose Nominatim "type"/"class" indicates it's
# city/state/region/POI-only rather than a street segment or
# specific address. A street with `class=highway` (residential,
# primary, etc.) or a structured address (`class=place,
# type=house`) is what we want.
_BAD_NOMINATIM_TYPES = {
    "city", "town", "village", "hamlet",
    "county", "state", "country", "region",
    "administrative",
    "suburb", "neighbourhood", "quarter", "district", "borough",
    "locality", "city_district", "subdistrict",
}
_BAD_NOMINATIM_CLASSES = {
    "boundary",
    "amenity", "shop", "tourism", "leisure",
    "office", "craft", "historic", "landuse", "natural",
}


async def _try_nominatim(
    client: httpx.AsyncClient,
    query: str,
    *,
    bounded: bool = True,
    viewbox: str | None = None,
    bounds: dict | None = None,
) -> Optional[tuple[float, float]]:
    vb = viewbox or _VIEWBOX
    bd = bounds or _BOUNDS

    params: dict[str, str] = {
        "q": query,
        "format": "json",
        "limit": "1",
        # We need addressdetails to distinguish a real street from a
        # city/POI hit (see _BAD_NOMINATIM_* above).
        "addressdetails": "1",
    }
    if bounded:
        params["viewbox"] = vb
        params["bounded"] = "1"

    resp = await client.get(NOMINATIM_URL, params=params, headers=HEADERS)
    if resp.status_code != 200:
        return None
    results = resp.json()
    if not results:
        return None

    top = results[0]
    osm_type = (top.get("type") or "").lower()
    osm_class = (top.get("class") or "").lower()
    if osm_type in _BAD_NOMINATIM_TYPES or osm_class in _BAD_NOMINATIM_CLASSES:
        logger.info(
            "Nominatim hit rejected (too coarse) for %r: class=%s type=%s",
            query, osm_class, osm_type,
        )
        return None

    lat = float(top["lat"])
    lng = float(top["lon"])
    if not (bd["lat_min"] <= lat <= bd["lat_max"] and bd["lng_min"] <= lng <= bd["lng_max"]):
        return None
    return (lat, lng)


# Strings the LLM emits when it has no real address but felt obliged to
# fill the field anyway. Geocoding any of these returns the city centroid
# (or a single random hit), so we drop them before they cluster on one pin.
_VAGUE_LOCATIONS = {
    "highway", "freeway", "expressway", "interstate", "turnpike",
    "the highway", "the freeway", "the expressway", "the interstate",
    "the turnpike",
    "downtown", "uptown", "midtown", "downtown area",
    "north", "south", "east", "west",
    "north side", "south side", "east side", "west side",
    "outside", "inside", "nearby",
    "the area", "this area", "the neighborhood", "the block",
    "unknown", "unspecified", "n/a", "none", "tbd",
    # Generic POI/feature words with no name attached. Nominatim happily
    # resolves "the mall" / "alley" / "the park" to a random POI in the
    # bbox and we end up clustering at one pin. Drop these unless the LLM
    # also gave us a street/cross-street.
    "mall", "the mall", "shopping mall", "shopping center",
    "alley", "the alley", "alleyway", "an alley",
    "park", "the park", "parking lot", "the parking lot", "parking garage",
    "the corner", "the intersection", "intersection",
    "gas station", "the gas station", "store", "the store",
    "school", "the school", "the church", "church",
    "apartment", "the apartment", "apartment building", "the apartment building",
    "house", "the house", "the residence", "residence",
    "hospital", "the hospital",
    "bus stop", "the bus stop", "bus station",
    "subway", "the subway", "subway station", "metro station",
    "train station", "the train station",
}

# Regex patterns matched against the cleaned (suffix-stripped) location_text.
# Anything matching these is "I have a road type but no specific cross-street
# or address" — Nominatim will give us a single arbitrary point on a long
# linear road, which is worse than no result.
_VAGUE_REGEXES: list[re.Pattern[str]] = [
    # Bare interstate / route designators: "I-95", "I-280", "I-95N",
    # "I-40 east", "i 95", "us-101", "us 101", "route 30", "rt 30",
    # "highway 1", "hwy 1", "sr-99", "state route 1".
    re.compile(r"^(?:i|us|sr|ca|pa)[-\s]?\d{1,3}\s*(?:[nsew]|north|south|east|west)?$", re.IGNORECASE),
    re.compile(r"^(?:route|rt|rte|highway|hwy|state\s+route|us\s+route)\s*\d{1,4}\s*(?:[nsew]|north|south|east|west)?$", re.IGNORECASE),
    # "interstate 95", "interstate 95 north"
    re.compile(r"^interstate\s+\d{1,3}\s*(?:[nsew]|north|south|east|west)?$", re.IGNORECASE),
    # "exit 6", "crossing 6", "mile marker 12", "milepost 12" — number-only
    # waypoints with no road name.
    re.compile(r"^(?:exit|crossing|mile\s*marker|mile\s*post|milepost|mp)\s+\d+\w*$", re.IGNORECASE),
    # "<brand> parking lot" — Walmart parking lot, Target parking lot, etc.
    # The brand alone is already in _clean_location's strip list; the
    # "parking lot" residue clusters at a random POI.
    re.compile(r"^(?:walmart|target|costco|home\s*depot|lowes|cvs|walgreens|wawa|7[-\s]?eleven|safeway|whole\s*foods|mcdonald'?s|starbucks|dunkin)\s+(?:parking\s+lot|parking\s+garage|parking)$", re.IGNORECASE),
    # "block of <number>" or "<number> block" with no street name.
    re.compile(r"^\d+\s+block$", re.IGNORECASE),
    re.compile(r"^block\s+of\s+\d+$", re.IGNORECASE),
    # Non-address room/unit-only fragments.
    re.compile(r"^(?:room|apt|apartment|unit|suite)\s+[a-z0-9-]+$", re.IGNORECASE),
]


_DOT_STREET_ABBREV = re.compile(
    r"\b(Rd|Ave|Blvd|Dr|Pl|Ct|Ln|Pkwy)\.(?=\s|,|$)",
    re.IGNORECASE,
)


def normalize_location_text_for_geocode(
    text: str | None,
    *,
    suffix: str,
) -> str | None:
    """Light cleanup before Nominatim: whitespace, duplicate suffix tails, Rd./Ave. dots.

    Does not expand "St" to "Street" (avoids breaking names like "St Louis").
    """
    if text is None:
        return None
    s = " ".join(str(text).split()).strip(" ,.;")
    if not s:
        return None
    suf = (suffix or "").strip()
    if suf:
        doubled = suf + suf
        while s.endswith(doubled):
            s = s[: -len(suf)].rstrip(" ,.;")
    s = _DOT_STREET_ABBREV.sub(lambda m: m.group(1), s)
    return s.strip(" ,.;") or None


def _is_too_vague(loc: str, suffix: str) -> bool:
    """True if loc is clearly not a real address (just a city, a single
    digit, a generic word, etc.). Suffix is ", City, ST" so we strip
    it before classifying."""
    if not loc:
        return True
    s = loc.strip().lower()
    # Drop the city suffix if the LLM appended it.
    suf = suffix.strip(", ").lower()
    for piece in (suf, suf.split(",")[0].strip()):
        if piece and s.endswith(piece):
            s = s[: -len(piece)].rstrip(" ,").strip()
    # Also drop a state-only suffix (", PA" / ", CA") — common when the
    # LLM gave us "I-95, PA" instead of a real cross-street.
    s = re.sub(r",\s*[a-z]{2}\s*$", "", s).strip(" ,.")
    s = s.strip(" ,.")
    if not s:
        # All that was left was the city name → vague.
        return True
    if s in _VAGUE_LOCATIONS:
        return True
    # Pure numerals or "12-34" / "1-100" range strings — meaningless to geocode.
    if re.fullmatch(r"[\d\-\s]+", s):
        return True
    # Single short token (≤3 chars) like "BQE", "I-75", "38" — too ambiguous.
    if len(s) <= 3 and " " not in s:
        return True
    # Just a quoted business name with no street ("Walmart", "McDonald's",
    # "CVS") — we already strip these brands as prefixes in _clean_location;
    # if nothing else is left, drop it.
    if re.fullmatch(
        r"(?:walmart|mcdonald'?s|cvs|wawa|7-?eleven|dunkin|target|"
        r"starbucks|whole\s*foods|home\s*depot|lowes|costco|safeway|"
        r"walgreens|trader\s*joe'?s)",
        s,
    ):
        return True
    # Highway / interstate / "exit 6" / "<brand> parking lot" — see
    # _VAGUE_REGEXES above for the exhaustive list.
    for pat in _VAGUE_REGEXES:
        if pat.match(s):
            return True
    return False


async def geocode(
    location_text: str,
    geo_ctx: dict | None = None,
) -> Optional[tuple[float, float]]:
    """Geocode a location string to (lat, lng).

    If geo_ctx is provided, uses its viewbox/bounds/suffix instead of the
    global defaults. Expected keys: viewbox, bounds, suffix.
    """
    if not location_text:
        return None

    ctx_suffix = geo_ctx.get("suffix", _SUFFIX) if geo_ctx else _SUFFIX
    ctx_viewbox = geo_ctx.get("viewbox", _VIEWBOX) if geo_ctx else _VIEWBOX
    ctx_bounds = geo_ctx.get("bounds", _BOUNDS) if geo_ctx else _BOUNDS

    if _is_too_vague(location_text, ctx_suffix):
        logger.info("Skipping vague location_text %r (would resolve to city center)", location_text)
        return None

    key = f"{ctx_suffix}:{location_text.strip().lower()}"
    if key in _cache:
        return _cache[key]

    queries = _make_queries(location_text, suffix=ctx_suffix)

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            for q in queries:
                result = await _try_nominatim(
                    client, q, bounded=True,
                    viewbox=ctx_viewbox, bounds=ctx_bounds,
                )
                if result:
                    _cache[key] = result
                    logger.info("Geocoded '%s' -> (%f, %f) via '%s'", location_text, *result, q)
                    return result
            result = await _try_nominatim(
                client, queries[0], bounded=False,
                viewbox=ctx_viewbox, bounds=ctx_bounds,
            )
            if result:
                _cache[key] = result
                logger.info("Geocoded '%s' -> (%f, %f) [unbounded]", location_text, *result)
                return result

    except Exception as e:
        logger.warning("Geocode error for '%s': %s", location_text, e)

    logger.info("No geocode results for '%s' after %d attempts", location_text, len(queries))
    _cache[key] = None
    return None


@dataclass
class GeocodeResolution:
    lat: float | None = None
    lng: float | None = None
    status: str = "failed"
    attempts: list[dict[str, Any]] = field(default_factory=list)
    resolved_text: str | None = None


def transcript_geocode_candidates(raw_text: str) -> list[str]:
    """Cheap regex pass for cross-streets / block numbers before giving up."""
    if not raw_text:
        return []
    out: list[str] = []
    for m in re.finditer(
        r"\b(\d{1,3}(?:st|nd|rd|th)?)\s+(?:and|&)\s+(\d{1,3}(?:st|nd|rd|th)?)\b",
        raw_text,
        re.IGNORECASE,
    ):
        cand = f"{m.group(1)} and {m.group(2)}"
        if cand not in out:
            out.append(cand)
    for m in re.finditer(
        r"\b(\d{1,4})\s*(?:hundred|00)?\s*block\s+of\s+([A-Za-z][\w\s]{2,40})",
        raw_text,
        re.IGNORECASE,
    ):
        cand = f"{m.group(1)} block of {m.group(2).strip()}"
        if cand not in out:
            out.append(cand)
    return out


async def resolve_incident_location(
    location_text: str | None,
    *,
    raw_text: str,
    city: str,
    geo_ctx: dict | None,
    location_confidence: str = "none",
) -> GeocodeResolution:
    """Multi-strategy geocode: aliases, reformulations, transcript regex."""
    res = GeocodeResolution(status=f"no_result_{location_confidence}")
    if not location_text:
        res.status = "failed"
        return res

    ctx_suffix = (geo_ctx or {}).get("suffix", _SUFFIX)
    candidates: list[str] = []
    for alt in expand_location_aliases(location_text, city=city):
        norm = normalize_location_text_for_geocode(alt, suffix=ctx_suffix)
        if norm and norm not in candidates:
            candidates.append(norm)
    for cand in transcript_geocode_candidates(raw_text):
        norm = normalize_location_text_for_geocode(cand, suffix=ctx_suffix)
        if norm and norm not in candidates:
            candidates.append(norm)

    for cand in candidates:
        coords = await geocode(cand, geo_ctx=geo_ctx)
        res.attempts.append({"query": cand, "ok": bool(coords)})
        if coords:
            res.lat, res.lng = coords
            res.resolved_text = cand
            res.status = f"success_{location_confidence}"
            return res

    res.status = f"no_result_{location_confidence}"
    return res
