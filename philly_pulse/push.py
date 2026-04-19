"""Web Push (VAPID) subscription store + sender.

This module owns everything Web-Push-related on the backend:

  * VAPID keypair loading from the environment
  * Firestore-backed subscription CRUD (per-user, per-device)
  * The actual `pywebpush.webpush` send call with sane defaults
    and 410-Gone autocleanup of dead endpoints

It is intentionally separate from the FastAPI server so the same
helpers can be reused by future cron jobs or background tasks
that want to push to subscribers without touching HTTP routes.

VAPID key environment variables (preferred over a config file so
the same deploy works in containers without bind mounts):

  PHILLY_PULSE_VAPID_PUBLIC_KEY   — base64url, 65 bytes
  PHILLY_PULSE_VAPID_PRIVATE_KEY  — base64url, 32 bytes
  PHILLY_PULSE_VAPID_SUBJECT      — mailto:you@example.com
                                    (RFC8292 §2 requires either
                                    a mailto: or https: URL).

Generate keys once with:

  python -c "from py_vapid import Vapid; \\
             v=Vapid(); v.generate_keys(); \\
             print(v.public_key.public_bytes_raw().hex()); \\
             print(v.private_key.private_bytes_raw().hex())"

Subscriptions in Firestore live under `pushSubscriptions/{hash}`,
where `hash` is a stable derivation of the endpoint URL so the
same browser re-subscribing produces an idempotent upsert (no
runaway dupes when the user toggles the setting on/off).
"""

from __future__ import annotations

import base64
import hashlib
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger(__name__)


# ── VAPID config ────────────────────────────────────────────────────

@dataclass(frozen=True)
class VapidConfig:
    """Loaded once at process start; immutable so callers can cache."""
    public_key: str
    private_key: str
    subject: str

    @property
    def configured(self) -> bool:
        # All three fields must be present and non-empty for any push
        # call to succeed — partial config is treated as fully off.
        return bool(self.public_key and self.private_key and self.subject)


def _load_vapid_config() -> VapidConfig:
    pub = (os.environ.get("PHILLY_PULSE_VAPID_PUBLIC_KEY") or "").strip()
    priv = (os.environ.get("PHILLY_PULSE_VAPID_PRIVATE_KEY") or "").strip()
    subj = (os.environ.get("PHILLY_PULSE_VAPID_SUBJECT") or "").strip()
    cfg = VapidConfig(public_key=pub, private_key=priv, subject=subj)
    if not cfg.configured:
        logger.info(
            "Web Push disabled: PHILLY_PULSE_VAPID_* env vars not set. "
            "See philly_pulse/push.py for setup instructions."
        )
    return cfg


_VAPID_CONFIG: Optional[VapidConfig] = None


def get_vapid_config() -> VapidConfig:
    """Lazy + cached so the import doesn't dict-fetch env at module load."""
    global _VAPID_CONFIG
    if _VAPID_CONFIG is None:
        _VAPID_CONFIG = _load_vapid_config()
    return _VAPID_CONFIG


# ── Firestore subscription store ────────────────────────────────────

# Pulled lazily because not every consumer of this module wants to
# pay the firebase_admin init cost (e.g. tests, key-derivation
# helpers). Importing inside the function keeps cold-start cheap
# for callers that just need a hash or the public key.
def _db():
    from .firestore_store import _ensure_client
    return _ensure_client()


@dataclass
class PushSubscription:
    """Mirrors the W3C PushSubscription.toJSON() shape we accept from
    the browser, plus a `uid` so we know who to notify and an
    optional `userAgent` for debugging."""
    endpoint: str
    p256dh: str
    auth: str
    uid: str
    user_agent: str = ""
    city: str = ""
    created_at_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    last_used_ms: int = 0


def derive_subscription_hash(endpoint: str) -> str:
    """Stable, URL-safe doc id for a given endpoint URL.

    SHA-256 keeps it fixed-length even for the very long FCM/Mozilla
    endpoint URLs and avoids reserved characters in Firestore doc
    ids. We don't truncate — the marginal cost of 64 chars is
    nothing compared to the headache of a hash collision."""
    return hashlib.sha256(endpoint.encode("utf-8")).hexdigest()


def upsert_subscription(sub: PushSubscription) -> str:
    """Idempotent insert. Returns the doc id used."""
    doc_id = derive_subscription_hash(sub.endpoint)
    _db().collection("pushSubscriptions").document(doc_id).set({
        "endpoint": sub.endpoint,
        # The two crypto material fields the browser hands back.
        # Stored as the original base64url strings so pywebpush gets
        # them in exactly the format it expects.
        "p256dh": sub.p256dh,
        "auth": sub.auth,
        "uid": sub.uid,
        "userAgent": sub.user_agent or "",
        "city": sub.city or "",
        "createdAtMs": sub.created_at_ms,
        "lastUsedMs": sub.last_used_ms,
    })
    return doc_id


def delete_subscription(endpoint: str, expected_uid: Optional[str] = None) -> bool:
    """Remove a subscription by endpoint URL.

    When `expected_uid` is supplied we refuse to delete a doc owned
    by a different user — defensive check so a leaked subscription
    object can't be used to scrub someone else's record."""
    doc_id = derive_subscription_hash(endpoint)
    ref = _db().collection("pushSubscriptions").document(doc_id)
    snap = ref.get()
    if not snap.exists:
        return False
    if expected_uid and (snap.to_dict() or {}).get("uid") != expected_uid:
        return False
    ref.delete()
    return True


def list_subscriptions_for_uid(uid: str) -> list[dict[str, Any]]:
    docs = _db().collection("pushSubscriptions").where("uid", "==", uid).stream()
    return [{"id": d.id, **(d.to_dict() or {})} for d in docs]


def list_all_subscriptions(city: Optional[str] = None) -> list[dict[str, Any]]:
    """City filter is optional so single-city deployments don't pay the
    indexing cost; pass None to push to every subscriber regardless of
    pulse city. Useful for global maintenance pings."""
    q = _db().collection("pushSubscriptions")
    if city:
        q = q.where("city", "==", city)
    return [{"id": d.id, **(d.to_dict() or {})} for d in q.stream()]


# ── Sender ──────────────────────────────────────────────────────────

# `pywebpush` is an optional dependency — module imports cleanly even
# when it isn't installed, so a deploy that hasn't enabled push
# yet won't break on import.
try:  # pragma: no cover — exercised in deploys with push enabled
    from pywebpush import WebPushException, webpush
    _PYWEBPUSH_AVAILABLE = True
except Exception:  # pragma: no cover
    webpush = None  # type: ignore[assignment]
    WebPushException = Exception  # type: ignore[assignment,misc]
    _PYWEBPUSH_AVAILABLE = False


def push_available() -> bool:
    return _PYWEBPUSH_AVAILABLE and get_vapid_config().configured


def _vapid_claims_for(endpoint: str) -> dict[str, Any]:
    # `aud` defaults to the origin of the push service URL when omitted
    # by pywebpush, but we're explicit so the JWT claim always matches.
    from urllib.parse import urlparse
    u = urlparse(endpoint)
    return {
        "sub": get_vapid_config().subject,
        "aud": f"{u.scheme}://{u.netloc}",
    }


def send_to_subscription(
    sub_doc: dict[str, Any],
    payload: dict[str, Any],
    *,
    ttl_seconds: int = 60 * 30,
) -> tuple[bool, str]:
    """Send a payload to a single Firestore subscription doc.

    Returns (delivered, status_message). On a 404/410 Gone we delete
    the row so the next fan-out doesn't pay for a dead endpoint.

    `ttl_seconds` is the max time the push service should hold the
    message before giving up. 30 min is a reasonable balance for
    safety alerts: long enough that a phone in a tunnel still gets
    the buzz when it surfaces, short enough that hours-stale alerts
    don't surprise the user."""
    if not push_available():
        return False, "push_not_configured"
    cfg = get_vapid_config()
    endpoint = sub_doc.get("endpoint", "")
    p256dh = sub_doc.get("p256dh", "")
    auth = sub_doc.get("auth", "")
    if not (endpoint and p256dh and auth):
        return False, "incomplete_subscription"
    import json as _json

    try:
        webpush(
            subscription_info={
                "endpoint": endpoint,
                "keys": {"p256dh": p256dh, "auth": auth},
            },
            data=_json.dumps(payload),
            vapid_private_key=cfg.private_key,
            vapid_claims=_vapid_claims_for(endpoint),
            ttl=ttl_seconds,
        )
    except WebPushException as e:  # type: ignore[misc]
        # Push services use 404/410 to indicate "this endpoint is
        # gone, stop sending." We honor that by deleting our copy
        # so the user doesn't keep getting silent failures forever.
        status = getattr(e.response, "status_code", None) if getattr(e, "response", None) else None
        if status in (404, 410):
            try:
                delete_subscription(endpoint)
            except Exception:
                logger.warning("Failed to clean up gone subscription %s", endpoint)
            return False, f"gone_{status}"
        logger.warning("webpush send failed (%s): %s", status, e)
        return False, f"error_{status or 'unknown'}"
    except Exception as e:  # pragma: no cover
        logger.warning("webpush send raised: %s", e)
        return False, "error_exception"

    # Bump last_used so we can prune stale subscriptions later.
    try:
        _db().collection("pushSubscriptions").document(sub_doc["id"]).update(
            {"lastUsedMs": int(time.time() * 1000)}
        )
    except Exception:
        # Non-fatal; the push already went out.
        pass
    return True, "ok"


def send_to_uid(
    uid: str, payload: dict[str, Any], *, ttl_seconds: int = 60 * 30
) -> dict[str, int]:
    """Fan out a payload to every device the user has subscribed.

    Returns a small {sent, failed, gone} dict so callers can log
    aggregate health without iterating per-subscription results."""
    sent = failed = gone = 0
    for sub in list_subscriptions_for_uid(uid):
        ok, status = send_to_subscription(sub, payload, ttl_seconds=ttl_seconds)
        if ok:
            sent += 1
        elif status.startswith("gone_"):
            gone += 1
        else:
            failed += 1
    return {"sent": sent, "failed": failed, "gone": gone}


# ── Helpers exposed for the frontend ────────────────────────────────

def public_key_b64url() -> str:
    """The browser needs the VAPID public key as a base64url string
    (no padding) when calling `pushManager.subscribe`. Keys are
    generally already stored in that form, but if a deploy used hex
    or standard base64 we coerce to the canonical shape."""
    raw = get_vapid_config().public_key
    if not raw:
        return ""
    # Hex (most py_vapid output) → base64url
    if all(c in "0123456789abcdefABCDEF" for c in raw) and len(raw) >= 64:
        try:
            return base64.urlsafe_b64encode(bytes.fromhex(raw)).rstrip(b"=").decode("ascii")
        except ValueError:
            pass
    # Standard base64 with padding → strip padding, convert chars
    return raw.replace("+", "-").replace("/", "_").rstrip("=")
