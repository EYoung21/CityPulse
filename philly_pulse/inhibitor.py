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

# PII indicators — tuned to avoid police-dispatch false positives.
_DISPATCH_CODE_RE = re.compile(r"\b911-\d{2}-\d{4}\b")
_SSN_DASHED_RE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
_SSN_PLAIN_RE = re.compile(r"\b\d{9}\b")
_PHONE_RE = re.compile(
    r"(?:\+1[\s.-])?"
    r"(?:\(\d{3}\)[\s.-]*\d{3}[\s.-]*\d{4}"
    r"|\b[2-9]\d{2}[\s.-]\d{3}[\s.-]\d{4}\b)"
)
# Bare, separator-less 10/11-digit phone (e.g. "2155551234"). Restricted to
# NANP shape — area code and exchange both start 2-9 — so unit numbers,
# addresses, and case/ID numbers (which routinely start with 0/1) don't match.
_PHONE_PLAIN_RE = re.compile(r"\b1?[2-9]\d{2}[2-9]\d{2}\d{4}\b")
_EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)
_CREDIT_CARD_RE = re.compile(r"\b(?:\d[ -]*?){13,19}\b")
_RADIO_DIGIT_NOISE_RE = re.compile(r"(?:\d\s*-\s*){8,}\d")
_CARD_CTX_RE = re.compile(
    r"\b(?:credit\s+card|debit\s+card|card\s+number|mastercard|visa|amex)\b|\bcard\b",
    re.I,
)

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


def _has_ssn(text: str) -> bool:
    """Detect likely SSNs while exempting 911 dispatch location codes."""
    for match in _SSN_DASHED_RE.finditer(text):
        if _DISPATCH_CODE_RE.fullmatch(match.group()):
            continue
        return True
    lowered = text.lower()
    if any(token in lowered for token in ("social security", "ssn")):
        return bool(_SSN_PLAIN_RE.search(text))
    return False


def _has_phone(text: str) -> bool:
    """Detect phone numbers in both separated and bare 10/11-digit forms."""
    return bool(_PHONE_RE.search(text) or _PHONE_PLAIN_RE.search(text))


def _has_payment_card(text: str) -> bool:
    """Detect payment-card numbers; skip radio digit noise and 'cardiac' false hits."""
    if not _CREDIT_CARD_RE.search(text):
        return False
    if not _CARD_CTX_RE.search(text):
        return False
    if _RADIO_DIGIT_NOISE_RE.search(text):
        return False
    return True


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

    if _has_ssn(text):
        return InhibitorResult(status="blocked", reason="Possible SSN detected")
    if _EMAIL_RE.search(text):
        return InhibitorResult(status="blocked", reason="Email address detected")
    if _has_phone(text):
        return InhibitorResult(status="blocked", reason="Phone number detected")
    if _has_payment_card(text):
        return InhibitorResult(status="blocked", reason="Payment card-like data detected")

    for token in _SENSITIVE_KEYWORDS:
        if token in lowered:
            return InhibitorResult(status="blocked", reason=f"Sensitive content: {token}")

    return InhibitorResult(status="passed", reason=None)
