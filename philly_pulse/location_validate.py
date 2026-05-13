"""Validate geocoded incident locations against transcript + feed jurisdiction."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any

from .location_aliases import borough_bounds

_ORDINAL_RE = re.compile(
    r"\b(?:west|east|north|south|w|e|n|s)?\s*(\d{1,3})(?:st|nd|rd|th)?\s+"
    r"(?:street|st|avenue|ave|boulevard|blvd|road|rd|drive|dr|lane|ln|place|pl|way)\b",
    re.IGNORECASE,
)
_BLOCK_RE = re.compile(r"\b(\d{1,4})\s*(?:hundred|00)?\s*block\s+of\b", re.IGNORECASE)
_INTERSECTION_RE = re.compile(
    r"\b(\d{1,3})\s*(?:st|nd|rd|th)?\s+(?:and|&)\s+(\d{1,3})\s*(?:st|nd|rd|th)?\b",
    re.IGNORECASE,
)


def _digits_in_text(text: str) -> set[int]:
    nums: set[int] = set()
    for m in _ORDINAL_RE.finditer(text):
        nums.add(int(m.group(1)))
    for m in _BLOCK_RE.finditer(text):
        nums.add(int(m.group(1)))
    for m in _INTERSECTION_RE.finditer(text):
        nums.add(int(m.group(1)))
        nums.add(int(m.group(2)))
    for m in re.finditer(r"\b(\d{1,3})\b", text):
        n = int(m.group(1))
        if 1 <= n <= 200:
            nums.add(n)
    return nums


def _edit_distance_leq(a: int, b: int, max_dist: int) -> bool:
    return abs(a - b) <= max_dist


@dataclass
class ValidationResult:
    ok: bool
    reason: str | None = None


def extract_transcript_location_numbers(raw_text: str) -> set[int]:
    return _digits_in_text(raw_text or "")


def validate_location(
    *,
    raw_text: str,
    location_text: str | None,
    lat: float,
    lng: float,
    feed_meta: dict[str, Any] | None,
    city: str,
) -> ValidationResult:
    """Reject pins that contradict transcript ordinals or feed bounds."""
    if not location_text:
        return ValidationResult(False, "missing location_text")

    feed_meta = feed_meta or {}
    bounds = feed_meta.get("geocode_bounds")
    borough = feed_meta.get("borough")
    if bounds and isinstance(bounds, dict):
        try:
            if not (
                float(bounds["lat_min"]) <= lat <= float(bounds["lat_max"])
                and float(bounds["lng_min"]) <= lng <= float(bounds["lng_max"])
            ):
                return ValidationResult(False, "geocoded point outside feed geocode_bounds")
        except (KeyError, TypeError, ValueError):
            pass
    elif borough:
        bb = borough_bounds(city, str(borough))
        if bb and not (
            bb["lat_min"] <= lat <= bb["lat_max"] and bb["lng_min"] <= lng <= bb["lng_max"]
        ):
            return ValidationResult(False, f"geocoded point outside {borough} bounds")

    transcript_nums = extract_transcript_location_numbers(raw_text)
    loc_nums = extract_transcript_location_numbers(location_text)
    if not transcript_nums:
        return ValidationResult(True)

    max_dist = int(os.environ.get("LOCATION_VALIDATE_MAX_ORDINAL_DELTA", "2"))
    combined = transcript_nums | loc_nums
    if not combined:
        return ValidationResult(True)

    # If transcript names a specific ordinal, location_text should mention a nearby one.
    for t in transcript_nums:
        if any(_edit_distance_leq(t, l, max_dist) for l in loc_nums):
            continue
        # Transcript has a street number not reflected in extracted location.
        if t >= 10:
            return ValidationResult(
                False,
                f"transcript mentions street number {t} but location_text lacks a matching ordinal",
            )
    return ValidationResult(True)
