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
    created_at_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    last_used_ms: int = 0


def derive_subscription_hash(endpoint: str) -> str:
    """Stable, URL-safe doc id for a given endpoint URL.

    SHA-256 keeps it fixed-length even for the very long FCM/Mozilla
    endpoint URLs and avoids reserved characters in Firestore doc
    ids. We don't truncate — the marginal cost of 64 chars is
    nothing compared to the headache of a hash collision."""
    return hashlib.sha256(endpoint.encode("utf-8")).hexdigest()


# Hard cap on alert radius. A 50 km bubble around a single phone
# would defeat the "nearby" framing; we clamp anything over this
# down. Below 0.1 km we treat as "no area" since GPS jitter alone
# overwhelms the signal at that scale.
_MAX_ALERT_RADIUS_KM = 25.0
_MIN_ALERT_RADIUS_KM = 0.1


def upsert_subscription(sub: PushSubscription) -> str:
    """Idempotent insert. Returns the doc id used."""
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
        "notifyLat": notify_lat,
        "notifyLng": notify_lng,
        "notifyRadiusKm": radius,
        "createdAtMs": sub.created_at_ms,
        "lastUsedMs": sub.last_used_ms,
        # Per-subscription cooldown for nearby alerts. Bumped on
        # every nearby push; the trigger refuses to send again
        # within `_NEARBY_COOLDOWN_MS`. Stored on the doc itself
        # (rather than a side cache) so a process restart doesn't
        # reset everyone's cooldown to zero.
        "lastNearbyPushMs": 0,
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
        nlat = sub.get("notifyLat")
        nlng = sub.get("notifyLng")
        radius = float(sub.get("notifyRadiusKm") or 0.0)
        if nlat is None or nlng is None or radius <= 0:
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
    sent = failed = cooldown = 0
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

    for sub in matches:
        last_ms = int(sub.get("lastNearbyPushMs") or 0)
        if now_ms - last_ms < _NEARBY_COOLDOWN_MS:
            cooldown += 1
            continue
        ok, _status = send_to_subscription(sub, payload, ttl_seconds=15 * 60)
        if ok:
            sent += 1
            try:
                _db().collection("pushSubscriptions").document(sub["id"]).update(
                    {"lastNearbyPushMs": now_ms}
                )
            except Exception:
                # Cooldown bookkeeping failure is non-fatal — the
                # actual push went out, and a missed cooldown bump
                # just means the next nearby incident will also
                # ping. Acceptable.
                pass
        else:
            failed += 1
    return {
        "sent": sent,
        "failed": failed,
        "matched": len(matches),
        "cooldown": cooldown,
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
