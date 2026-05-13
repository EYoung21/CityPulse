"""Per-city street aliases and dispatch vocabulary for geocode + validation."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml

_REPO = Path(__file__).resolve().parent.parent
_CACHE: dict[str, dict[str, Any]] = {}


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
    return out


def borough_bounds(city: str, borough: str | None) -> dict[str, float] | None:
    if not borough:
        return None
    cfg = _load_city(city)
    boroughs = cfg.get("boroughs") or {}
    b = boroughs.get(borough) or boroughs.get(borough.lower())
    if isinstance(b, dict) and all(k in b for k in ("lat_min", "lat_max", "lng_min", "lng_max")):
        return {k: float(b[k]) for k in ("lat_min", "lat_max", "lng_min", "lng_max")}
    return None
