"""Load multi-city LLM/geocode registry and global Broadcastify feed_id → label map.

Used by the FastAPI server and offline scripts so feed labels and city metadata
stay in sync without importing server (avoids circular imports).
"""

from __future__ import annotations

import logging
from pathlib import Path

import yaml

logger = logging.getLogger(__name__)

_PHILLY_BOUNDS = {"lat_min": 39.85, "lat_max": 40.15, "lng_min": -75.30, "lng_max": -74.94}

# slug → keys: city_name, geocode_suffix, center_lat, center_lng, bounds, viewbox, llm_local_context
CITY_REGISTRY: dict[str, dict] = {}

# Broadcastify feed_id (str) → human label; merged across all cities/*.yaml
FEED_LABELS: dict[str, str] = {}


def load_city_registry() -> None:
    """Populate CITY_REGISTRY and FEED_LABELS from cities/*/config.yaml."""
    CITY_REGISTRY.clear()
    FEED_LABELS.clear()
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

            CITY_REGISTRY[slug] = {
                "city_name": city_name,
                "geocode_suffix": geo.get("suffix", f", {city_name}"),
                "center_lat": center_lat,
                "center_lng": center_lng,
                "bounds": bounds,
                "viewbox": geo.get("viewbox", ""),
                "llm_local_context": llm_local.strip(),
            }
            for feed in cfg.get("feeds") or []:
                if not isinstance(feed, dict):
                    continue
                fid = feed.get("feed_id")
                lab = feed.get("label")
                if fid is None or not lab:
                    continue
                k = str(fid).strip()
                if not k:
                    continue
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
            logger.info("Registered city: %s (%s)", city_name, slug)
        except Exception as e:
            logger.warning("Failed to load city config %s: %s", cfg_path, e)


load_city_registry()
