"""Local ethical guardrail for PhillyPulse.

This replaces the prior sponsor-specific external Inhibitor integration
with a built-in, deterministic guardrail.

Policy: **redact, don't block.** Dispatch radio is full of number
sequences (addresses, unit IDs, case numbers, callback numbers) and spoken
terms like "date of birth" that look like PII but are not — and blocking the
whole incident on a match silently drops real life-safety emergencies (a
suicidal-veteran call, a 77-year-old unresponsive). Instead we mask PII
*values* in the stored/displayed transcript and publish the incident anyway,
so the map pin, description, and location survive. Over-masking a case number
is a cosmetic cost; losing an emergency is not.
"""

import logging
import os
import re
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

GUARDRAIL_MODE = os.environ.get("GUARDRAIL_MODE", "local").strip().lower()

REDACTION_PLACEHOLDER = "[redacted]"

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
# Under the redact-and-publish policy, an occasional 10-digit case number that
# slips through is merely masked, not blocked.
_PHONE_PLAIN_RE = re.compile(r"\b1?[2-9]\d{2}[2-9]\d{2}\d{4}\b")
_EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)
_CREDIT_CARD_RE = re.compile(r"\b(?:\d[ -]*?){13,19}\b")
_RADIO_DIGIT_NOISE_RE = re.compile(r"(?:\d\s*-\s*){8,}\d")
_CARD_CTX_RE = re.compile(
    r"\b(?:credit\s+card|debit\s+card|card\s+number|mastercard|visa|amex)\b|\bcard\b",
    re.I,
)
# Date-of-birth: redact an actual date *value* that appears near a DOB cue.
# The cue word alone ("date of birth", "DOB") is not PII and must not trigger
# anything on its own — that naive substring match was blocking emergencies
# whenever a dispatcher relayed a suspect's DOB.
_DOB_CUE_RE = re.compile(r"\b(?:date\s+of\s+birth|d\.?o\.?b\.?|born(?:\s+on)?)\b", re.I)
_DATE_VALUE_RE = re.compile(r"\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}\b")


@dataclass
class InhibitorResult:
    status: str          # "passed", "redacted", or "bypassed"
    reason: str | None   # comma-joined redaction categories, or None
    redactions: list[str] = field(default_factory=list)
    redacted_text: str | None = None  # text with PII masked (None if clean)
    raw_response: dict | None = None


def redact_pii(text: str) -> tuple[str, list[str]]:
    """Mask PII *values* in ``text`` so an incident can be published safely.

    Returns ``(redacted_text, categories)``. ``categories`` is empty when
    nothing was masked. Police-dispatch artifacts — 911 location codes, radio
    digit noise, and addresses/case numbers that don't take phone shape — are
    intentionally preserved.
    """
    if not text:
        return text, []

    reasons: list[str] = []
    out = text

    def _note(cat: str) -> None:
        if cat not in reasons:
            reasons.append(cat)

    # Email
    if _EMAIL_RE.search(out):
        out = _EMAIL_RE.sub(REDACTION_PLACEHOLDER, out)
        _note("email")

    # SSN (dashed) — keep 911-XX-XXXX dispatch location codes.
    def _ssn_sub(m: re.Match) -> str:
        if _DISPATCH_CODE_RE.fullmatch(m.group()):
            return m.group()
        _note("ssn")
        return REDACTION_PLACEHOLDER

    out = _SSN_DASHED_RE.sub(_ssn_sub, out)
    # Plain 9-digit SSN only when explicit SSN context is present.
    if any(tok in out.lower() for tok in ("social security", "ssn")):
        masked = _SSN_PLAIN_RE.sub(REDACTION_PLACEHOLDER, out)
        if masked != out:
            _note("ssn")
            out = masked

    # Phone — separated and bare NANP forms.
    def _phone_sub(m: re.Match) -> str:
        _note("phone")
        return REDACTION_PLACEHOLDER

    out = _PHONE_RE.sub(_phone_sub, out)
    out = _PHONE_PLAIN_RE.sub(_phone_sub, out)

    # Payment card — require card context and skip radio digit noise.
    if _CARD_CTX_RE.search(out) and not _RADIO_DIGIT_NOISE_RE.search(out):
        masked = _CREDIT_CARD_RE.sub(REDACTION_PLACEHOLDER, out)
        if masked != out:
            _note("payment_card")
            out = masked

    # Date of birth — redact date values only when a DOB cue is present.
    if _DOB_CUE_RE.search(out):
        def _dob_sub(m: re.Match) -> str:
            _note("date_of_birth")
            return REDACTION_PLACEHOLDER

        out = _DATE_VALUE_RE.sub(_dob_sub, out)

    return out, reasons


async def check_incident(
    raw_transcript: str,
    severity_category: str,
    location_text: str | None,
    confidence: float,
) -> InhibitorResult:
    """Run the local guardrail on an extracted incident.

    Never blocks: returns status="passed" when the transcript is clean,
    "redacted" when PII values were masked (the incident still publishes,
    using ``redacted_text``), or "bypassed" when the guardrail is disabled.
    """
    if GUARDRAIL_MODE in {"off", "disabled", "none"}:
        return InhibitorResult(status="bypassed", reason="Local guardrail disabled")

    text = raw_transcript or ""
    redacted, reasons = redact_pii(text)
    if reasons:
        return InhibitorResult(
            status="redacted",
            reason=", ".join(reasons),
            redactions=reasons,
            redacted_text=redacted,
        )
    return InhibitorResult(status="passed", reason=None)
