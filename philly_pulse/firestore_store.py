"""Firestore incident store — same contract as store.py for the FastAPI server."""

from __future__ import annotations

import json
import logging
import math
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import firebase_admin
from firebase_admin import credentials, firestore
from google.api_core.exceptions import AlreadyExists
from google.cloud.firestore_v1.base_query import FieldFilter

logger = logging.getLogger(__name__)

# word_timings is large (~73% of the map-sync payload) and only the incident
# detail view needs it. We keep it OFF the incident doc and store it in this
# sibling collection so the map query stays slim; the frontend lazy-loads it.
WORD_TIMINGS_COLLECTION = "incident_word_timings"

_db: Optional[firestore.Client] = None


def _canonical_utc_iso(value: str | None = None) -> str:
    """Store one sortable UTC representation instead of mixing offsets and ``Z``."""
    if value is None:
        return datetime.now(timezone.utc).isoformat()
    raw = str(value).strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def _ensure_client() -> firestore.Client:
    global _db
    if _db is not None:
        return _db
    if firebase_admin._apps:
        _db = firestore.client()
        return _db

    cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    json_str = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    if cred_path and os.path.isfile(cred_path):
        cred = credentials.Certificate(cred_path)
    elif json_str:
        cred = credentials.Certificate(json.loads(json_str))
    else:
        raise RuntimeError(
            "Firestore requires GOOGLE_APPLICATION_CREDENTIALS (path to JSON) "
            "or FIREBASE_SERVICE_ACCOUNT_JSON (JSON string)."
        )
    firebase_admin.initialize_app(cred)
    _db = firestore.client()
    return _db


def get_conn() -> Any:
    """Match SQLite store: warm up DB on startup."""
    _ensure_client()
    return None


def _json_safe_firestore_value(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {str(key): _json_safe_firestore_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe_firestore_value(item) for item in value]
    return value


def _doc_to_row(doc_id: str, data: dict[str, Any]) -> dict[str, Any]:
    row = _json_safe_firestore_value(dict(data))
    row["id"] = doc_id
    return row


def insert_incident(
    raw_text: str,
    severity_category: str,
    s_base: float,
    confidence: float,
    location_text: Optional[str] = None,
    lat: Optional[float] = None,
    lng: Optional[float] = None,
    geocode_status: str = "pending",
    location_confidence: str = "none",
    inhibitor_status: str = "passed",
    inhibitor_reason: Optional[str] = None,
    reported_at: Optional[str] = None,
    ingested_at: Optional[str] = None,
    audio_clip: Optional[str] = None,
    feed_id: Optional[str] = None,
    description: Optional[str] = None,
    unit_status: Optional[str] = None,
    word_timings: Optional[list] = None,
    city: Optional[str] = None,
    mentions: Optional[list[dict]] = None,
    incident_id: Optional[str] = None,
) -> dict:
    db = _ensure_client()
    incident_id = incident_id or uuid.uuid4().hex[:12]
    reported_at = _canonical_utc_iso(reported_at)
    ingested_at = _canonical_utc_iso(ingested_at)

    payload = {
        "reported_at": reported_at,
        "ingested_at": ingested_at,
        "raw_text": raw_text,
        "severity_category": severity_category,
        "s_base": s_base,
        "location_text": location_text,
        "lat": lat,
        "lng": lng,
        "confidence": confidence,
        "geocode_status": geocode_status,
        "location_confidence": location_confidence,
        "inhibitor_status": inhibitor_status,
        "inhibitor_reason": inhibitor_reason,
        "audio_clip": audio_clip,
        "feed_id": feed_id,
        "description": description,
        "unit_status": unit_status,
        # word_timings lives in the sibling collection (see below), not here —
        # the map only needs this flag to know whether to lazy-load timings.
        "has_word_timings": bool(word_timings),
        "city": city,
        "mentions": mentions or [],
        "mention_count": len(mentions or []),
        "last_mention_at": reported_at,
    }
    ref = db.collection("incidents").document(incident_id)
    try:
        ref.create(payload)
        was_created = True
    except AlreadyExists:
        existing = ref.get()
        if existing.exists:
            return {
                **_doc_to_row(existing.id, existing.to_dict() or {}),
                "_was_created": False,
            }
        # A delete raced the idempotent retry between create() and get().
        ref.create(payload)
        was_created = True
    # Sidecar write is best-effort: an incident must never fail to save over
    # its (optional) word timings. On failure has_word_timings stays True but
    # the detail view simply renders the transcript without per-word sync.
    if word_timings:
        try:
            db.collection(WORD_TIMINGS_COLLECTION).document(incident_id).set(
                {"incident_id": incident_id, "word_timings": word_timings}
            )
        except Exception as e:  # pragma: no cover — defensive
            logger.warning("word_timings sidecar write failed for %s: %s", incident_id, e)
    # Avoid an extra ``get()`` — ``set`` already wrote the full payload.
    return {
        **_doc_to_row(incident_id, payload),
        "_was_created": was_created,
    }


def get_word_timings(incident_id: str) -> Optional[list]:
    """Fetch an incident's word timings from the sidecar collection.

    Returns None when there are no timings (redacted incident, best-effort
    write that failed, or a legacy doc not yet migrated)."""
    db = _ensure_client()
    snap = db.collection(WORD_TIMINGS_COLLECTION).document(incident_id).get()
    if not snap.exists:
        return None
    wt = (snap.to_dict() or {}).get("word_timings")
    return wt if isinstance(wt, list) else None


# ── Incident dedup ────────────────────────────────────────────────────


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in km."""
    from math import radians, sin, cos, asin, sqrt

    r = 6371.0
    dlat = radians(lat2 - lat1)
    dlng = radians(lng2 - lng1)
    a = (
        sin(dlat / 2) ** 2
        + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng / 2) ** 2
    )
    return 2 * r * asin(sqrt(a))


def find_recent_duplicate(
    *,
    city: Optional[str],
    lat: float,
    lng: float,
    severity_category: str,
    reported_at: str,
    within_seconds: int = 900,
    radius_km: float = 0.2,
    candidate_limit: int = 25,
) -> Optional[dict]:
    """Return an existing incident that this new mention should merge into.

    Two scanner mentions are considered the same crime if they share city +
    severity_category, occur within `within_seconds` of each other, and pin
    within `radius_km`. Caller is responsible for constructing `reported_at`
    in ISO 8601 format (string comparison is used as a Firestore filter).

    Returns the matched incident dict, or None.
    """
    if lat is None or lng is None or not severity_category:
        return None
    try:
        before_dt = datetime.fromisoformat(reported_at.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    floor_iso = (before_dt - timedelta(seconds=within_seconds)).isoformat()

    db = _ensure_client()
    query = (
        db.collection("incidents")
        .where(filter=FieldFilter("severity_category", "==", severity_category))
        .where(filter=FieldFilter("reported_at", ">=", floor_iso))
        .order_by("reported_at", direction=firestore.Query.DESCENDING)
        .limit(candidate_limit)
    )
    if city:
        query = query.where(filter=FieldFilter("city", "==", city))

    for snap in query.stream():
        data = snap.to_dict() or {}
        if data.get("hidden") is True:
            continue
        if data.get("inhibitor_status") == "blocked":
            continue
        cand_lat = data.get("lat")
        cand_lng = data.get("lng")
        if cand_lat is None or cand_lng is None:
            continue
        if _haversine_km(lat, lng, cand_lat, cand_lng) <= radius_km:
            return _doc_to_row(snap.id, data)
    return None


def append_mention(incident_id: str, mention: dict) -> Optional[dict]:
    """Append a mention to an incident's mentions array atomically.

    Also bumps `mention_count`, advances `last_mention_at`, and (if the
    new mention has higher confidence) adopts its category/severity.
    Returns the updated incident dict.
    """
    db = _ensure_client()
    ref = db.collection("incidents").document(incident_id)
    transaction = db.transaction()

    @firestore.transactional
    def append_in_transaction(txn):
        snap = ref.get(transaction=txn)
        if not snap.exists:
            return None
        current = snap.to_dict() or {}
        mentions = list(current.get("mentions") or [])
        mention_key = (
            mention.get("at"),
            mention.get("feed_id"),
            mention.get("audio_clip"),
            mention.get("raw_text"),
        )
        if any(
            (
                existing.get("at"),
                existing.get("feed_id"),
                existing.get("audio_clip"),
                existing.get("raw_text"),
            )
            == mention_key
            for existing in mentions
            if isinstance(existing, dict)
        ):
            return {
                **_doc_to_row(snap.id, current),
                "_mention_added": False,
            }

        mentions.append(mention)
        # Bound the recent-update stack below Firestore's 1 MiB document cap;
        # mention_count remains the lifetime total.
        mentions = mentions[-25:]
        updates: dict[str, Any] = {
            "mentions": mentions,
            "mention_count": int(current.get("mention_count") or 0) + 1,
        }
        new_at = mention.get("at")
        if new_at and (
            not current.get("last_mention_at")
            or new_at > current["last_mention_at"]
        ):
            updates["last_mention_at"] = new_at

        new_conf = float(mention.get("confidence") or 0)
        cur_conf = float(current.get("confidence") or 0)
        if new_conf > cur_conf:
            updates["confidence"] = new_conf
            if mention.get("description"):
                updates["description"] = mention["description"]
            new_cat = mention.get("severity_category")
            if new_cat and new_cat != current.get("severity_category"):
                updates["severity_category"] = new_cat
                if mention.get("s_base") is not None:
                    updates["s_base"] = mention["s_base"]

        txn.update(ref, updates)
        return {
            **_doc_to_row(snap.id, {**current, **updates}),
            "_mention_added": True,
        }

    return append_in_transaction(transaction)


def insert_extraction(
    feed_id: str,
    raw_text: str,
    reported_at: Optional[str] = None,
    audio_clip: Optional[str] = None,
    raw_audio_clip: Optional[str] = None,
    preprocess_meta: Optional[dict] = None,
    variants: Optional[list[dict]] = None,
    llm_relevant: bool = False,
    llm_category: Optional[str] = None,
    llm_confidence: float = 0.0,
    llm_location_text: Optional[str] = None,
    location_confidence: Optional[str] = None,
    inhibitor_status: Optional[str] = None,
    inhibitor_reason: Optional[str] = None,
    geocode_status: Optional[str] = None,
    geocode_attempts: Optional[list] = None,
    incident_id: Optional[str] = None,
    city: Optional[str] = None,
    prefilter_status: Optional[str] = None,
    prefilter_reason: Optional[str] = None,
    ingested_at: Optional[str] = None,
    segment_start_utc: Optional[str] = None,
    ingest_lag_sec: Optional[float] = None,
    extraction_id: Optional[str] = None,
) -> dict:
    db = _ensure_client()
    eid = extraction_id or uuid.uuid4().hex[:12]
    reported_at = _canonical_utc_iso(reported_at)
    ingested_at = _canonical_utc_iso(ingested_at)
    if segment_start_utc is not None:
        segment_start_utc = _canonical_utc_iso(segment_start_utc)
    payload = {
        "feed_id": feed_id,
        "raw_text": raw_text,
        "reported_at": reported_at,
        "ingested_at": ingested_at,
        "segment_start_utc": segment_start_utc,
        "ingest_lag_sec": ingest_lag_sec,
        "audio_clip": audio_clip,
        "raw_audio_clip": raw_audio_clip,
        "preprocess_meta": preprocess_meta,
        "variants": variants or [],
        "llm_relevant": llm_relevant,
        "llm_category": llm_category,
        "llm_confidence": llm_confidence,
        "llm_location_text": llm_location_text,
        "location_confidence": location_confidence,
        "inhibitor_status": inhibitor_status,
        "inhibitor_reason": inhibitor_reason,
        "geocode_status": geocode_status,
        "geocode_attempts": geocode_attempts or [],
        "incident_id": incident_id,
        "city": city,
        "prefilter_status": prefilter_status,
        "prefilter_reason": prefilter_reason,
    }
    ref = db.collection("extractions").document(eid)
    try:
        ref.create(payload)
        return {"id": eid, **payload}
    except AlreadyExists:
        existing = ref.get()
        if existing.exists:
            return {"id": existing.id, **(existing.to_dict() or {})}
        ref.create(payload)
        return {"id": eid, **payload}


def get_extraction(extraction_id: str) -> Optional[dict]:
    db = _ensure_client()
    snap = db.collection("extractions").document(extraction_id).get()
    if not snap.exists:
        return None
    data = snap.to_dict() or {}
    return {"id": snap.id, **data}


def get_recent_extractions(
    feed_id: str,
    before_iso: str,
    within_seconds: int = 60,
    limit: int = 3,
) -> list[dict]:
    """Return up to `limit` most-recent extractions on the same feed within
    `within_seconds` of `before_iso`, ordered oldest-first.

    Used as adjacent-radio prior context for llm.extract_incident so that
    officer follow-ups inherit the dispatcher's location. Wrapped in a
    permissive try/except: a missing composite index or transient Firestore
    error must never block ingestion.

    Requires a Firestore composite index on (feed_id ASC, reported_at DESC).
    """
    if not feed_id or not before_iso:
        return []
    try:
        before_dt = datetime.fromisoformat(before_iso.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return []
    floor_dt = before_dt - timedelta(seconds=within_seconds)
    floor_iso = floor_dt.isoformat()

    db = _ensure_client()
    try:
        query = (
            db.collection("extractions")
            .where(filter=FieldFilter("feed_id", "==", feed_id))
            .where(filter=FieldFilter("reported_at", ">=", floor_iso))
            .where(filter=FieldFilter("reported_at", "<", before_iso))
            .order_by("reported_at", direction=firestore.Query.DESCENDING)
            .limit(limit)
        )
        rows: list[dict] = []
        for snap in query.stream():
            data = snap.to_dict() or {}
            rows.append({"id": snap.id, **data})
        rows.reverse()
        return rows
    except Exception:
        return []


def update_extraction(extraction_id: str, updates: dict) -> Optional[dict]:
    db = _ensure_client()
    ref = db.collection("extractions").document(extraction_id)
    ref.update(updates)
    # Callers only need the write to land; skip a follow-up read.
    return None


def get_incident(incident_id: str) -> Optional[dict]:
    db = _ensure_client()
    snap = db.collection("incidents").document(incident_id).get()
    if not snap.exists:
        return None
    return _doc_to_row(snap.id, snap.to_dict() or {})


def update_incident(incident_id: str, updates: dict) -> Optional[dict]:
    db = _ensure_client()
    ref = db.collection("incidents").document(incident_id)
    snap = ref.get()
    if not snap.exists:
        return None
    current = snap.to_dict() or {}
    ref.update(updates)
    merged = {**current, **updates}
    return _doc_to_row(snap.id, merged)


def delete_incident(incident_id: str) -> bool:
    db = _ensure_client()
    ref = db.collection("incidents").document(incident_id)
    if not ref.get().exists:
        return False
    ref.delete()
    return True


def list_incidents(
    since: Optional[str] = None,
    category: Optional[str] = None,
    include_blocked: bool = False,
    include_hidden: bool = False,
) -> list[dict]:
    db = _ensure_client()
    col = db.collection("incidents")
    rows: list[dict] = []
    query = col
    if category:
        query = query.where(filter=FieldFilter("severity_category", "==", category))
    if since:
        query = query.where(filter=FieldFilter("reported_at", ">=", since))
    query = query.order_by(
        "reported_at", direction=firestore.Query.DESCENDING
    ).limit(1000)
    for doc in query.stream():
        row = _doc_to_row(doc.id, doc.to_dict() or {})
        if not include_blocked and row.get("inhibitor_status") == "blocked":
            continue
        # Soft-hidden incidents (e.g. backfill_geocode_repair couldn't
        # map them) are filtered out of public reads but preserved on
        # disk so stable IDs / shared URLs / vote history still resolve.
        if not include_hidden and row.get("hidden") is True:
            continue
        rows.append(row)
    return rows


def list_incidents_for_city(
    city: str,
    since: Optional[str] = None,
    category: Optional[str] = None,
    before_iso: Optional[str] = None,
    cursor_id: Optional[str] = None,
    limit: int = 50,
    include_blocked: bool = False,
    include_hidden: bool = False,
) -> list[dict]:
    """City-scoped incidents ordered by reported_at desc (cursor via before_iso)."""
    if not city:
        return []
    db = _ensure_client()
    rows: list[dict] = []
    query = db.collection("incidents").where(filter=FieldFilter("city", "==", city))
    # Apply all public filters before the limit. Filtering category in Python
    # after limiting the newest mixed-category rows silently omitted older
    # matches and produced short/empty category pages.
    if category:
        query = query.where(filter=FieldFilter("severity_category", "==", category))
    if since:
        query = query.where(filter=FieldFilter("reported_at", ">=", since))
    # A compound (reported_at, document ID) cursor prevents rows that share a
    # scanner segment timestamp from being skipped between pages. Legacy
    # timestamp-only cursors retain the old strict-before behavior.
    cursor_snap = None
    if cursor_id:
        candidate = db.collection("incidents").document(cursor_id).get()
        if candidate.exists:
            cursor_snap = candidate
    if before_iso and cursor_snap is None:
        query = query.where(filter=FieldFilter("reported_at", "<", before_iso))
    query = query.order_by(
        "reported_at", direction=firestore.Query.DESCENDING
    ).order_by("__name__", direction=firestore.Query.DESCENDING)

    # Public visibility flags are not uniformly present on legacy documents,
    # so filtering them with Firestore inequalities would exclude missing-field
    # rows. Scan bounded chunks until we have the requested number of visible
    # rows; a single raw `limit()` followed by Python filtering caused short
    # pages and incorrectly ended pagination whenever a hidden/blocked row was
    # inside the batch.
    desired = max(1, int(limit))
    scanned = 0
    last_snap = cursor_snap
    max_scan = max(5000, desired * 10)
    while len(rows) < desired and scanned < max_scan:
        chunk_size = min(250, max(50, desired - len(rows) + 25))
        page_query = query.start_after(last_snap) if last_snap is not None else query
        docs = list(page_query.limit(chunk_size).stream())
        if not docs:
            break
        scanned += len(docs)
        last_snap = docs[-1]
        for doc in docs:
            row = _doc_to_row(doc.id, doc.to_dict() or {})
            if not include_blocked and row.get("inhibitor_status") == "blocked":
                continue
            if not include_hidden and row.get("hidden") is True:
                continue
            rows.append(row)
            if len(rows) >= desired:
                break
        if len(docs) < chunk_size:
            break
    return rows


def get_city_pipeline_freshness(slug: str, hours: int = 6) -> dict[str, Any]:
    """Newest extraction/incident timestamps and promotion rate for ops dashboards."""
    db = _ensure_client()
    floor = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()
    out: dict[str, Any] = {
        "newest_incident_at": None,
        "newest_extraction_at": None,
        "llm_relevant_6h": 0,
        "promoted_6h": 0,
        "promotion_rate_6h": None,
    }
    inc_q = (
        db.collection("incidents")
        .where(filter=FieldFilter("city", "==", slug))
        .order_by("reported_at", direction=firestore.Query.DESCENDING)
        .limit(1)
    )
    for snap in inc_q.stream():
        out["newest_incident_at"] = (snap.to_dict() or {}).get("reported_at")
        break
    ext_q = (
        db.collection("extractions")
        .where(filter=FieldFilter("city", "==", slug))
        .order_by("reported_at", direction=firestore.Query.DESCENDING)
        .limit(1)
    )
    for snap in ext_q.stream():
        out["newest_extraction_at"] = (snap.to_dict() or {}).get("reported_at")
        break
    rel = 0
    promoted = 0
    # Promotion rate is a ratio over the last `hours`; a 1500-doc sample is
    # plenty representative and bounds the read cost for high-volume cities
    # (this query was up to 5000 docs/call and is hit on every city-stats
    # request). Limit only — no extra order_by, to reuse the existing
    # (city, reported_at) index exactly and avoid a new-index requirement.
    ext_recent = (
        db.collection("extractions")
        .where(filter=FieldFilter("city", "==", slug))
        .where(filter=FieldFilter("reported_at", ">=", floor))
        .limit(1500)
    )
    for snap in ext_recent.stream():
        data = snap.to_dict() or {}
        if not data.get("llm_relevant"):
            continue
        rel += 1
        if data.get("incident_id"):
            promoted += 1
    out["llm_relevant_6h"] = rel
    out["promoted_6h"] = promoted
    out["promotion_rate_6h"] = (promoted / rel) if rel else None
    return out


def seed_from_json(seed_path: str, s_base_lookup: dict[str, float]) -> int:
    with open(seed_path, "r") as f:
        seeds = json.load(f)

    db = _ensure_client()
    batch = db.batch()
    count = 0
    now = datetime.now(timezone.utc)
    for item in seeds:
        incident_id = uuid.uuid4().hex[:12]
        offset = item.get("reported_at_offset_minutes", 0)
        reported = (now + timedelta(minutes=offset)).isoformat()
        cat = item["severity_category"]
        ref = db.collection("incidents").document(incident_id)
        batch.set(
            ref,
            {
                "reported_at": reported,
                "raw_text": item["raw_text"],
                "severity_category": cat,
                "s_base": s_base_lookup.get(cat, 0.5),
                "location_text": item.get("location_text"),
                "lat": item.get("lat"),
                "lng": item.get("lng"),
                "confidence": item.get("confidence", 0.8),
                "geocode_status": "seeded",
                "inhibitor_status": "passed",
                "inhibitor_reason": None,
            },
        )
        count += 1
        if count % 400 == 0:
            batch.commit()
            batch = db.batch()
    batch.commit()
    return count


def incident_count() -> int:
    db = _ensure_client()
    agg = db.collection("incidents").count().get()
    return agg[0][0].value


def city_incident_count(slug: str) -> int:
    """Count incidents for one city and propagate datastore failures."""
    db = _ensure_client()
    agg = (
        db.collection("incidents")
        .where(filter=FieldFilter("city", "==", slug))
        .count()
        .get()
    )
    return agg[0][0].value


def count_city_incidents(slug: str, since_iso: Optional[str] = None) -> int:
    """Count incidents for a single city, optionally since an ISO timestamp.

    Used by the landing-page `/api/city-stats/:slug` endpoint. Returns -1
    on error so the caller can fall back gracefully.
    """
    db = _ensure_client()
    try:
        query = db.collection("incidents").where(filter=FieldFilter("city", "==", slug))
        if since_iso:
            query = query.where(filter=FieldFilter("reported_at", ">=", since_iso))
        agg = query.count().get()
        return agg[0][0].value
    except Exception:
        return -1


def count_city_incidents_filtered(
    slug: str,
    *,
    since_iso: Optional[str] = None,
    until_iso: Optional[str] = None,
    severity_category: Optional[str] = None,
) -> int:
    """Cheap aggregate count for the Pulse Chat `count_incidents` tool.

    Lets the LLM answer "how many X in time window Y" questions without
    paging the actual rows. Returns -1 on error so the caller can degrade
    gracefully ("count unavailable").

    Firestore composite indexes already cover (city, reported_at) and
    (city, severity_category, reported_at) for the existing list / stats
    queries; this reuses both shapes via .count() so no new indexes are
    required.
    """
    db = _ensure_client()
    try:
        query = db.collection("incidents").where(filter=FieldFilter("city", "==", slug))
        if severity_category:
            query = query.where(filter=FieldFilter("severity_category", "==", severity_category))
        if since_iso:
            query = query.where(filter=FieldFilter("reported_at", ">=", since_iso))
        if until_iso:
            query = query.where(filter=FieldFilter("reported_at", "<", until_iso))
        agg = query.count().get()
        return agg[0][0].value
    except Exception:
        return -1


def find_latest_city_incidents(
    slug: str,
    *,
    severity_category: Optional[str] = None,
    since_iso: Optional[str] = None,
    before_iso: Optional[str] = None,
    limit: int = 25,
) -> list[dict]:
    """Newest-first incidents for a city, filtered server-side by category.

    The Pulse Chat "when was the last <rare event>" path. Unlike
    :func:`list_incidents_for_city` — which applies the category filter in
    Python *after* the query limit, so a rare category (e.g. a homicide
    months back) is silently dropped when it's not among the newest N rows —
    this pushes ``severity_category`` into the Firestore query itself and
    orders by reported_at DESC. So "the most recent violent_weapon" is found
    no matter how far back it is, in a single indexed read.

    Reuses the (city, severity_category, reported_at) composite index already
    maintained for :func:`count_city_incidents_filtered`, so no new index is
    required. Datastore failures propagate so callers can distinguish an
    unavailable query from a valid empty result.
    """
    if not slug:
        return []
    db = _ensure_client()
    rows: list[dict] = []
    query = db.collection("incidents").where(filter=FieldFilter("city", "==", slug))
    if severity_category:
        query = query.where(filter=FieldFilter("severity_category", "==", severity_category))
    if since_iso:
        query = query.where(filter=FieldFilter("reported_at", ">=", since_iso))
    if before_iso:
        query = query.where(filter=FieldFilter("reported_at", "<", before_iso))
    query = query.order_by(
        "reported_at", direction=firestore.Query.DESCENDING
    ).limit(int(limit))
    for doc in query.stream():
        row = _doc_to_row(doc.id, doc.to_dict() or {})
        if row.get("inhibitor_status") == "blocked":
            continue
        if row.get("hidden") is True:
            continue
        rows.append(row)
    return rows


def inhibitor_stats() -> dict:
    db = _ensure_client()
    stats: dict[str, int] = {}
    for status in ["passed", "blocked"]:
        agg = (
            db.collection("incidents")
            .where(filter=FieldFilter("inhibitor_status", "==", status))
            .count()
            .get()
        )
        if agg:
            stats[status] = agg[0][0].value
    return stats


def city_inhibitor_stats(slug: str) -> dict:
    """Return inhibitor counts for one city, never a cross-city aggregate."""
    db = _ensure_client()
    stats: dict[str, int] = {}
    for status in ["passed", "blocked"]:
        agg = (
            db.collection("incidents")
            .where(filter=FieldFilter("city", "==", slug))
            .where(filter=FieldFilter("inhibitor_status", "==", status))
            .count()
            .get()
        )
        if agg:
            stats[status] = agg[0][0].value
    return stats
