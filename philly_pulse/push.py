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
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
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
    sent = failed = cooldown = quiet = snoozed = muted = 0
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
        last_ms = int(sub.get("lastNearbyPushMs") or 0)
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
        "quiet": quiet,
        "snoozed": snoozed,
        "muted": muted,
    }


# ── User preference gating (server-side respect for client prefs) ───

# All synced prefs live under users/{uid}/userPrefs/v1, mirrored
# from localStorage by frontend/src/lib/prefs-sync.ts. The values
# are JSON-encoded strings (e.g. quietHours stored as the JSON
# representation of a {enabled,startHour,...} object) — same shape
# the client reads. We treat the client format as authoritative and
# only need to *interpret* it here, never write it.

_PREFS_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
# 60s cache so a burst of nearby alerts doesn't hammer Firestore
# with prefs lookups for the same uid. The cost of being slightly
# stale (a user toggles snooze on and the next push 30s later
# still goes through) is far smaller than the cost of fetching
# the same doc 50× in a fan-out window.
_PREFS_CACHE_TTL_S = 60


def _load_user_prefs(uid: str) -> dict[str, Any]:
    """Read the synced prefs doc for `uid`, with a tiny TTL cache.

    Returns the raw `values` map (key → JSON-encoded string) or an
    empty dict on any failure — the gating callers all interpret
    "no prefs known" as "no opt-out", which matches the default
    state for a user who hasn't customized anything."""
    now = time.time()
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
        logger.debug("prefs lookup failed for %s: %s", uid, e)
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
    cfg = _parse_json_pref(prefs.get("pp:quiet-hours"))
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
    sh = int(cfg.get("startHour") or 0)
    sm = int(cfg.get("startMinute") or 0)
    eh = int(cfg.get("endHour") or 0)
    em = int(cfg.get("endMinute") or 0)
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
    raw = prefs.get("pp:push-snooze-until")
    if not isinstance(raw, str) or not raw:
        return False
    try:
        until_ms = int(raw)
    except Exception:
        return False
    return until_ms > int(time.time() * 1000)


def _is_category_muted_for_uid(uid: str, category: str) -> bool:
    """Mirrors `lib/alert-mutes.ts`: the muted set is stored as a
    JSON array of category strings. Push-side we apply this only
    to nearby-incident pushes — commute pushes are user-scoped
    and don't have a category in the same sense."""
    if not category:
        return False
    prefs = _load_user_prefs(uid)
    raw = _parse_json_pref(prefs.get("pp:muted-categories"))
    if not isinstance(raw, list):
        return False
    return category in raw


def invalidate_prefs_cache(uid: str) -> None:
    """Drop the cached prefs entry for a uid. Call after any server-
    side write that should be visible to the next push fan-out
    (currently unused — kept available for future prefs APIs)."""
    _PREFS_CACHE.pop(uid, None)


# ── User-report fan-out ─────────────────────────────────────────────

# Severity gate for user reports — a separate (lower) floor than
# scanner incidents because users only file reports they actually
# witnessed, and the categories are pre-curated. We still skip
# "minor / informational" categories to avoid push fatigue.
_USER_REPORT_PUSH_CATEGORIES = {
    # Map to USER_REPORT_CATEGORIES on the frontend; the backend
    # doesn't import that list directly to keep the FE/BE decoupled.
    # Add a category here when you decide it's worth a closed-tab
    # push to the people nearby.
    "user_violent",
    "user_hazard",
    "user_fire",
    "user_medical",
    "user_active_threat",
}


def notify_nearby_user_report(
    *,
    report_id: str,
    requesting_uid: str,
) -> dict[str, int]:
    """Fan-out for a freshly-submitted user report.

    The report is re-read from Firestore so the backend never trusts
    client-supplied location (a malicious client could otherwise
    push to neighborhoods unrelated to whatever they actually wrote
    down). The caller's UID must match `ownerUid` on the report —
    we don't allow third-party "amplification" of someone else's
    submission."""
    if not push_available():
        return {"sent": 0, "skipped_no_push": 1, "matched": 0, "cooldown": 0}

    try:
        snap = _db().collection("userReports").document(report_id).get()
    except Exception as e:
        logger.warning("notify_nearby_user_report: lookup failed for %s: %s", report_id, e)
        return {"sent": 0, "lookup_failed": 1, "matched": 0, "cooldown": 0}

    if not snap.exists:
        return {"sent": 0, "not_found": 1, "matched": 0, "cooldown": 0}

    data = snap.to_dict() or {}
    if data.get("ownerUid") != requesting_uid:
        # Defensive: someone calling the fan-out endpoint with
        # someone else's report id. We refuse — the originator owns
        # the right to amplify their own submission.
        return {"sent": 0, "ownership_mismatch": 1, "matched": 0, "cooldown": 0}

    category = str(data.get("category") or "")
    if category not in _USER_REPORT_PUSH_CATEGORIES:
        return {"sent": 0, "below_severity": 1, "matched": 0, "cooldown": 0}

    lat = data.get("lat")
    lng = data.get("lng")
    city = data.get("city") or ""
    if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)) or not city:
        return {"sent": 0, "incomplete": 1, "matched": 0, "cooldown": 0}

    matches = find_nearby_subscriptions(city, float(lat), float(lng))
    if not matches:
        return {"sent": 0, "matched": 0, "cooldown": 0}

    now_ms = int(time.time() * 1000)
    sent = failed = cooldown = self_skipped = quiet = snoozed = muted = 0
    seen_uids: dict[str, dict[str, bool]] = {}
    note = str(data.get("note") or "").strip()
    label = category.replace("user_", "").replace("_", " ").title()
    body = (
        f"Reported nearby: {note[:120]}"
        if note
        else f"{label} reported nearby."
    )
    payload = {
        "kind": "nearby_user_report",
        "reportId": report_id,
        "title": f"{label} reported by a nearby user",
        "body": body,
        # User-report incident IDs are prefixed in the frontend
        # (`userReportToIncident`) so the same `?incident=` deep-link
        # path resolves them. We send the raw report id and let the
        # page-side adapter route it correctly.
        "url": f"/?userReport={report_id}",
        "tag": f"pp:nearby-user:{city}",
        "requireInteraction": False,
        "category": category,
    }

    for sub in matches:
        # Don't push the originator's own report back to their other
        # devices — they obviously already know about it. We compare
        # on uid (not endpoint) so all of a user's devices are
        # excluded together.
        if sub.get("uid") == requesting_uid:
            self_skipped += 1
            continue
        last_ms = int(sub.get("lastNearbyPushMs") or 0)
        if now_ms - last_ms < _NEARBY_COOLDOWN_MS:
            cooldown += 1
            continue

        uid = str(sub.get("uid") or "")
        if uid:
            cached = seen_uids.get(uid)
            if cached is None:
                cached = {
                    "snoozed": _is_snoozed_for_uid(uid),
                    "quiet": _is_quiet_now_for_uid(uid, None),
                    "muted": _is_category_muted_for_uid(uid, category),
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

        ok, _status = send_to_subscription(sub, payload, ttl_seconds=15 * 60)
        if ok:
            sent += 1
            try:
                _db().collection("pushSubscriptions").document(sub["id"]).update(
                    {"lastNearbyPushMs": now_ms}
                )
            except Exception:
                pass
        else:
            failed += 1
    return {
        "sent": sent,
        "failed": failed,
        "matched": len(matches),
        "cooldown": cooldown,
        "self_skipped": self_skipped,
        "quiet": quiet,
        "snoozed": snoozed,
        "muted": muted,
    }


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
        .where("uid", "==", uid)
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
            .where("active", "==", True)
            .where("city", "==", city)
            .stream()
        ):
            out[d.id] = {"id": d.id, **(d.to_dict() or {})}
        for d in (
            _db()
            .collection("keywordWatches")
            .where("active", "==", True)
            .where("city", "==", "")
            .stream()
        ):
            out[d.id] = {"id": d.id, **(d.to_dict() or {})}
    except Exception as e:
        logger.warning("list_active_keyword_watches failed: %s", e)
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
    sent = failed = cooldown = below_floor = quiet = snoozed = 0
    matched = 0

    for w in watches:
        kw = _normalize_keyword(str(w.get("keyword") or ""))
        if not _keyword_matches(text_lower, kw):
            continue
        matched += 1

        # Optional severity floor on the watch — useful for very
        # broad keywords (e.g. "north philly") that the user only
        # wants to hear about for serious incidents.
        floor = float(w.get("severityFloor") or 0.0)
        if s_base < floor:
            below_floor += 1
            continue

        last_ms = int(w.get("lastFiredMs") or 0)
        if now_ms - last_ms < _KEYWORD_COOLDOWN_MS:
            cooldown += 1
            continue

        uid = str(w.get("uid") or "")
        if not uid:
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
        result = send_to_uid(uid, payload, ttl_seconds=15 * 60)
        if result.get("sent", 0) > 0:
            sent += result["sent"]
            try:
                _db().collection("keywordWatches").document(w["id"]).update(
                    {"lastFiredMs": now_ms, "lastIncidentId": incident_id}
                )
            except Exception:
                pass
        else:
            failed += 1

    return {
        "sent": sent,
        "matched": matched,
        "failed": failed,
        "cooldown": cooldown,
        "below_floor": below_floor,
        "quiet": quiet,
        "snoozed": snoozed,
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


def _user_tier_for_commute(uid: str) -> str:
    """Read `users/{uid}.tier` for the commute Pro gate.

    Mirrors `server._user_tier`, kept local to avoid an import cycle
    (server.py imports from push.py during route registration). Falls
    back to "free" on any read failure so an outage of the users
    collection silently downgrades all users — the safe default for a
    Pro perk: never accidentally promote anyone."""
    try:
        from .firestore_store import _ensure_client
        snap = _ensure_client().collection("users").document(uid).get()
        if snap.exists:
            t = ((snap.to_dict() or {}).get("tier") or "free")
            if t in ("free", "pro", "enterprise"):
                return t
    except Exception:
        pass
    return "free"


def notify_due_commutes() -> dict[str, int]:
    """Scan `commuteSchedules` and push for every schedule whose
    typical departure window contains "now" (in the schedule's own
    timezone) and that hasn't already been pushed today.

    Designed to be called every 1-2 minutes by an external cron;
    the FIRE_WINDOW + lastFiredYmd combination tolerates cron
    drift up to ~10 min without double-firing or missing entries."""
    if not push_available():
        return {"scanned": 0, "fired": 0, "skipped": 0, "errors": 0}

    try:
        snap = _db().collection("commuteSchedules").stream()
        schedules = [{"id": d.id, **(d.to_dict() or {})} for d in snap]
    except Exception as e:
        logger.warning("notify_due_commutes: scan failed: %s", e)
        return {"scanned": 0, "fired": 0, "skipped": 0, "errors": 1}

    fired = skipped = errors = 0
    now_ms = int(time.time() * 1000)
    cutoff_ms = now_ms - _COMMUTE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000

    for sch in schedules:
        try:
            if int(sch.get("updatedAt") or 0) < cutoff_ms:
                # Stale schedule — user probably stopped commuting
                # along this pattern weeks ago. Garbage-collect so the
                # collection doesn't grow unbounded.
                try:
                    _db().collection("commuteSchedules").document(sch["id"]).delete()
                except Exception:
                    pass
                skipped += 1
                continue

            confidence = float(sch.get("confidence") or 0)
            if confidence < _COMMUTE_MIN_CONFIDENCE:
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

            result = send_to_uid(uid, payload, ttl_seconds=15 * 60)
            if result.get("sent", 0) > 0:
                fired += 1
                # Mark fired *only* if at least one device actually
                # received it; otherwise the next tick can retry.
                try:
                    _db().collection("commuteSchedules").document(sch["id"]).update(
                        {"lastFiredYmd": today, "lastFiredAtMs": now_ms}
                    )
                except Exception:
                    pass
            else:
                # No subscribed devices for this uid (or all 410'd).
                # Don't burn the daily slot — a device that signs in
                # later in the same window should still get pinged.
                skipped += 1
        except Exception as e:
            logger.warning("commute schedule %s failed: %s", sch.get("id"), e)
            errors += 1

    return {
        "scanned": len(schedules),
        "fired": fired,
        "skipped": skipped,
        "errors": errors,
    }


# ── Admin broadcast ─────────────────────────────────────────────────

# A short body cap keeps notifications scannable on a lock-screen
# (Android cuts long bodies at ~120 chars; iOS has its own limits).
# The composer enforces the same limit client-side as a UX nicety,
# but we re-enforce here because the API is the source of truth.
_BROADCAST_BODY_MAX = 240
_BROADCAST_TITLE_MAX = 80


def count_subscribers_for_city(city: Optional[str]) -> int:
    """Recipient preview helper for the admin composer. Counts every
    subscription with a matching `city` field; passing None counts
    every subscription regardless of city.

    Note: this is the *subscription* count, not the unique-user
    count — a user with phone+desktop registered counts as two.
    That mirrors the actual fan-out behaviour, so the preview
    accurately reflects "how many notifications I'm about to send"."""
    try:
        return len(list_all_subscriptions(city=city))
    except Exception as e:
        logger.warning("count_subscribers_for_city failed: %s", e)
        return 0


def broadcast_to_city(
    *,
    city: Optional[str],
    title: str,
    body: str,
    url: Optional[str] = None,
    require_interaction: bool = False,
    actor_uid: str,
    actor_email: Optional[str],
) -> dict[str, Any]:
    """Fan out a single notification to every subscription in `city`.

    City filter is optional — passing None broadcasts to every
    subscriber across every pulse city, intended for app-wide
    maintenance / outage messages. Most real broadcasts should be
    city-scoped.

    The push respects `pp:push-snooze-until` and `pp:quiet-hours`
    on a per-recipient basis, same as every other fan-out, but does
    NOT respect the per-category mute pref — broadcasts have no
    incident category, and admins are explicitly trying to reach
    users who might have category mutes set during an emergency.
    The `requireInteraction` flag is passed through so a true
    "shelter in place" broadcast can hold itself open until the
    user dismisses, while a routine update can autodismiss."""
    if not push_available():
        return {"sent": 0, "failed": 0, "matched": 0, "skipped": 0, "error": "push_not_configured"}

    title = (title or "").strip()[:_BROADCAST_TITLE_MAX]
    body = (body or "").strip()[:_BROADCAST_BODY_MAX]
    if not title or not body:
        return {"sent": 0, "failed": 0, "matched": 0, "skipped": 0, "error": "title_and_body_required"}

    matches = list_all_subscriptions(city=city)
    if not matches:
        return {"sent": 0, "failed": 0, "matched": 0, "skipped": 0}

    # Use a stable tag per broadcast so a user with multiple devices
    # sees the same notification on each rather than a stack of
    # near-duplicates if the fan-out lands across a few seconds.
    tag = f"pp:broadcast:{int(time.time())}"
    payload = {
        "kind": "admin_broadcast",
        "title": title,
        "body": body,
        "tag": tag,
        "url": url or "/",
        "requireInteraction": bool(require_interaction),
    }

    seen_uids: dict[str, dict[str, bool]] = {}
    sent = failed = quiet = snoozed = 0

    for sub in matches:
        uid = str(sub.get("uid") or "")
        if uid:
            cached = seen_uids.get(uid)
            if cached is None:
                cached = {
                    "snoozed": _is_snoozed_for_uid(uid),
                    "quiet": _is_quiet_now_for_uid(uid, None),
                }
                seen_uids[uid] = cached
            if cached["snoozed"]:
                snoozed += 1
                continue
            if cached["quiet"]:
                quiet += 1
                continue
        ok, _status = send_to_subscription(sub, payload, ttl_seconds=60 * 60)
        if ok:
            sent += 1
        else:
            failed += 1

    logger.info(
        "Admin broadcast by %s (uid=%s) to city=%s: matched=%d sent=%d failed=%d snoozed=%d quiet=%d",
        actor_email or "?", actor_uid, city or "<all>",
        len(matches), sent, failed, snoozed, quiet,
    )
    return {
        "sent": sent,
        "failed": failed,
        "matched": len(matches),
        "skipped": snoozed + quiet,
        "snoozed": snoozed,
        "quiet": quiet,
        "tag": tag,
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
