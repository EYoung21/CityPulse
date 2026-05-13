"""Firestore incident store — same contract as store.py for the FastAPI server."""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import firebase_admin
from firebase_admin import credentials, firestore

_db: Optional[firestore.Client] = None


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


def _doc_to_row(doc_id: str, data: dict[str, Any]) -> dict[str, Any]:
    row = dict(data)
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
    word_timings: Optional[list] = None,
    city: Optional[str] = None,
    mentions: Optional[list[dict]] = None,
) -> dict:
    db = _ensure_client()
    incident_id = uuid.uuid4().hex[:12]
    if reported_at is None:
        reported_at = datetime.now(timezone.utc).isoformat()

    payload = {
        "reported_at": reported_at,
        "ingested_at": ingested_at or datetime.now(timezone.utc).isoformat(),
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
        "word_timings": word_timings,
        "city": city,
        "mentions": mentions or [],
        "mention_count": len(mentions or []),
        "last_mention_at": reported_at,
    }
    ref = db.collection("incidents").document(incident_id)
    ref.set(payload)
    snap = ref.get()
    return _doc_to_row(snap.id, snap.to_dict() or {})


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
    try:
        query = (
            db.collection("incidents")
            .where("severity_category", "==", severity_category)
            .where("reported_at", ">=", floor_iso)
            .order_by("reported_at", direction=firestore.Query.DESCENDING)
            .limit(candidate_limit)
        )
        if city:
            query = query.where("city", "==", city)

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
    except Exception:
        return None
    return None


def append_mention(incident_id: str, mention: dict) -> Optional[dict]:
    """Append a mention to an incident's mentions array atomically.

    Also bumps `mention_count`, advances `last_mention_at`, and (if the
    new mention has higher confidence) adopts its category/severity.
    Returns the updated incident dict.
    """
    db = _ensure_client()
    ref = db.collection("incidents").document(incident_id)
    snap = ref.get()
    if not snap.exists:
        return None
    current = snap.to_dict() or {}

    updates: dict[str, Any] = {
        "mentions": firestore.ArrayUnion([mention]),
        "mention_count": firestore.Increment(1),
    }
    new_at = mention.get("at")
    if new_at and (not current.get("last_mention_at") or new_at > current["last_mention_at"]):
        updates["last_mention_at"] = new_at

    new_conf = float(mention.get("confidence") or 0)
    cur_conf = float(current.get("confidence") or 0)
    if new_conf > cur_conf:
        updates["confidence"] = new_conf
        if mention.get("description"):
            updates["description"] = mention["description"]
        # If the higher-confidence mention also reclassified the call,
        # adopt that. The s_base bump is the responsibility of the
        # caller (server.py knows the weights table).
        new_cat = mention.get("severity_category")
        if new_cat and new_cat != current.get("severity_category"):
            updates["severity_category"] = new_cat
            if mention.get("s_base") is not None:
                updates["s_base"] = mention["s_base"]

    ref.update(updates)
    fresh = ref.get()
    return _doc_to_row(fresh.id, fresh.to_dict() or {})


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
) -> dict:
    db = _ensure_client()
    eid = uuid.uuid4().hex[:12]
    if reported_at is None:
        reported_at = datetime.now(timezone.utc).isoformat()
    payload = {
        "feed_id": feed_id,
        "raw_text": raw_text,
        "reported_at": reported_at,
        "ingested_at": ingested_at or datetime.now(timezone.utc).isoformat(),
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
    ref.set(payload)
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
            .where("feed_id", "==", feed_id)
            .where("reported_at", ">=", floor_iso)
            .where("reported_at", "<", before_iso)
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
    snap = ref.get()
    data = snap.to_dict() or {}
    return {"id": snap.id, **data}


def get_incident(incident_id: str) -> Optional[dict]:
    db = _ensure_client()
    snap = db.collection("incidents").document(incident_id).get()
    if not snap.exists:
        return None
    return _doc_to_row(snap.id, snap.to_dict() or {})


def update_incident(incident_id: str, updates: dict) -> Optional[dict]:
    db = _ensure_client()
    ref = db.collection("incidents").document(incident_id)
    if not ref.get().exists:
        return None
    ref.update(updates)
    snap = ref.get()
    return _doc_to_row(snap.id, snap.to_dict() or {})


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
    try:
        query = col.order_by("reported_at", direction=firestore.Query.DESCENDING).limit(1000)
        for doc in query.stream():
            row = _doc_to_row(doc.id, doc.to_dict() or {})
            reported_at = row.get("reported_at") or ""
            if since and reported_at < since:
                break
            if not include_blocked and row.get("inhibitor_status") == "blocked":
                continue
            # Soft-hidden incidents (e.g. backfill_geocode_repair couldn't
            # map them) are filtered out of public reads but preserved on
            # disk so stable IDs / shared URLs / vote history still resolve.
            if not include_hidden and row.get("hidden") is True:
                continue
            if category and row.get("severity_category") != category:
                continue
            rows.append(row)
    except Exception:
        pass
    return rows


def list_incidents_for_city(
    city: str,
    since: Optional[str] = None,
    category: Optional[str] = None,
    before_iso: Optional[str] = None,
    limit: int = 50,
    include_blocked: bool = False,
    include_hidden: bool = False,
) -> list[dict]:
    """City-scoped incidents ordered by reported_at desc (cursor via before_iso)."""
    if not city:
        return []
    db = _ensure_client()
    rows: list[dict] = []
    try:
        query = (
            db.collection("incidents")
            .where("city", "==", city)
            .order_by("reported_at", direction=firestore.Query.DESCENDING)
        )
        if since:
            query = query.where("reported_at", ">=", since)
        if before_iso:
            query = query.where("reported_at", "<", before_iso)
        query = query.limit(int(limit))
        for doc in query.stream():
            row = _doc_to_row(doc.id, doc.to_dict() or {})
            if not include_blocked and row.get("inhibitor_status") == "blocked":
                continue
            if not include_hidden and row.get("hidden") is True:
                continue
            if category and row.get("severity_category") != category:
                continue
            rows.append(row)
    except Exception:
        pass
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
    try:
        inc_q = (
            db.collection("incidents")
            .where("city", "==", slug)
            .order_by("reported_at", direction=firestore.Query.DESCENDING)
            .limit(1)
        )
        for snap in inc_q.stream():
            out["newest_incident_at"] = (snap.to_dict() or {}).get("reported_at")
            break
    except Exception:
        pass
    try:
        ext_q = (
            db.collection("extractions")
            .where("city", "==", slug)
            .order_by("reported_at", direction=firestore.Query.DESCENDING)
            .limit(1)
        )
        for snap in ext_q.stream():
            out["newest_extraction_at"] = (snap.to_dict() or {}).get("reported_at")
            break
    except Exception:
        pass
    try:
        rel = 0
        promoted = 0
        ext_recent = (
            db.collection("extractions")
            .where("city", "==", slug)
            .where("reported_at", ">=", floor)
            .limit(5000)
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
    except Exception:
        pass
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
    try:
        agg = db.collection("incidents").count().get()
        return agg[0][0].value
    except Exception:
        return -1


def count_city_incidents(slug: str, since_iso: Optional[str] = None) -> int:
    """Count incidents for a single city, optionally since an ISO timestamp.

    Used by the landing-page `/api/city-stats/:slug` endpoint. Returns -1
    on error so the caller can fall back gracefully.
    """
    db = _ensure_client()
    try:
        query = db.collection("incidents").where("city", "==", slug)
        if since_iso:
            query = query.where("reported_at", ">=", since_iso)
        agg = query.count().get()
        return agg[0][0].value
    except Exception:
        return -1


def inhibitor_stats() -> dict:
    db = _ensure_client()
    stats: dict[str, int] = {}
    try:
        for status in ["passed", "blocked"]:
            agg = db.collection("incidents").where("inhibitor_status", "==", status).count().get()
            if agg:
                stats[status] = agg[0][0].value
    except Exception:
        pass
    return stats
