"""Amazon SES email sender for CityPulse newsroom alerts.

Mirrors bedrock_chat.py's AWS config: credentials come from the
AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION env vars (the same
algoarena-bedrock user, which now carries the citypulse-ses policy). Sends from
a verified SES domain identity (423pulse.com).

Gated by SES_ENABLED so the path stays dark until the domain's DKIM verifies —
flip SES_ENABLED=true (server env) once `aws sesv2 get-email-identity` shows
VerifiedForSendingStatus=true. Until then send_email() is a no-op returning False.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

_TRUTHY = ("1", "true", "yes", "on")

# From address for newsroom alert emails — must sit on a verified SES domain.
SES_FROM_EMAIL = os.environ.get("SES_FROM_EMAIL", "alerts@423pulse.com")
SES_FROM_NAME = os.environ.get("SES_FROM_NAME", "CityPulse Newsroom")

# Per-city sending domain so a reporter's alert comes "from" their own city's
# site (all SES-verified). Falls back to 423pulse.com for unknown slugs.
CITY_SEND_DOMAINS = {
    "chattanooga": "423pulse.com",
    "sf": "sfopulse.com",
    "philly": "phlpulse.com",
    "nyc": "newyorkcitypulse.com",
}


def from_email_for_city(city: str) -> str:
    """`alerts@<city domain>` — the SES-verified sender for that city."""
    domain = CITY_SEND_DOMAINS.get((city or "").strip().lower()) or "423pulse.com"
    return f"alerts@{domain}"


_client = None


def _ses_client():
    global _client
    if _client is None:
        import boto3  # lazy: only when SES is actually used

        _client = boto3.client(
            "sesv2",
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
        )
    return _client


def ses_configured() -> bool:
    """True when SES sending is switched on AND AWS creds are present."""
    if os.environ.get("SES_ENABLED", "").strip().lower() not in _TRUTHY:
        return False
    return bool(
        os.environ.get("AWS_ACCESS_KEY_ID", "").strip()
        and os.environ.get("AWS_SECRET_ACCESS_KEY", "").strip()
    )


def send_email(
    *,
    to: str,
    subject: str,
    text: str,
    html: Optional[str] = None,
    from_email: Optional[str] = None,
) -> bool:
    """Send one transactional email via SES. Returns True on success, False on
    any failure or when SES isn't configured (callers treat email as best-effort).

    `from_email` overrides the default sender (use from_email_for_city())."""
    if not ses_configured():
        return False
    to = (to or "").strip()
    if not to or "@" not in to:
        return False
    sender = (from_email or SES_FROM_EMAIL).strip()
    body: dict = {"Text": {"Data": text, "Charset": "UTF-8"}}
    if html:
        body["Html"] = {"Data": html, "Charset": "UTF-8"}
    try:
        _ses_client().send_email(
            FromEmailAddress=f"{SES_FROM_NAME} <{sender}>",
            Destination={"ToAddresses": [to]},
            Content={
                "Simple": {
                    "Subject": {"Data": subject, "Charset": "UTF-8"},
                    "Body": body,
                }
            },
        )
        return True
    except Exception as e:  # pragma: no cover — network/permission failures
        logger.warning("SES send to %s failed: %s", to, e)
        return False
