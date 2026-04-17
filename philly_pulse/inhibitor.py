"""Local ethical guardrail for PhillyPulse.

This replaces the prior sponsor-specific external Inhibitor integration
with a built-in, deterministic guardrail that blocks obvious sensitive
content before map display.
"""

import logging
import os
import re
from dataclasses import dataclass

logger = logging.getLogger(__name__)

GUARDRAIL_MODE = os.environ.get("GUARDRAIL_MODE", "local").strip().lower()

# Conservative PII indicators.
_SSN_RE = re.compile(r"\b\d{3}-?\d{2}-?\d{4}\b")
_PHONE_RE = re.compile(r"(?:\+?1[\s.-]*)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}\b")
_EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)
_CREDIT_CARD_RE = re.compile(r"\b(?:\d[ -]*?){13,19}\b")

# Extra keywords for highly sensitive contexts.
_SENSITIVE_KEYWORDS = (
    "social security",
    "ssn",
    "date of birth",
    "dob",
    "driver license",
    "driver's license",
    "license number",
    "full legal name",
)


@dataclass
class InhibitorResult:
    status: str          # "passed", "blocked", or "bypassed"
    reason: str | None   # explanation if blocked; None if passed
    raw_response: dict | None = None


async def check_incident(
    raw_transcript: str,
    severity_category: str,
    location_text: str | None,
    confidence: float,
) -> InhibitorResult:
    """Run local ethical guardrail on an extracted incident.

    Returns InhibitorResult with status="passed" if safe to display,
    "blocked" if the content should be suppressed, or "bypassed" if
    guardrail checks are intentionally disabled.
    """
    if GUARDRAIL_MODE in {"off", "disabled", "none"}:
        return InhibitorResult(status="bypassed", reason="Local guardrail disabled")

    text = raw_transcript or ""
    lowered = text.lower()

    if _SSN_RE.search(text):
        return InhibitorResult(status="blocked", reason="Possible SSN detected")
    if _EMAIL_RE.search(text):
        return InhibitorResult(status="blocked", reason="Email address detected")
    if _PHONE_RE.search(text):
        return InhibitorResult(status="blocked", reason="Phone number detected")

    # Card regex can over-match; require likely card context.
    if _CREDIT_CARD_RE.search(text) and any(
        token in lowered for token in ("card", "credit", "debit", "visa", "mastercard", "amex")
    ):
        return InhibitorResult(status="blocked", reason="Payment card-like data detected")

    for token in _SENSITIVE_KEYWORDS:
        if token in lowered:
            return InhibitorResult(status="blocked", reason=f"Sensitive content: {token}")

    return InhibitorResult(status="passed", reason=None)
