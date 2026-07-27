"""Load multi-city metadata and public-source ID → label mappings.

Used by the FastAPI server and offline scripts so feed labels and city metadata
stay in sync without importing server (avoids circular imports).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

_PHILLY_BOUNDS = {"lat_min": 39.85, "lat_max": 40.15, "lng_min": -75.30, "lng_max": -74.94}

# slug → keys: city_name, geocode_suffix, center_lat, center_lng, bounds, viewbox, llm_local_context
CITY_REGISTRY: dict[str, dict] = {}

# Source ID (str) → human label; merged across all cities/*.yaml.
# The legacy FEED_* names remain as an API-compatibility layer for the frontend.
FEED_LABELS: dict[str, str] = {}

# feed_id → optional jurisdiction_hint / geocode_bounds / borough
FEED_META: dict[str, dict[str, Any]] = {}

# slug → [{"feed_id": "...", "label": "...", "supports_audio": False}, …]
CITY_FEEDS: dict[str, list[dict[str, Any]]] = {}

# production hostname (no www) → slug — from each city's config `city.domain`
DOMAIN_TO_SLUG: dict[str, str] = {}


def load_city_registry() -> None:
    """Populate CITY_REGISTRY, FEED_LABELS, CITY_FEEDS, DOMAIN_TO_SLUG from cities/*/config.yaml."""
    CITY_REGISTRY.clear()
    FEED_LABELS.clear()
    FEED_META.clear()
    CITY_FEEDS.clear()
    DOMAIN_TO_SLUG.clear()
    cities_dir = Path(__file__).resolve().parent.parent / "cities"
    if not cities_dir.is_dir():
        logger.warning("No cities/ directory found at %s", cities_dir)
        return
    for cfg_dir in sorted(cities_dir.iterdir()):
        cfg_path = cfg_dir / "config.yaml"
        if not cfg_path.exists():
            continue
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = yaml.safe_load(f) or {}
            slug = cfg.get("city", {}).get("slug") or cfg_dir.name
            city_name = cfg.get("city", {}).get("name", slug)
            domain_raw = cfg.get("city", {}).get("domain")
            if isinstance(domain_raw, str) and domain_raw.strip():
                d = domain_raw.strip().lower()
                if d.startswith("www."):
                    d = d[4:]
                DOMAIN_TO_SLUG[d] = slug
            geo = cfg.get("geocode", {})
            map_cfg = cfg.get("map", {})

            bounds_raw = geo.get("bounds", {})
            if isinstance(bounds_raw, str):
                parts = [float(x) for x in bounds_raw.split(",")]
                bounds = {
                    "lng_min": parts[0],
                    "lat_min": parts[1],
                    "lng_max": parts[2],
                    "lat_max": parts[3],
                }
            elif isinstance(bounds_raw, dict):
                bounds = bounds_raw
            else:
                bounds = _PHILLY_BOUNDS

            center_lat = map_cfg.get("center_lat") or (bounds["lat_min"] + bounds["lat_max"]) / 2
            center_lng = map_cfg.get("center_lng") or (bounds["lng_min"] + bounds["lng_max"]) / 2

            tuning = cfg.get("tuning") or {}
            llm_local = tuning.get("llm_local_context")
            if llm_local is None:
                llm_local = ""
            elif not isinstance(llm_local, str):
                llm_local = str(llm_local)

            # Multi-config split: if a slug appears in more than one
            # cities/<dir>/config.yaml (e.g. cities/philly + cities/philly2,
            # used to shard one city's feeds across two transcriber
            # services), keep the first registry entry — they describe
            # the same city — and below we MERGE the feeds list onto the
            # existing entry instead of overwriting it.
            if slug not in CITY_REGISTRY:
                CITY_REGISTRY[slug] = {
                    "city_name": city_name,
                    "geocode_suffix": geo.get("suffix", f", {city_name}"),
                    "center_lat": center_lat,
                    "center_lng": center_lng,
                    "bounds": bounds,
                    "viewbox": geo.get("viewbox", ""),
                    "llm_local_context": llm_local.strip(),
                }
            feeds_list: list[dict[str, Any]] = []
            configured_sources = cfg.get("public_sources")
            if configured_sources is None:
                # Compatibility for dormant/unmigrated city configs. The four
                # production cities use public_sources exclusively.
                configured_sources = cfg.get("feeds") or []
            for feed in configured_sources:
                if not isinstance(feed, dict):
                    continue
                fid = feed.get("source_id") or feed.get("feed_id")
                lab = feed.get("label")
                if fid is None or not lab:
                    continue
                k = str(fid).strip()
                if not k:
                    continue
                feeds_list.append(
                    {
                        "feed_id": k,
                        "label": str(lab).strip(),
                        "supports_audio": False,
                    }
                )
                meta: dict[str, Any] = {}
                jh = feed.get("jurisdiction_hint")
                if isinstance(jh, str) and jh.strip():
                    meta["jurisdiction_hint"] = jh.strip()
                gb = feed.get("geocode_bounds")
                if isinstance(gb, dict):
                    meta["geocode_bounds"] = gb
                elif isinstance(gb, str):
                    parts = [float(x) for x in gb.split(",")]
                    if len(parts) == 4:
                        meta["geocode_bounds"] = {
                            "lng_min": parts[0],
                            "lat_min": parts[1],
                            "lng_max": parts[2],
                            "lat_max": parts[3],
                        }
                borough = feed.get("borough")
                if isinstance(borough, str) and borough.strip():
                    meta["borough"] = borough.strip()
                if meta:
                    FEED_META[k] = meta
                if k in FEED_LABELS:
                    if FEED_LABELS[k] != str(lab).strip():
                        logger.warning(
                            "Duplicate feed_id %s with different labels (%r vs %r); keeping first",
                            k,
                            FEED_LABELS[k],
                            lab,
                        )
                    continue
                FEED_LABELS[k] = str(lab).strip()
            # Merge with any pre-existing feeds for this slug (split
            # configs); keep insertion order, drop dup feed_ids.
            existing = CITY_FEEDS.get(slug, [])
            seen = {f["feed_id"] for f in existing}
            merged = existing + [f for f in feeds_list if f["feed_id"] not in seen]
            CITY_FEEDS[slug] = merged
            if slug in CITY_REGISTRY and existing:
                logger.info(
                    "Merged %d additional feed(s) into city %s from %s "
                    "(total now %d)",
                    len(merged) - len(existing),
                    slug,
                    cfg_path,
                    len(merged),
                )
            else:
                logger.info("Registered city: %s (%s)", city_name, slug)
        except Exception as e:
            logger.warning("Failed to load city config %s: %s", cfg_path, e)


load_city_registry()
