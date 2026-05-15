"""Per-city street aliases and dispatch vocabulary for geocode + validation."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml

_REPO = Path(__file__).resolve().parent.parent
_CACHE: dict[str, dict[str, Any]] = {}
_LEXICON_CACHE: dict[str, list[dict[str, Any]]] = {}
_LEXICON_PATTERNS: dict[str, list[tuple[re.Pattern[str], str]]] = {}


def _load_city(slug: str) -> dict[str, Any]:
    slug = (slug or "").strip().lower()
    if slug in _CACHE:
        return _CACHE[slug]
    path = _REPO / "cities" / slug / "location_aliases.yaml"
    data: dict[str, Any] = {"aliases": {}, "boroughs": {}}
    if path.is_file():
        try:
            with open(path, "r", encoding="utf-8") as f:
                loaded = yaml.safe_load(f) or {}
            if isinstance(loaded, dict):
                data.update(loaded)
        except Exception:
            pass
    _CACHE[slug] = data
    return data


def _load_lexicon_entries(city_slug: str) -> list[dict[str, Any]]:
    slug = (city_slug or "").strip().lower()
    if slug in _LEXICON_CACHE:
        return _LEXICON_CACHE[slug]
    path = _REPO / "cities" / slug / "location_lexicon.yaml"
    entries: list[dict[str, Any]] = []
    if path.is_file():
        try:
            with open(path, "r", encoding="utf-8") as f:
                loaded = yaml.safe_load(f) or {}
            raw = loaded.get("entries") if isinstance(loaded, dict) else None
            if isinstance(raw, list):
                entries = [e for e in raw if isinstance(e, dict)]
        except Exception:
            pass
    _LEXICON_CACHE[slug] = entries
    return entries


def _lexicon_compiled(slug: str) -> list[tuple[re.Pattern[str], str]]:
    if slug in _LEXICON_PATTERNS:
        return _LEXICON_PATTERNS[slug]
    compiled: list[tuple[re.Pattern[str], str]] = []
    for entry in _load_lexicon_entries(slug):
        pat = entry.get("pattern")
        rep = entry.get("replace")
        if not isinstance(pat, str) or not isinstance(rep, str):
            continue
        try:
            compiled.append((re.compile(pat), rep))
        except re.error:
            continue
    _LEXICON_PATTERNS[slug] = compiled
    return compiled


def apply_location_lexicon(text: str | None, *, city: str) -> str | None:
    """Apply per-city `location_lexicon.yaml` regex replacements (geocode tuning).

    Rules are applied in file order, each to the result of the previous step.
    """
    if not text or not str(text).strip():
        return None
    slug = (city or "").strip().lower()
    if not slug:
        return text
    s = str(text)
    for cre, rep in _lexicon_compiled(slug):
        s = cre.sub(rep, s)
    s = " ".join(s.split()).strip(" ,.;")
    return s or None


def expand_location_aliases(location_text: str | None, *, city: str) -> list[str]:
    """Return alternate location strings (original first)."""
    if not location_text:
        return []
    text = " ".join(str(location_text).split()).strip()
    if not text:
        return []
    out: list[str] = [text]
    cfg = _load_city(city)
    aliases: dict[str, Any] = cfg.get("aliases") or {}
    low = text.lower()
    for canonical, variants in aliases.items():
        needles = [canonical] + (variants if isinstance(variants, list) else [])
        for needle in needles:
            if not needle:
                continue
            if needle.lower() in low:
                alt = re.sub(re.escape(needle), canonical, text, flags=re.IGNORECASE)
                if alt not in out:
                    out.append(alt)
    # NYC: duplicate avenue names in one intersection ("6th Ave and Avenue of the Americas")
    if " and " in low or " & " in low:
        parts = re.split(r"\s+(?:and|&)\s+", text, maxsplit=1, flags=re.IGNORECASE)
        if len(parts) == 2 and parts[0].strip().lower() == parts[1].strip().lower():
            out.append(parts[0].strip())
    expanded: list[str] = []
    for item in out:
        if item not in expanded:
            expanded.append(item)
        lexd = apply_location_lexicon(item, city=city)
        if lexd and lexd != item and lexd not in expanded:
            expanded.append(lexd)
    return expanded


def borough_bounds(city: str, borough: str | None) -> dict[str, float] | None:
    if not borough:
        return None
    cfg = _load_city(city)
    boroughs = cfg.get("boroughs") or {}
    b = boroughs.get(borough) or boroughs.get(borough.lower())
    if isinstance(b, dict) and all(k in b for k in ("lat_min", "lat_max", "lng_min", "lng_max")):
        return {k: float(b[k]) for k in ("lat_min", "lat_max", "lng_min", "lng_max")}
    return None


def match_borough_key(location_text: str | None, *, city: str) -> str | None:
    """Map borough/neighborhood phrases to a configured borough key (e.g. West Bronx → Bronx)."""
    if not location_text:
        return None
    cfg = _load_city(city)
    boroughs: dict[str, Any] = cfg.get("boroughs") or {}
    if not boroughs:
        return None
    low = " ".join(str(location_text).split()).lower()
    if not low:
        return None
    # Longest alias first so "west bronx" wins over "bronx".
    alias_map: dict[str, str] = {}
    for key in boroughs:
        alias_map[key.lower()] = key
    extra = cfg.get("borough_aliases") or {}
    if isinstance(extra, dict):
        for needle, target in extra.items():
            if needle and target:
                alias_map[str(needle).lower()] = str(target)
    for needle in sorted(alias_map, key=len, reverse=True):
        if needle in low:
            return alias_map[needle]
    return None


def borough_centroid(city: str, borough_key: str) -> tuple[float, float] | None:
    """Center of a borough bounding box — used when dispatch only names the borough."""
    bb = borough_bounds(city, borough_key)
    if not bb:
        return None
    return (
        (bb["lat_min"] + bb["lat_max"]) / 2,
        (bb["lng_min"] + bb["lng_max"]) / 2,
    )
