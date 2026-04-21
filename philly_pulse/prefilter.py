"""Per-city LLM prefilter for CityPulse.

Architecture: blocklist + universal-incident escape hatch.

For every transcript line we evaluate:

  1. If ANY noise_pattern matches AND NO keep_keyword appears → return
     (False, reason). The line is confirmed junk and we skip the LLM
     call entirely.
  2. Otherwise return (True, None). Pay for the LLM. This is the
     paranoid default — if the prefilter is even slightly unsure, the
     LLM is the source of truth.

Patterns and keywords come from:

  - philly_pulse/data/prefilter_default.yaml  (shared baseline)
  - cities/<slug>/prefilter.yaml              (per-city extensions)

Both files are merged additively at process startup. There is no way
to un-set a default from a per-city file (deliberate — anything that
needs to be loosened belongs in the default).

Goal per city: ≥99% recall (≤1% of LLM-relevant lines wrongly dropped)
and ≥30% drop rate. See scripts/eval_prefilter.py for the harness that
measures both against historical Firestore extractions.

Usage::

    from philly_pulse.prefilter import is_dispatch_likely

    keep, reason = is_dispatch_likely(transcript, city="philly")
    if not keep:
        return  # skip LLM, store as prefiltered

The skip reason is recorded on the extraction row as
``prefilter_status="skipped"`` and ``prefilter_reason=<pattern>`` so the
admin panel can show why a given line never went to the LLM, and so
the eval harness can spot-check decisions later.
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from threading import Lock
from typing import Optional

import yaml

logger = logging.getLogger(__name__)

# When False, is_dispatch_likely always returns (True, None) so the LLM
# sees every line. Useful for emergency rollback without a redeploy.
PREFILTER_ENABLED = os.environ.get("PREFILTER_ENABLED", "1").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)

_DEFAULT_YAML = Path(__file__).resolve().parent / "data" / "prefilter_default.yaml"
_CITIES_DIR = Path(__file__).resolve().parent.parent / "cities"

_metrics_lock = Lock()
_metrics: dict[str, dict[str, int]] = {}


@dataclass(frozen=True)
class _CityRules:
    """Compiled prefilter rules for a single city."""

    noise_patterns: tuple[re.Pattern[str], ...]
    keep_keywords: tuple[re.Pattern[str], ...]


def _load_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f) or {}
    except Exception as e:
        logger.warning("prefilter: failed to read %s: %s", path, e)
        return {}


def _compile_patterns(raw: list[str]) -> tuple[re.Pattern[str], ...]:
    compiled: list[re.Pattern[str]] = []
    for entry in raw or []:
        if not isinstance(entry, str):
            continue
        try:
            compiled.append(re.compile(entry))
        except re.error as e:
            logger.warning("prefilter: invalid regex %r skipped: %s", entry, e)
    return tuple(compiled)


def _compile_keywords(raw: list[str]) -> tuple[re.Pattern[str], ...]:
    compiled: list[re.Pattern[str]] = []
    for kw in raw or []:
        if not isinstance(kw, str) or not kw.strip():
            continue
        # Word-boundary match, case-insensitive. We use \b around an
        # escaped literal so multi-word keywords like "shots fired"
        # still anchor on word boundaries.
        try:
            compiled.append(re.compile(rf"\b{re.escape(kw.strip())}\b", re.IGNORECASE))
        except re.error as e:
            logger.warning("prefilter: invalid keyword %r skipped: %s", kw, e)
    return tuple(compiled)


@lru_cache(maxsize=32)
def _rules_for_city(city_slug: str) -> _CityRules:
    """Load + cache the compiled rule set for a city.

    Cache key is the slug. Hot path is one dict lookup after first hit.
    """
    defaults = _load_yaml(_DEFAULT_YAML)
    overrides = _load_yaml(_CITIES_DIR / city_slug / "prefilter.yaml")

    noise = list(defaults.get("noise_patterns") or []) + list(
        overrides.get("noise_patterns") or []
    )
    keep = list(defaults.get("keep_keywords") or []) + list(
        overrides.get("keep_keywords") or []
    )

    rules = _CityRules(
        noise_patterns=_compile_patterns(noise),
        keep_keywords=_compile_keywords(keep),
    )
    logger.info(
        "prefilter[%s]: %d noise patterns, %d keep keywords",
        city_slug,
        len(rules.noise_patterns),
        len(rules.keep_keywords),
    )
    return rules


def _bump(city: str, bucket: str) -> None:
    with _metrics_lock:
        per = _metrics.setdefault(city, {"seen": 0, "skipped": 0, "kept": 0})
        per[bucket] = per.get(bucket, 0) + 1


def is_dispatch_likely(text: str, city: str = "philly") -> tuple[bool, Optional[str]]:
    """Decide whether `text` should be sent to the LLM.

    Returns (keep, reason). If keep is False, reason is the noise
    pattern (as a short label) that matched. If keep is True, reason
    is None.

    The function is intentionally cheap: at most O(N noise patterns)
    regex searches, short-circuiting on first match, then O(M keep
    keywords) only if a noise pattern hit.
    """
    _bump(city, "seen")

    if not PREFILTER_ENABLED:
        _bump(city, "kept")
        return True, None

    if not text or not text.strip():
        _bump(city, "skipped")
        return False, "empty"

    rules = _rules_for_city(city)

    # Step 1: any noise pattern hit?
    matched_noise: Optional[re.Pattern[str]] = None
    for pat in rules.noise_patterns:
        if pat.search(text):
            matched_noise = pat
            break

    if matched_noise is None:
        _bump(city, "kept")
        return True, None

    # Step 2: noise hit, but does an incident keyword override?
    for kw in rules.keep_keywords:
        if kw.search(text):
            _bump(city, "kept")
            return True, None

    _bump(city, "skipped")
    # Truncate the pattern repr so callers can store it in Firestore
    # without dumping a multi-hundred-char regex into the document.
    reason = matched_noise.pattern[:80]
    return False, reason


def get_metrics() -> dict[str, dict[str, int]]:
    """Snapshot of in-process counters since the worker started.

    Used by `/api/admin/prefilter/metrics` so the admin UI (and any
    cron) can see how often the prefilter actually fires per city.
    """
    with _metrics_lock:
        return {c: dict(v) for c, v in _metrics.items()}


def reset_metrics() -> None:
    """For tests / manual resets."""
    with _metrics_lock:
        _metrics.clear()
