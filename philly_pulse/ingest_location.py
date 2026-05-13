"""Geocode + feed/transcript validation for ingest promotion."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

from . import geocode
from .location_validate import ValidationResult, validate_location


@dataclass
class LocationPipelineResult:
    lat: float | None
    lng: float | None
    location_text: str | None
    geocode_status: str
    geocode_attempts: list[dict[str, Any]]
    validation: ValidationResult | None = None


async def resolve_validated_location(
    *,
    raw_text: str,
    location_text: str | None,
    location_confidence: str,
    city: str,
    geo_ctx: dict | None,
    feed_meta: dict[str, Any] | None,
) -> LocationPipelineResult:
    geo_suffix = (geo_ctx or {}).get("suffix") or ""
    if location_text and geo_suffix:
        location_text = geocode.normalize_location_text_for_geocode(
            location_text, suffix=geo_suffix
        )

    resolution = await geocode.resolve_incident_location(
        location_text,
        raw_text=raw_text,
        city=city,
        geo_ctx=geo_ctx,
        location_confidence=location_confidence,
    )
    attempts = list(resolution.attempts)
    resolved_text = resolution.resolved_text or location_text

    if resolution.lat is None or resolution.lng is None:
        return LocationPipelineResult(
            lat=None,
            lng=None,
            location_text=resolved_text,
            geocode_status=resolution.status,
            geocode_attempts=attempts,
            validation=None,
        )

    validation = validate_location(
        raw_text=raw_text,
        location_text=resolved_text,
        lat=resolution.lat,
        lng=resolution.lng,
        feed_meta=feed_meta,
        city=city,
    )
    if not validation.ok:
        return LocationPipelineResult(
            lat=None,
            lng=None,
            location_text=resolved_text,
            geocode_status="validation_failed",
            geocode_attempts=attempts,
            validation=validation,
        )

    return LocationPipelineResult(
        lat=resolution.lat,
        lng=resolution.lng,
        location_text=resolved_text,
        geocode_status=resolution.status,
        geocode_attempts=attempts,
        validation=validation,
    )


def max_extract_attempts() -> int:
    try:
        return max(1, int(os.environ.get("LOCATION_EXTRACT_MAX_ATTEMPTS", "3")))
    except ValueError:
        return 3
