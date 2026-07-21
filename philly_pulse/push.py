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
import ipaddress
import logging
import math
import os
import re
import secrets
import socket
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlparse

from google.cloud.firestore_v1.base_query import FieldFilter

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


_DELIVERY_CLAIM_LOCKS = tuple(threading.Lock() for _ in range(128))


def _delivery_claim_lock(collection_name: str, document_id: str) -> threading.Lock:
    digest = hashlib.sha256(
        f"{collection_name}\0{document_id}".encode("utf-8")
    ).digest()
    return _DELIVERY_CLAIM_LOCKS[
        int.from_bytes(digest[:4], "big") % len(_DELIVERY_CLAIM_LOCKS)
    ]


@dataclass
class PushSubscription:
    """Mirrors the W3C PushSubscription.toJSON() shape we accept from
    the browser, plus a `uid` so we know who to notify, an optional
    `userAgent` for debugging, and an optional alert area for
    proximity-based triggers.

    The alert area is opt-in: when `notify_lat`/`notify_lng` are
    present, the user wants closed-tab pings for nearby high-severity
    scanner incidents. When absent (default), the subscription only
    receives pushes the user explicitly opts into (e.g. test pings,
    direct-to-uid messages).

    `notify_radius_km` defaults to 3 km — small enough to feel like
    "my neighborhood" rather than "anywhere in the city," large
    enough to catch incidents on the user's regular walking radius.
    Capped on read so a malformed value can't accidentally turn a
    subscription into a global firehose."""
    endpoint: str
    p256dh: str
    auth: str
    uid: str
    user_agent: str = ""
    city: str = ""
    notify_lat: Optional[float] = None
    notify_lng: Optional[float] = None
    notify_radius_km: float = 3.0
    # Newsroom alerts: opt-in, city-wide pings for newsworthy incidents
    # (serious categories above a severity bar). For reporters who want a
    # heads-up without watching the desk. Independent of the proximity area.
    notify_newsroom: bool = False
    # Also deliver newsroom alerts to this email (SES). `email` comes from the
    # verified Firebase token, not the client body.
    notify_newsroom_email: bool = False
    email: str = ""
    created_at_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    last_used_ms: int = 0


def derive_subscription_hash(endpoint: str) -> str:
    """Stable, URL-safe doc id for a given endpoint URL.

    SHA-256 keeps it fixed-length even for the very long FCM/Mozilla
    endpoint URLs and avoids reserved characters in Firestore doc
    ids. We don't truncate — the marginal cost of 64 chars is
    nothing compared to the headache of a hash collision."""
    return hashlib.sha256(endpoint.encode("utf-8")).hexdigest()


def is_safe_push_endpoint(endpoint: str, *, resolve_dns: bool = True) -> bool:
    """Accept HTTPS push-service URLs that cannot resolve to local networks.

    Rechecking at send time matters because stored endpoints are long-lived and
    DNS can change after registration. This keeps Web Push from becoming SSRF.
    """
    if not isinstance(endpoint, str) or not endpoint or len(endpoint) > 2048:
        return False
    try:
        parsed = urlparse(endpoint)
        if (
            parsed.scheme.lower() != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port not in (None, 443)
        ):
            return False
        hostname = parsed.hostname.rstrip(".").lower()
        if hostname == "localhost" or hostname.endswith((".localhost", ".local", ".internal")):
            return False

        try:
            literal = ipaddress.ip_address(hostname)
        except ValueError:
            literal = None
        if literal is not None:
            return literal.is_global
        if not resolve_dns:
            return True

        addresses = {
            row[4][0]
            for row in socket.getaddrinfo(hostname, 443, type=socket.SOCK_STREAM)
        }
        return bool(addresses) and all(ipaddress.ip_address(addr).is_global for addr in addresses)
    except (OSError, TypeError, ValueError):
        return False


# Hard cap on alert radius. A 50 km bubble around a single phone
# would defeat the "nearby" framing; we clamp anything over this
# down. Below 0.1 km we treat as "no area" since GPS jitter alone
# overwhelms the signal at that scale.
_MAX_ALERT_RADIUS_KM = 25.0
_MIN_ALERT_RADIUS_KM = 0.1


def upsert_subscription(sub: PushSubscription) -> str:
    """Idempotent upsert that preserves server-owned delivery cooldowns."""
    from firebase_admin import firestore

    doc_id = derive_subscription_hash(sub.endpoint)

    # Validate + clamp the alert area. We accept the subscription
    # even if the area is malformed — drop it silently and the user
    # just doesn't get nearby pings until they re-set it.
    notify_lat: Optional[float] = None
    notify_lng: Optional[float] = None
    radius = max(_MIN_ALERT_RADIUS_KM, min(_MAX_ALERT_RADIUS_KM, sub.notify_radius_km or 3.0))
    if (
        sub.notify_lat is not None
        and sub.notify_lng is not None
        and -90.0 <= sub.notify_lat <= 90.0
        and -180.0 <= sub.notify_lng <= 180.0
    ):
        notify_lat = float(sub.notify_lat)
        notify_lng = float(sub.notify_lng)

    payload = {
        "endpoint": sub.endpoint,
        # The two crypto material fields the browser hands back.
        # Stored as the original base64url strings so pywebpush gets
        # them in exactly the format it expects.
        "p256dh": sub.p256dh,
        "auth": sub.auth,
        "uid": sub.uid,
        "userAgent": sub.user_agent or "",
        "city": sub.city or "",
        "notifyLat": notify_lat,
        "notifyLng": notify_lng,
        "notifyRadiusKm": radius,
        "notifyNewsroom": bool(sub.notify_newsroom),
        "notifyNewsroomEmail": bool(sub.notify_newsroom_email),
        "email": (sub.email or "")[:320],
    }
    db = _db()
    ref = db.collection("pushSubscriptions").document(doc_id)
    transaction = db.transaction(max_attempts=20)

    @firestore.transactional
    def upsert_in_transaction(txn):
        snap = ref.get(transaction=txn)
        if snap.exists:
            # Merge client registration fields without resetting cooldowns,
            # in-flight leases, or the original registration timestamp.
            txn.set(ref, payload, merge=True)
        else:
            txn.set(
                ref,
                {
                    **payload,
                    "createdAtMs": sub.created_at_ms,
                    "lastUsedMs": sub.last_used_ms,
                    "lastNearbyPushMs": 0,
                    "lastNewsroomPushMs": 0,
                },
            )

    with _delivery_claim_lock("pushSubscriptions", doc_id):
        upsert_in_transaction(transaction)
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
    docs = (
        _db()
        .collection("pushSubscriptions")
        .where(filter=FieldFilter("uid", "==", uid))
        .stream()
    )
    return [{"id": d.id, **(d.to_dict() or {})} for d in docs]


def revoke_subscription_by_id(sub_id: str, expected_uid: str) -> str:
    """Owner-scoped revoke by Firestore doc id.

    Returns one of:
      - "ok"           – deleted
      - "not_found"    – doc doesn't exist
      - "forbidden"    – doc exists but `uid` doesn't match caller

    The caller-uid check is done here (rather than only in the
    Firestore security rules) so the API endpoint can return a 403
    instead of letting a server-side write fail with a less
    actionable error."""
    ref = _db().collection("pushSubscriptions").document(sub_id)
    snap = ref.get()
    if not snap.exists:
        return "not_found"
    data = snap.to_dict() or {}
    if data.get("uid") != expected_uid:
        return "forbidden"
    ref.delete()
    return "ok"


def list_all_subscriptions(city: Optional[str] = None) -> list[dict[str, Any]]:
    """City filter is optional so single-city deployments don't pay the
    indexing cost; pass None to push to every subscriber regardless of
    pulse city. Useful for global maintenance pings."""
    q = _db().collection("pushSubscriptions")
    if city:
        q = q.where(filter=FieldFilter("city", "==", city))
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
    if not is_safe_push_endpoint(endpoint, resolve_dns=True):
        logger.warning("Refusing unsafe push endpoint for subscription %s", sub_doc.get("id", ""))
        return False, "unsafe_endpoint"
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


def _claim_delivery_cooldown(
    collection_name: str,
    document_id: str,
    *,
    last_field: str,
    claim_prefix: str,
    now_ms: int,
    cooldown_ms: int,
) -> str | None:
    """Atomically lease a cooldown slot before an irreversible send."""
    from firebase_admin import firestore

    db = _db()
    ref = db.collection(collection_name).document(document_id)
    token = secrets.token_urlsafe(18)
    token_field = f"{claim_prefix}ClaimToken"
    until_field = f"{claim_prefix}ClaimUntilMs"
    transaction = db.transaction(max_attempts=20)

    @firestore.transactional
    def claim_in_transaction(txn):
        snap = ref.get(transaction=txn)
        if not snap.exists:
            return None
        data = snap.to_dict() or {}
        try:
            last_ms = int(data.get(last_field) or 0)
        except (TypeError, ValueError):
            last_ms = 0
        if now_ms - last_ms < cooldown_ms:
            return None
        try:
            claim_until = int(data.get(until_field) or 0)
        except (TypeError, ValueError):
            claim_until = 0
        if claim_until > now_ms:
            return None
        txn.update(
            ref,
            {
                token_field: token,
                # If final bookkeeping fails after a successful external send,
                # keep suppressing retries for the full cooldown window.
                until_field: now_ms + cooldown_ms,
            },
        )
        return token

    with _delivery_claim_lock(collection_name, document_id):
        return claim_in_transaction(transaction)


def _finish_delivery_cooldown(
    collection_name: str,
    document_id: str,
    *,
    last_field: str,
    claim_prefix: str,
    now_ms: int,
    claim_token: str,
    extra_fields: dict[str, Any] | None = None,
) -> bool:
    """Finalize a delivery only while this sender still owns its lease."""
    from firebase_admin import firestore

    db = _db()
    ref = db.collection(collection_name).document(document_id)
    token_field = f"{claim_prefix}ClaimToken"
    until_field = f"{claim_prefix}ClaimUntilMs"
    transaction = db.transaction(max_attempts=20)

    @firestore.transactional
    def finish_in_transaction(txn):
        snap = ref.get(transaction=txn)
        if not snap.exists:
            return False
        data = snap.to_dict() or {}
        if data.get(token_field) != claim_token:
            return False
        updates = {
            last_field: now_ms,
            token_field: firestore.DELETE_FIELD,
            until_field: firestore.DELETE_FIELD,
        }
        if extra_fields:
            updates.update(extra_fields)
        txn.update(ref, updates)
        return True

    return bool(finish_in_transaction(transaction))


def _release_delivery_claim(
    collection_name: str,
    document_id: str,
    *,
    claim_prefix: str,
    claim_token: str,
) -> bool:
    """Release a failed send without clearing another worker's lease."""
    from firebase_admin import firestore

    db = _db()
    ref = db.collection(collection_name).document(document_id)
    token_field = f"{claim_prefix}ClaimToken"
    until_field = f"{claim_prefix}ClaimUntilMs"
    transaction = db.transaction(max_attempts=20)

    @firestore.transactional
    def release_in_transaction(txn):
        snap = ref.get(transaction=txn)
        if not snap.exists:
            return False
        data = snap.to_dict() or {}
        if data.get(token_field) != claim_token:
            return False
        txn.update(
            ref,
            {
                token_field: firestore.DELETE_FIELD,
                until_field: firestore.DELETE_FIELD,
            },
        )
        return True

    return bool(release_in_transaction(transaction))


# ── Helpers exposed for the frontend ────────────────────────────────

# ── Proximity-based fan-out ─────────────────────────────────────────

# Earth radius in km for the haversine. We compute distance per
# candidate subscription rather than relying on Firestore geoqueries
# because the subscription set per city is small (tens to hundreds)
# and a Python-side filter is way simpler than maintaining geohash
# indexes for what is effectively a "ping nearby phones" rule.
_EARTH_KM = 6371.0088

# Minimum gap between nearby-incident pushes to a single subscription.
# Also the dedupe window: if two incidents land within this span, the
# second one will be suppressed. 5 minutes is the middle ground —
# long enough to avoid spamming a phone during a multi-incident event
# (e.g. a multi-vehicle MVA generating three transcripts), short
# enough that a separate incident an hour later still gets through.
_NEARBY_COOLDOWN_MS = 5 * 60 * 1000

# Severity gate: only s_base values at or above this trigger a
# closed-tab push. Lower-severity categories (medical assist, minor
# disorder) would create push fatigue. The threshold matches the
# frontend's "high-severity" visual bucket so the user's mental
# model is consistent across in-app and OS notifications.
_NEARBY_S_BASE_FLOOR = 0.7

# Skip incidents the inhibitor flagged as blocked or that geocoded
# below this confidence. Pushing low-confidence locations would
# direct users to the wrong block.
_NEARBY_MIN_LOCATION_CONFIDENCE = ("high", "medium")


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    import math
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = rlat2 - rlat1
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlng / 2) ** 2
    return 2 * _EARTH_KM * math.asin(math.sqrt(a))


def find_nearby_subscriptions(
    city: str, lat: float, lng: float
) -> list[dict[str, Any]]:
    """Return subscriptions in the city whose alert area contains the
    given point. We over-fetch (city scope) and filter in Python; see
    the docstring above on `_EARTH_KM` for why we don't bother with
    geohash indexes here."""
    out: list[dict[str, Any]] = []
    for sub in list_all_subscriptions(city=city):
        try:
            nlat = float(sub.get("notifyLat"))
            nlng = float(sub.get("notifyLng"))
            radius = float(sub.get("notifyRadiusKm") or 0.0)
        except (TypeError, ValueError):
            continue
        if (
            not math.isfinite(nlat)
            or not math.isfinite(nlng)
            or not math.isfinite(radius)
            or not (-90 <= nlat <= 90)
            or not (-180 <= nlng <= 180)
            or radius <= 0
            or radius > _MAX_ALERT_RADIUS_KM
        ):
            continue
        # Cheap bounding-box prefilter so we don't haversine for
        # subscriptions that obviously can't match. Latitude degrees
        # are ~111 km apart; longitude is latitude-dependent but at
        # mid-latitudes the same approximation is conservative
        # enough for a prefilter.
        max_deg = (radius / 111.0) * 1.5
        if abs(nlat - lat) > max_deg:
            continue
        if abs(nlng - lng) > max_deg:
            continue
        if _haversine_km(nlat, nlng, lat, lng) <= radius:
            out.append(sub)
    return out


# ── Newsroom alerts ──────────────────────────────────────────────────
# City-wide pings for newsworthy incidents (for reporters / the Newsroom).
# Looser than the proximity trigger (no location area) but gated to genuinely
# newsworthy categories above a severity bar — a backend stand-in for the
# frontend newsworthiness score — so reporters get signal, not a firehose.
_NEWSROOM_COOLDOWN_MS = 3 * 60 * 1000
_NEWSROOM_S_BASE_FLOOR = 0.5
_NEWSWORTHY_CATEGORIES = {
    "violent_weapon",
    "violent_no_weapon",
    "shots_heard",
    "robbery",
    "burglary_in_progress",
    "fire_hazmat",
    "traffic_crash_injury",
}


def find_newsroom_subscriptions(city: str) -> list[dict[str, Any]]:
    """Subscriptions in the city opted into newsroom alerts."""
    return [s for s in list_all_subscriptions(city=city) if s.get("notifyNewsroom") is True]


def notify_newsroom_incident(
    *,
    incident_id: str,
    city: str,
    severity_category: str,
    s_base: float,
    description: Optional[str] = None,
    location_text: Optional[str] = None,
    inhibitor_status: Optional[str] = None,
) -> dict[str, int]:
    """Push newsworthy incidents to reporters opted into newsroom alerts.

    Gated to serious categories above a severity bar, with a per-subscription
    cooldown and the user's snooze/quiet/mute prefs respected. Mirrors
    notify_nearby_incident but is city-wide rather than area-based."""
    push_enabled = push_available()
    if inhibitor_status == "blocked":
        return {"sent": 0, "blocked": 1, "matched": 0}
    if s_base < _NEWSROOM_S_BASE_FLOOR or severity_category not in _NEWSWORTHY_CATEGORIES:
        return {"sent": 0, "not_newsworthy": 1, "matched": 0}

    matches = find_newsroom_subscriptions(city)
    if not matches:
        return {"sent": 0, "matched": 0}

    now_ms = int(time.time() * 1000)
    sent = failed = cooldown = quiet = snoozed = muted = emailed = email_failed = not_pro = 0
    skipped_no_push = bookkeeping_failed = 0
    label = severity_category.replace("_", " ").title()
    summary = (description or location_text or "Tap for details.").strip()
    if len(summary) > 120:
        summary = summary[:117] + "..."
    payload = {
        "kind": "newsroom_incident",
        "incidentId": incident_id,
        "title": f"Newsworthy: {label}",
        "body": summary,
        "url": f"/?incident={incident_id}",
        "tag": f"pp:newsroom:{city}",
        "requireInteraction": False,
        "severity_category": severity_category,
    }

    # One deterministic subscription owns each address's email delivery. This
    # prevents multiple devices on the same account from sending duplicate
    # emails, and the owner's transactional lease also covers concurrent jobs.
    email_owner_by_address: dict[str, str] = {}
    for candidate in sorted(matches, key=lambda item: str(item.get("id") or "")):
        if not candidate.get("notifyNewsroomEmail"):
            continue
        address = str(candidate.get("email") or "").strip().lower()
        candidate_id = str(candidate.get("id") or "")
        if address and candidate_id:
            email_owner_by_address.setdefault(address, candidate_id)

    seen_uids: dict[str, dict[str, bool]] = {}
    tier_by_uid: dict[str, str] = {}
    for sub in matches:
        try:
            last_ms = int(sub.get("lastNewsroomPushMs") or 0)
        except (TypeError, ValueError):
            last_ms = 0
        if now_ms - last_ms < _NEWSROOM_COOLDOWN_MS:
            cooldown += 1
            continue
        uid = str(sub.get("uid") or "")
        if not uid:
            not_pro += 1
            continue
        tier = tier_by_uid.get(uid)
        if tier is None:
            tier = _user_tier_for_push(uid)
            tier_by_uid[uid] = tier
        if tier not in ("pro", "enterprise"):
            not_pro += 1
            continue
        if uid:
            cached = seen_uids.get(uid)
            if cached is None:
                cached = {
                    "snoozed": _is_snoozed_for_uid(uid),
                    "quiet": _is_quiet_now_for_uid(uid, None),
                    "muted": _is_category_muted_for_uid(uid, severity_category),
                }
                seen_uids[uid] = cached
            if cached["snoozed"]:
                snoozed += 1
                continue
            if cached["quiet"]:
                quiet += 1
                continue
            if cached["muted"]:
                muted += 1
                continue
        sub_id = str(sub.get("id") or "")
        addr = str(sub.get("email") or "").strip().lower()
        should_email = bool(
            sub.get("notifyNewsroomEmail")
            and addr
            and email_owner_by_address.get(addr) == sub_id
        )
        if not push_enabled and not should_email:
            skipped_no_push += 1
            continue
        try:
            claim_token = _claim_delivery_cooldown(
                "pushSubscriptions",
                sub_id,
                last_field="lastNewsroomPushMs",
                claim_prefix="newsroom",
                now_ms=now_ms,
                cooldown_ms=_NEWSROOM_COOLDOWN_MS,
            )
        except Exception as e:
            logger.warning("newsroom claim failed for %s: %s", sub_id, e)
            bookkeeping_failed += 1
            continue
        if claim_token is None:
            cooldown += 1
            continue

        push_ok = False
        if push_enabled:
            push_ok, _status = send_to_subscription(
                sub, payload, ttl_seconds=30 * 60
            )
            if push_ok:
                sent += 1
            else:
                failed += 1

        email_ok = False
        if should_email:
            try:
                from . import ses_email

                domain = ses_email.CITY_SEND_DOMAINS.get(city, "423pulse.com")
                text = (
                    f"{summary}\n\n"
                    f"View the incident: https://{domain}/?incident={incident_id}\n\n"
                    f"You're receiving this because you turned on Newsroom email alerts. "
                    f"Manage or turn these off anytime in the CityPulse app."
                )
                email_ok = bool(
                    ses_email.send_email(
                        to=addr,
                        subject=f"Newsworthy: {label}",
                        text=text,
                        from_email=ses_email.from_email_for_city(city),
                    )
                )
                if email_ok:
                    emailed += 1
                else:
                    email_failed += 1
            except Exception as e:  # pragma: no cover — best effort
                email_failed += 1
                logger.warning("newsroom email failed for %s: %s", addr, e)

        try:
            if push_ok or email_ok:
                finalized = _finish_delivery_cooldown(
                    "pushSubscriptions",
                    sub_id,
                    last_field="lastNewsroomPushMs",
                    claim_prefix="newsroom",
                    now_ms=now_ms,
                    claim_token=claim_token,
                )
            else:
                finalized = _release_delivery_claim(
                    "pushSubscriptions",
                    sub_id,
                    claim_prefix="newsroom",
                    claim_token=claim_token,
                )
            if not finalized:
                bookkeeping_failed += 1
        except Exception as e:
            bookkeeping_failed += 1
            logger.warning("newsroom claim finalization failed for %s: %s", sub_id, e)
    return {
        "sent": sent,
        "failed": failed,
        "matched": len(matches),
        "cooldown": cooldown,
        "quiet": quiet,
        "snoozed": snoozed,
        "muted": muted,
        "emailed": emailed,
        "email_failed": email_failed,
        "not_pro": not_pro,
        "skipped_no_push": skipped_no_push,
        "bookkeeping_failed": bookkeeping_failed,
    }


def notify_nearby_incident(
    *,
    incident_id: str,
    city: str,
    lat: float,
    lng: float,
    severity_category: str,
    s_base: float,
    location_text: Optional[str] = None,
    location_confidence: Optional[str] = None,
    inhibitor_status: Optional[str] = None,
) -> dict[str, int]:
    """Server-side trigger: push to every subscription whose alert
    area contains the incident location, subject to severity floor,
    confidence floor, inhibitor status, and per-subscription cooldown.

    Returns aggregate counters so the caller can log per-incident
    delivery health without iterating per-subscription results."""
    if not push_available():
        return {"sent": 0, "skipped_no_push": 1, "matched": 0, "cooldown": 0}
    if s_base < _NEARBY_S_BASE_FLOOR:
        return {"sent": 0, "below_severity": 1, "matched": 0, "cooldown": 0}
    if inhibitor_status and inhibitor_status == "blocked":
        return {"sent": 0, "blocked": 1, "matched": 0, "cooldown": 0}
    if location_confidence and location_confidence not in _NEARBY_MIN_LOCATION_CONFIDENCE:
        return {"sent": 0, "low_confidence": 1, "matched": 0, "cooldown": 0}

    matches = find_nearby_subscriptions(city, lat, lng)
    if not matches:
        return {"sent": 0, "matched": 0, "cooldown": 0}

    now_ms = int(time.time() * 1000)
    sent = failed = cooldown = quiet = snoozed = muted = bookkeeping_failed = 0
    label = severity_category.replace("_", " ").title()
    where = location_text or f"{lat:.4f}, {lng:.4f}"
    payload = {
        "kind": "nearby_incident",
        "incidentId": incident_id,
        "title": f"{label} reported nearby",
        "body": f"Near {where}. Tap for details.",
        # Drives the SW's notificationclick deep-link.
        "url": f"/?incident={incident_id}",
        # Same `tag` so a stream of nearby pings collapses rather
        # than stacking — last-write-wins matches user expectations.
        "tag": f"pp:nearby:{city}",
        "requireInteraction": False,
        "severity_category": severity_category,
    }

    # Memoize per-uid pref lookups within this fan-out so two devices
    # owned by the same user only cost one Firestore read.
    seen_uids: dict[str, dict[str, bool]] = {}

    for sub in matches:
        try:
            last_ms = int(sub.get("lastNearbyPushMs") or 0)
        except (TypeError, ValueError):
            last_ms = 0
        if now_ms - last_ms < _NEARBY_COOLDOWN_MS:
            cooldown += 1
            continue

        # Server-side respect for the prefs the user already set in
        # the app. Anonymous subscriptions (no uid) skip the lookups
        # — they have no synced prefs to honor.
        uid = str(sub.get("uid") or "")
        if uid:
            cached = seen_uids.get(uid)
            if cached is None:
                cached = {
                    "snoozed": _is_snoozed_for_uid(uid),
                    "quiet": _is_quiet_now_for_uid(uid, None),
                    "muted": _is_category_muted_for_uid(uid, severity_category),
                }
                seen_uids[uid] = cached
            if cached["snoozed"]:
                snoozed += 1
                continue
            if cached["quiet"]:
                quiet += 1
                continue
            if cached["muted"]:
                muted += 1
                continue

        sub_id = str(sub.get("id") or "")
        try:
            claim_token = _claim_delivery_cooldown(
                "pushSubscriptions",
                sub_id,
                last_field="lastNearbyPushMs",
                claim_prefix="nearby",
                now_ms=now_ms,
                cooldown_ms=_NEARBY_COOLDOWN_MS,
            )
        except Exception as e:
            logger.warning("nearby claim failed for %s: %s", sub_id, e)
            bookkeeping_failed += 1
            continue
        if claim_token is None:
            cooldown += 1
            continue

        ok, _status = send_to_subscription(sub, payload, ttl_seconds=15 * 60)
        if ok:
            sent += 1
            try:
                if not _finish_delivery_cooldown(
                    "pushSubscriptions",
                    sub_id,
                    last_field="lastNearbyPushMs",
                    claim_prefix="nearby",
                    now_ms=now_ms,
                    claim_token=claim_token,
                ):
                    bookkeeping_failed += 1
            except Exception as e:
                bookkeeping_failed += 1
                logger.warning("nearby claim finalization failed for %s: %s", sub_id, e)
        else:
            failed += 1
            try:
                if not _release_delivery_claim(
                    "pushSubscriptions",
                    sub_id,
                    claim_prefix="nearby",
                    claim_token=claim_token,
                ):
                    bookkeeping_failed += 1
            except Exception as e:
                bookkeeping_failed += 1
                logger.warning(
                    "nearby claim release failed for %s: %s", sub_id, e
                )
    return {
        "sent": sent,
        "failed": failed,
        "matched": len(matches),
        "cooldown": cooldown,
        "quiet": quiet,
        "snoozed": snoozed,
        "muted": muted,
        "bookkeeping_failed": bookkeeping_failed,
    }


# ── User preference gating (server-side respect for client prefs) ───

# All synced prefs live under users/{uid}/userPrefs/v1, mirrored
# from localStorage by frontend/src/lib/prefs-sync.ts. The values
# are JSON-encoded strings (e.g. quietHours stored as the JSON
# representation of a {enabled,startHour,...} object) — same shape
# the client reads. We treat the client format as authoritative and
# only need to *interpret* it here, never write it.

_PREFS_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_PREFS_CACHE_LOCK = threading.Lock()
_PREFS_CACHE_MAX = 2048
# 60s cache so a burst of nearby alerts doesn't hammer Firestore
# with prefs lookups for the same uid. The cost of being slightly
# stale (a user toggles snooze on and the next push 30s later
# still goes through) is far smaller than the cost of fetching
# the same doc 50× in a fan-out window.
_PREFS_CACHE_TTL_S = 60


def _load_user_prefs(uid: str) -> dict[str, Any] | None:
    """Read the synced prefs doc for `uid`, with a tiny TTL cache.

    Returns the raw `values` map (key → JSON-encoded string), or None when
    Firestore is unavailable. Notification gating fails closed on None so a
    datastore outage can never violate a user's quiet-hours/snooze choices."""
    now = time.time()
    with _PREFS_CACHE_LOCK:
        cached = _PREFS_CACHE.get(uid)
    if cached and now - cached[0] < _PREFS_CACHE_TTL_S:
        return cached[1]
    values: dict[str, Any] = {}
    try:
        snap = (
            _db()
            .collection("users")
            .document(uid)
            .collection("userPrefs")
            .document("v1")
            .get()
        )
        if snap.exists:
            data = snap.to_dict() or {}
            v = data.get("values")
            if isinstance(v, dict):
                values = v
    except Exception as e:
        logger.warning("prefs lookup failed for %s: %s", uid, e)
        return None
    with _PREFS_CACHE_LOCK:
        for stale_uid in [
            key
            for key, value in _PREFS_CACHE.items()
            if now - value[0] >= _PREFS_CACHE_TTL_S
        ]:
            _PREFS_CACHE.pop(stale_uid, None)
        if uid not in _PREFS_CACHE and len(_PREFS_CACHE) >= _PREFS_CACHE_MAX:
            oldest_uid = min(_PREFS_CACHE, key=lambda key: _PREFS_CACHE[key][0])
            _PREFS_CACHE.pop(oldest_uid, None)
        _PREFS_CACHE[uid] = (now, values)
    return values


def _parse_json_pref(raw: Any) -> Any:
    """Synced prefs are stored as JSON-encoded strings. Returns the
    parsed value, or None if it's missing/malformed — every caller
    treats None as "use default"."""
    if not isinstance(raw, str) or not raw:
        return None
    try:
        import json as _json
        return _json.loads(raw)
    except Exception:
        return None


def _is_quiet_now_for_uid(uid: str, tz_name: Optional[str]) -> bool:
    """Mirror of frontend `isQuietNow`. Wraps midnight cleanly so a
    22:00→07:00 window catches both 23:30 and 02:30."""
    prefs = _load_user_prefs(uid)
    if prefs is None:
        return True
    raw = prefs.get("pp:quiet-hours")
    if raw is None:
        return False
    cfg = _parse_json_pref(raw)
    if cfg is None:
        return True
    if not isinstance(cfg, dict) or not cfg.get("enabled"):
        return False
    try:
        if tz_name:
            from zoneinfo import ZoneInfo
            now = datetime.now(ZoneInfo(tz_name))
        else:
            now = datetime.now()
    except Exception:
        now = datetime.now()
    cur = now.hour * 60 + now.minute
    try:
        sh = int(cfg.get("startHour") or 0)
        sm = int(cfg.get("startMinute") or 0)
        eh = int(cfg.get("endHour") or 0)
        em = int(cfg.get("endMinute") or 0)
    except (TypeError, ValueError):
        return True
    if not (0 <= sh <= 23 and 0 <= eh <= 23 and 0 <= sm <= 59 and 0 <= em <= 59):
        return True
    start = sh * 60 + sm
    end = eh * 60 + em
    if start == end:
        return False
    if start < end:
        return start <= cur < end
    return cur >= start or cur < end


def _is_snoozed_for_uid(uid: str) -> bool:
    """Push snooze is a single epoch-ms 'until' timestamp; we treat
    any value strictly greater than now as an active snooze. The
    pref itself is owned by the user (set/cleared from PushSettings)
    and rides through prefs-sync just like quiet hours."""
    prefs = _load_user_prefs(uid)
    if prefs is None:
        return True
    raw = prefs.get("pp:push-snooze-until")
    if raw is None:
        return False
    if not isinstance(raw, str) or not raw:
        return True
    try:
        until_ms = int(raw)
    except Exception:
        return True
    return until_ms > int(time.time() * 1000)


def _is_category_muted_for_uid(uid: str, category: str) -> bool:
    """Mirrors `lib/alert-mutes.ts`: the muted set is stored as a
    JSON array of category strings. Push-side we apply this only
    to nearby-incident pushes — commute pushes are user-scoped
    and don't have a category in the same sense."""
    if not category:
        return False
    prefs = _load_user_prefs(uid)
    if prefs is None:
        return True
    encoded = prefs.get("pp:muted-categories")
    if encoded is None:
        return False
    raw = _parse_json_pref(encoded)
    if raw is None:
        return True
    if not isinstance(raw, list) or any(not isinstance(item, str) for item in raw):
        return True
    return category in raw


def invalidate_prefs_cache(uid: str) -> None:
    """Drop the cached prefs entry for a uid. Call after any server-
    side write that should be visible to the next push fan-out
    (currently unused — kept available for future prefs APIs)."""
    with _PREFS_CACHE_LOCK:
        _PREFS_CACHE.pop(uid, None)


# ── Keyword scanner watches ─────────────────────────────────────────
#
# Pro users can register arbitrary keyword watches ("shooting",
# "Temple", "north philly") that fire whenever a transcript matches.
# This is independent of severity/category gating because the value
# prop is "tell me literally any time my keyword shows up." We still
# enforce per-watch cooldowns and per-uid rate limits so a single
# overly-broad watch (e.g. "police") doesn't drown the user.

_KEYWORD_COOLDOWN_MS = 90 * 1000  # per-watch min gap, lighter than nearby pushes


def _normalize_keyword(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def _keyword_matches(text_lower: str, kw_lower: str) -> bool:
    """Substring match by default; if the watch wraps the keyword in
    double-quotes (e.g. `"shots fired"`), treat it as an exact phrase
    and require word boundaries so `"car"` doesn't fire on `cargo`."""
    if not kw_lower:
        return False
    if kw_lower.startswith('"') and kw_lower.endswith('"') and len(kw_lower) >= 3:
        phrase = kw_lower[1:-1]
        return re.search(rf"\b{re.escape(phrase)}\b", text_lower) is not None
    return kw_lower in text_lower


def list_keyword_watches_for_uid(uid: str) -> list[dict[str, Any]]:
    docs = (
        _db()
        .collection("keywordWatches")
        .where(filter=FieldFilter("uid", "==", uid))
        .stream()
    )
    return [{"id": d.id, **(d.to_dict() or {})} for d in docs]


def list_active_keyword_watches(city: str) -> list[dict[str, Any]]:
    """Return active watches scoped to `city` plus any watches whose
    `city` is empty (treated as "all cities the user has access to").

    Two queries because Firestore can't OR equality+empty in a single
    where; the union is small enough that we de-dupe in Python."""
    out: dict[str, dict[str, Any]] = {}
    try:
        for d in (
            _db()
            .collection("keywordWatches")
            .where(filter=FieldFilter("active", "==", True))
            .where(filter=FieldFilter("city", "==", city))
            .stream()
        ):
            out[d.id] = {"id": d.id, **(d.to_dict() or {})}
        for d in (
            _db()
            .collection("keywordWatches")
            .where(filter=FieldFilter("active", "==", True))
            .where(filter=FieldFilter("city", "==", ""))
            .stream()
        ):
            out[d.id] = {"id": d.id, **(d.to_dict() or {})}
    except Exception as e:
        logger.warning("list_active_keyword_watches failed: %s", e)
        raise
    return list(out.values())


def notify_keyword_watches(
    *,
    incident_id: str,
    city: str,
    raw_text: str,
    severity_category: str,
    s_base: float,
    location_text: Optional[str] = None,
) -> dict[str, int]:
    """Fan out to every active keyword watch whose keyword appears in
    the transcript. Skips on cooldown and on disabled subscriptions.

    Designed to be called on every ingest (both new incidents and
    follow-up mentions) — keyword watches are independent of the
    dedup pipeline because each new transmission has unique text
    that might newly match a watch."""
    if not push_available():
        return {"sent": 0, "matched": 0, "cooldown": 0, "skipped_no_push": 1}
    text = raw_text or ""
    if not text:
        return {"sent": 0, "matched": 0, "cooldown": 0}
    text_lower = text.lower()

    watches = list_active_keyword_watches(city)
    if not watches:
        return {"sent": 0, "matched": 0, "cooldown": 0}

    now_ms = int(time.time() * 1000)
    sent = failed = cooldown = below_floor = quiet = snoozed = not_pro = 0
    bookkeeping_failed = 0
    matched = 0
    tier_by_uid: dict[str, str] = {}

    for w in watches:
        kw = _normalize_keyword(str(w.get("keyword") or ""))
        if not _keyword_matches(text_lower, kw):
            continue
        matched += 1

        # Optional severity floor on the watch — useful for very
        # broad keywords (e.g. "north philly") that the user only
        # wants to hear about for serious incidents.
        try:
            floor = float(w.get("severityFloor") or 0.0)
        except (TypeError, ValueError):
            below_floor += 1
            continue
        if not math.isfinite(floor) or floor < 0 or floor > 1:
            below_floor += 1
            continue
        if s_base < floor:
            below_floor += 1
            continue

        try:
            last_ms = int(w.get("lastFiredMs") or 0)
        except (TypeError, ValueError):
            last_ms = 0
        if now_ms - last_ms < _KEYWORD_COOLDOWN_MS:
            cooldown += 1
            continue

        uid = str(w.get("uid") or "")
        if not uid:
            continue
        tier = tier_by_uid.get(uid)
        if tier is None:
            tier = _user_tier_for_push(uid)
            tier_by_uid[uid] = tier
        if tier not in ("pro", "enterprise"):
            not_pro += 1
            continue
        if _is_snoozed_for_uid(uid):
            snoozed += 1
            continue
        if _is_quiet_now_for_uid(uid, None):
            quiet += 1
            continue

        # Highlight the matched keyword in the body so the lock-screen
        # preview obviously answers "why am I getting this push?"
        snippet = (text[:140] + "…") if len(text) > 140 else text
        display_kw = kw.strip('"')
        label = (severity_category or "Scanner").replace("_", " ").title()
        title = f'"{display_kw}" mentioned on scanner'
        body_loc = f" near {location_text}" if location_text else ""
        body = f"{label}{body_loc}: {snippet}"
        payload = {
            "kind": "keyword_watch",
            "incidentId": incident_id,
            "watchId": w.get("id"),
            "keyword": display_kw,
            "title": title,
            "body": body,
            "tag": f"pp:keyword:{w.get('id')}",
            "url": f"/?incident={incident_id}",
            "requireInteraction": False,
            "severity_category": severity_category,
        }
        watch_id = str(w.get("id") or "")
        try:
            claim_token = _claim_delivery_cooldown(
                "keywordWatches",
                watch_id,
                last_field="lastFiredMs",
                claim_prefix="keyword",
                now_ms=now_ms,
                cooldown_ms=_KEYWORD_COOLDOWN_MS,
            )
        except Exception as e:
            logger.warning("keyword watch claim failed for %s: %s", watch_id, e)
            bookkeeping_failed += 1
            continue
        if claim_token is None:
            cooldown += 1
            continue

        result = send_to_uid(uid, payload, ttl_seconds=15 * 60)
        if result.get("sent", 0) > 0:
            sent += result["sent"]
            try:
                if not _finish_delivery_cooldown(
                    "keywordWatches",
                    watch_id,
                    last_field="lastFiredMs",
                    claim_prefix="keyword",
                    now_ms=now_ms,
                    claim_token=claim_token,
                    extra_fields={"lastIncidentId": incident_id},
                ):
                    bookkeeping_failed += 1
            except Exception as e:
                bookkeeping_failed += 1
                logger.warning(
                    "keyword watch claim finalization failed for %s: %s",
                    watch_id,
                    e,
                )
        else:
            failed += 1
            try:
                if not _release_delivery_claim(
                    "keywordWatches",
                    watch_id,
                    claim_prefix="keyword",
                    claim_token=claim_token,
                ):
                    bookkeeping_failed += 1
            except Exception as e:
                bookkeeping_failed += 1
                logger.warning(
                    "keyword watch claim release failed for %s: %s", watch_id, e
                )

    return {
        "sent": sent,
        "matched": matched,
        "failed": failed,
        "cooldown": cooldown,
        "below_floor": below_floor,
        "quiet": quiet,
        "snoozed": snoozed,
        "not_pro": not_pro,
        "bookkeeping_failed": bookkeeping_failed,
    }


# ── Commute schedule fan-out ────────────────────────────────────────

# Lead-time / cooldown matches the client-side `commute-notify.ts`
# constants so a user gets the same nudge whether the tab is open
# or fully closed: fire ~10 min before the typical departure, with
# a 12-minute window to absorb cron jitter, and never twice on the
# same calendar day per schedule.
_COMMUTE_LEAD_MIN = 10
_COMMUTE_FIRE_WINDOW_MIN = 12
_COMMUTE_MIN_CONFIDENCE = 0.5
_COMMUTE_MAX_AGE_DAYS = 60  # garbage-collect stale schedules
_COMMUTE_CLAIM_TTL_MS = 20 * 60 * 1000
_COMMUTE_STALE_CLEANUP_BATCH = 100


def _today_ymd_local(tz_name: Optional[str]) -> str:
    """Return today's YYYY-MM-DD in the schedule's local timezone, so
    `lastFiredYmd` rolls over at the user's midnight rather than UTC.
    Falls back to UTC if the timezone string is missing or invalid."""
    try:
        if tz_name:
            from zoneinfo import ZoneInfo
            return datetime.now(ZoneInfo(tz_name)).strftime("%Y-%m-%d")
    except Exception:
        pass
    return datetime.utcnow().strftime("%Y-%m-%d")


def _now_minute_in_tz(tz_name: Optional[str]) -> tuple[int, bool]:
    """Returns (minute_of_day, is_weekend) in the given timezone."""
    try:
        if tz_name:
            from zoneinfo import ZoneInfo
            now = datetime.now(ZoneInfo(tz_name))
        else:
            now = datetime.utcnow()
    except Exception:
        now = datetime.utcnow()
    minute = now.hour * 60 + now.minute
    weekday = now.weekday()  # Mon=0 … Sun=6
    is_weekend = weekday >= 5
    return minute, is_weekend


def _commute_in_fire_window(typical_min: int, now_min: int) -> bool:
    """Fire if "now" is between (typical − LEAD) and (typical − LEAD +
    FIRE_WINDOW). Wraps around midnight for late-night patterns."""
    minutes_until = typical_min - now_min
    if minutes_until > 720:
        minutes_until -= 1440
    elif minutes_until < -720:
        minutes_until += 1440
    return (
        _COMMUTE_LEAD_MIN - _COMMUTE_FIRE_WINDOW_MIN
        <= minutes_until
        <= _COMMUTE_LEAD_MIN
    )


_USER_TIER_CACHE: dict[str, tuple[float, str]] = {}
_USER_TIER_CACHE_LOCK = threading.Lock()
_USER_TIER_CACHE_MAX = 2048
_USER_TIER_CACHE_TTL_S = 60


def _entitlement_epoch(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    to_datetime = getattr(value, "to_datetime", None)
    if callable(to_datetime):
        try:
            return _entitlement_epoch(to_datetime())
        except Exception:
            return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        raw = float(value)
        if not math.isfinite(raw):
            return None
        return raw / 1000 if raw > 10_000_000_000 else raw
    return None


def _user_tier_for_push(uid: str) -> str:
    """Resolve permanent tier plus an active finite `proUntil` pass.

    Mirrors `server._user_tier`, kept local to avoid an import cycle
    (server.py imports from push.py during route registration). The short,
    bounded cache prevents one fan-out from rereading the same user document
    for every device/watch while never extending beyond a pass expiry."""
    now = time.time()
    with _USER_TIER_CACHE_LOCK:
        cached = _USER_TIER_CACHE.get(uid)
    if cached and cached[0] > now:
        return cached[1]

    tier = "free"
    expires_at = now + _USER_TIER_CACHE_TTL_S
    try:
        from .firestore_store import _ensure_client
        snap = _ensure_client().collection("users").document(uid).get()
        if snap.exists:
            data = snap.to_dict() or {}
            t = data.get("tier") or "free"
            if t in ("free", "pro", "enterprise"):
                tier = t
            pro_until = _entitlement_epoch(data.get("proUntil"))
            if pro_until is not None and pro_until > now:
                tier = "pro"
                expires_at = min(expires_at, pro_until)
    except Exception:
        tier = "free"

    with _USER_TIER_CACHE_LOCK:
        for stale_uid in [
            key for key, value in _USER_TIER_CACHE.items() if value[0] <= now
        ]:
            _USER_TIER_CACHE.pop(stale_uid, None)
        if uid not in _USER_TIER_CACHE and len(_USER_TIER_CACHE) >= _USER_TIER_CACHE_MAX:
            oldest_uid = min(_USER_TIER_CACHE, key=lambda key: _USER_TIER_CACHE[key][0])
            _USER_TIER_CACHE.pop(oldest_uid, None)
        _USER_TIER_CACHE[uid] = (expires_at, tier)
    return tier


def _user_tier_for_commute(uid: str) -> str:
    """Backward-compatible alias used by commute fan-out."""
    return _user_tier_for_push(uid)


def _claim_commute_fire(schedule_id: str, today: str, now_ms: int) -> str | None:
    """Lease one schedule's current fire window across workers/cron ticks."""
    from firebase_admin import firestore

    db = _db()
    ref = db.collection("commuteSchedules").document(schedule_id)
    token = secrets.token_urlsafe(18)
    transaction = db.transaction(max_attempts=20)

    @firestore.transactional
    def claim_in_transaction(txn):
        snap = ref.get(transaction=txn)
        if not snap.exists:
            return None
        data = snap.to_dict() or {}
        if data.get("lastFiredYmd") == today:
            return None
        try:
            claim_until = int(data.get("fireClaimUntilMs") or 0)
        except (TypeError, ValueError):
            claim_until = 0
        if data.get("fireClaimYmd") == today and claim_until > now_ms:
            return None
        txn.update(
            ref,
            {
                "fireClaimYmd": today,
                "fireClaimUntilMs": now_ms + _COMMUTE_CLAIM_TTL_MS,
                "fireClaimToken": token,
            },
        )
        return token

    with _delivery_claim_lock("commuteSchedules", schedule_id):
        return claim_in_transaction(transaction)


def _finish_commute_fire(
    schedule_id: str,
    today: str,
    now_ms: int,
    claim_token: str,
) -> bool:
    """Commit delivery only if this worker still owns the lease."""
    from firebase_admin import firestore

    db = _db()
    ref = db.collection("commuteSchedules").document(schedule_id)
    transaction = db.transaction(max_attempts=20)

    @firestore.transactional
    def finish_in_transaction(txn):
        snap = ref.get(transaction=txn)
        if not snap.exists:
            return False
        data = snap.to_dict() or {}
        if data.get("fireClaimToken") != claim_token:
            return False
        txn.update(
            ref,
            {
                "lastFiredYmd": today,
                "lastFiredAtMs": now_ms,
                "fireClaimYmd": firestore.DELETE_FIELD,
                "fireClaimUntilMs": firestore.DELETE_FIELD,
                "fireClaimToken": firestore.DELETE_FIELD,
            },
        )
        return True

    return bool(finish_in_transaction(transaction))


def _release_commute_claim(schedule_id: str, claim_token: str) -> bool:
    """Release a failed delivery without clearing a newer worker's lease."""
    from firebase_admin import firestore

    db = _db()
    ref = db.collection("commuteSchedules").document(schedule_id)
    transaction = db.transaction(max_attempts=20)

    @firestore.transactional
    def release_in_transaction(txn):
        snap = ref.get(transaction=txn)
        if not snap.exists:
            return False
        data = snap.to_dict() or {}
        if data.get("fireClaimToken") != claim_token:
            return False
        txn.update(
            ref,
            {
                "fireClaimYmd": firestore.DELETE_FIELD,
                "fireClaimUntilMs": firestore.DELETE_FIELD,
                "fireClaimToken": firestore.DELETE_FIELD,
            },
        )
        return True

    return bool(release_in_transaction(transaction))


def _delete_stale_commute_schedule(schedule_id: str, cutoff_ms: int) -> bool:
    """Delete only if the schedule is still stale at transaction time."""
    from firebase_admin import firestore

    db = _db()
    ref = db.collection("commuteSchedules").document(schedule_id)
    transaction = db.transaction(max_attempts=20)

    @firestore.transactional
    def delete_in_transaction(txn):
        snap = ref.get(transaction=txn)
        if not snap.exists:
            return False
        data = snap.to_dict() or {}
        try:
            updated_at = int(data.get("updatedAt") or 0)
        except (TypeError, ValueError):
            updated_at = 0
        if updated_at >= cutoff_ms:
            return False
        txn.delete(ref)
        return True

    return bool(delete_in_transaction(transaction))


def notify_due_commutes() -> dict[str, int]:
    """Scan `commuteSchedules` and push for every schedule whose
    typical departure window contains "now" (in the schedule's own
    timezone) and that hasn't already been pushed today.

    Designed to be called every 1-2 minutes by an external cron;
    the FIRE_WINDOW + lastFiredYmd combination tolerates cron
    drift up to ~10 min without double-firing or missing entries."""
    if not push_available():
        return {"scanned": 0, "fired": 0, "skipped": 0, "errors": 0}

    now_ms = int(time.time() * 1000)
    cutoff_ms = now_ms - _COMMUTE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
    try:
        collection = _db().collection("commuteSchedules")
        # Do not reread an ever-growing archive on every minute-level tick.
        # Stale rows are cleaned in a separate bounded batch below.
        snap = collection.where(
            filter=FieldFilter("updatedAt", ">=", cutoff_ms)
        ).stream()
        schedules = [{"id": d.id, **(d.to_dict() or {})} for d in snap]
    except Exception as e:
        logger.warning("notify_due_commutes: scan failed: %s", e)
        return {"scanned": 0, "fired": 0, "skipped": 0, "errors": 1}

    fired = skipped = errors = 0

    try:
        stale = (
            collection.where(filter=FieldFilter("updatedAt", "<", cutoff_ms))
            .limit(_COMMUTE_STALE_CLEANUP_BATCH)
            .stream()
        )
        for stale_doc in stale:
            try:
                _delete_stale_commute_schedule(stale_doc.id, cutoff_ms)
            except Exception as e:
                logger.warning("stale commute cleanup %s failed: %s", stale_doc.id, e)
                errors += 1
    except Exception as e:
        logger.warning("stale commute scan failed: %s", e)
        errors += 1

    for sch in schedules:
        try:
            confidence = float(sch.get("confidence") or 0)
            if not math.isfinite(confidence) or confidence < _COMMUTE_MIN_CONFIDENCE:
                skipped += 1
                continue

            tz_name = sch.get("tz") or None
            now_min, is_weekend_now = _now_minute_in_tz(tz_name)
            sched_is_weekend = bool(sch.get("isWeekend"))
            if sched_is_weekend != is_weekend_now:
                # A weekday schedule shouldn't fire on Saturday — and
                # vice versa. Skip silently; this is the common case
                # for a single user with both kinds of patterns.
                skipped += 1
                continue

            typical_min = int(sch.get("typicalDepartureMinute") or -1)
            if typical_min < 0 or typical_min >= 1440:
                skipped += 1
                continue
            if not _commute_in_fire_window(typical_min, now_min):
                skipped += 1
                continue

            today = _today_ymd_local(tz_name)
            if (sch.get("lastFiredYmd") or "") == today:
                skipped += 1
                continue

            uid = str(sch.get("uid") or "")
            if not uid:
                skipped += 1
                continue

            # Pro-tier gate: commute predictions are a Pro perk. We check
            # tier here (not at write time) so a downgrade silently stops
            # the pings without us having to chase the client through a
            # cleanup ritual. We DO NOT mark `lastFiredYmd` for skipped
            # tier checks — if the user upgrades mid-window the next
            # tick can fire normally without losing today's slot.
            if _user_tier_for_commute(uid) not in ("pro", "enterprise"):
                skipped += 1
                continue

            # Server-side prefs respect: snooze and quiet hours both
            # silence the commute push. Quiet hours uses the schedule
            # tz so a 10pm→7am quiet window correctly suppresses a
            # 6:45am wake-up commute prediction. We deliberately do
            # *not* mark these as `lastFiredYmd` — if the user wakes
            # up before the snooze ends, the next tick can re-fire.
            if _is_snoozed_for_uid(uid) or _is_quiet_now_for_uid(uid, tz_name):
                skipped += 1
                continue

            label = str(sch.get("destLabel") or "your destination")
            matched = sch.get("matchedCategory")
            title = (
                "Heading home soon?" if matched == "home"
                else "Heading to work soon?" if matched == "work"
                else f"Heading to {label} soon?"
            )
            duration = int(sch.get("typicalDurationMin") or 0)
            duration_text = f" · ~{duration}m" if duration > 0 else ""
            dep_hh = typical_min // 60
            dep_mm = typical_min % 60
            dep_text = f"{((dep_hh - 1) % 12) + 1}:{dep_mm:02d}"
            ampm = "AM" if dep_hh < 12 else "PM"

            payload = {
                "kind": "commute_predict",
                "scheduleId": sch["id"],
                "title": title,
                "body": f"You usually leave around {dep_text} {ampm}{duration_text}. Tap to plan a safe route.",
                "tag": f"pp:commute:{sch['id']}",
                "url": f"/?dest={sch.get('destLat')},{sch.get('destLng')}&plan=1",
                "requireInteraction": False,
            }

            claim_token = _claim_commute_fire(sch["id"], today, now_ms)
            if claim_token is None:
                skipped += 1
                continue
            result = send_to_uid(uid, payload, ttl_seconds=15 * 60)
            if result.get("sent", 0) > 0:
                fired += 1
                # Mark fired *only* if at least one device actually
                # received it; otherwise the next tick can retry.
                if not _finish_commute_fire(
                    sch["id"], today, now_ms, claim_token
                ):
                    # The lease outlives the 12-minute fire window, so even a
                    # bookkeeping failure cannot trigger an immediate duplicate.
                    logger.warning(
                        "commute schedule %s delivery could not be finalized",
                        sch["id"],
                    )
                    errors += 1
            else:
                # No subscribed devices for this uid (or all 410'd).
                # Don't burn the daily slot — a device that signs in
                # later in the same window should still get pinged.
                skipped += 1
                if not _release_commute_claim(sch["id"], claim_token):
                    logger.warning(
                        "commute schedule %s failed claim release", sch["id"]
                    )
                    errors += 1
        except Exception as e:
            logger.warning("commute schedule %s failed: %s", sch.get("id"), e)
            errors += 1

    return {
        "scanned": len(schedules),
        "fired": fired,
        "skipped": skipped,
        "errors": errors,
    }


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
