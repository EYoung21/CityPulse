"""SQLite incident store for PhillyPulse."""

import json
import os
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

DB_PATH = os.environ.get(
    "PHILLY_PULSE_DB",
    str(Path(__file__).parent / "data" / "philly_pulse.db"),
)

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS incidents (
    id              TEXT PRIMARY KEY,
    reported_at     TEXT NOT NULL,
    raw_text        TEXT NOT NULL,
    severity_category TEXT NOT NULL,
    s_base          REAL NOT NULL,
    location_text   TEXT,
    lat             REAL,
    lng             REAL,
    confidence      REAL NOT NULL DEFAULT 1.0,
    geocode_status  TEXT DEFAULT 'pending',
    inhibitor_status TEXT DEFAULT 'passed',
    inhibitor_reason TEXT
);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


_conn: Optional[sqlite3.Connection] = None


def get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = _connect()
        _conn.execute(_CREATE_TABLE)
        _conn.commit()
    return _conn


def insert_incident(
    raw_text: str,
    severity_category: str,
    s_base: float,
    confidence: float,
    location_text: Optional[str] = None,
    lat: Optional[float] = None,
    lng: Optional[float] = None,
    geocode_status: str = "pending",
    inhibitor_status: str = "passed",
    inhibitor_reason: Optional[str] = None,
    reported_at: Optional[str] = None,
) -> dict:
    conn = get_conn()
    incident_id = uuid.uuid4().hex[:12]
    if reported_at is None:
        reported_at = datetime.now(timezone.utc).isoformat()

    conn.execute(
        """INSERT INTO incidents
           (id, reported_at, raw_text, severity_category, s_base,
            location_text, lat, lng, confidence, geocode_status,
            inhibitor_status, inhibitor_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            incident_id,
            reported_at,
            raw_text,
            severity_category,
            s_base,
            location_text,
            lat,
            lng,
            confidence,
            geocode_status,
            inhibitor_status,
            inhibitor_reason,
        ),
    )
    conn.commit()
    return get_incident(incident_id)


def get_incident(incident_id: str) -> Optional[dict]:
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM incidents WHERE id = ?", (incident_id,)
    ).fetchone()
    return dict(row) if row else None


def list_incidents(
    since: Optional[str] = None,
    category: Optional[str] = None,
    include_blocked: bool = False,
) -> list[dict]:
    conn = get_conn()
    clauses = []
    params: list = []

    if not include_blocked:
        clauses.append("inhibitor_status != 'blocked'")
    if since:
        clauses.append("reported_at >= ?")
        params.append(since)
    if category:
        clauses.append("severity_category = ?")
        params.append(category)

    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = conn.execute(
        f"SELECT * FROM incidents{where} ORDER BY reported_at DESC", params
    ).fetchall()
    return [dict(r) for r in rows]


def seed_from_json(seed_path: str, s_base_lookup: dict[str, float]) -> int:
    """Load seed_incidents.json into the store. Returns count inserted."""
    with open(seed_path, "r") as f:
        seeds = json.load(f)

    count = 0
    now = datetime.now(timezone.utc)
    for item in seeds:
        offset = item.get("reported_at_offset_minutes", 0)
        reported = (now + timedelta(minutes=offset)).isoformat()
        cat = item["severity_category"]
        insert_incident(
            raw_text=item["raw_text"],
            severity_category=cat,
            s_base=s_base_lookup.get(cat, 0.5),
            confidence=item.get("confidence", 0.8),
            location_text=item.get("location_text"),
            lat=item.get("lat"),
            lng=item.get("lng"),
            geocode_status="seeded",
            inhibitor_status="passed",
            reported_at=reported,
        )
        count += 1
    return count


def incident_count() -> int:
    conn = get_conn()
    row = conn.execute("SELECT COUNT(*) as cnt FROM incidents").fetchone()
    return row["cnt"]


def inhibitor_stats() -> dict:
    """Return counts by inhibitor_status for the transparency page."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT inhibitor_status, COUNT(*) as cnt FROM incidents GROUP BY inhibitor_status"
    ).fetchall()
    return {row["inhibitor_status"]: row["cnt"] for row in rows}
