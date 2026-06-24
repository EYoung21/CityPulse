"""Select SQLite or Firestore backend via PHILLY_PULSE_STORE and credentials."""

from __future__ import annotations

import os
from pathlib import Path


def _should_use_firestore() -> bool:
    mode = os.environ.get("PHILLY_PULSE_STORE", "auto").lower()
    if mode in ("firestore", "true", "1", "yes"):
        return True
    if mode in ("sqlite", "false", "0", "no"):
        return False
    cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    json_str = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    if json_str:
        return True
    if cred_path and Path(cred_path).is_file():
        return True
    return False


if _should_use_firestore():
    from .firestore_store import (
        append_mention,
        count_city_incidents,
        count_city_incidents_filtered,
        delete_incident,
        find_latest_city_incidents,
        find_recent_duplicate,
        get_conn,
        get_extraction,
        get_incident,
        get_recent_extractions,
        get_word_timings,
        incident_count,
        inhibitor_stats,
        insert_extraction,
        insert_incident,
        list_incidents,
        list_incidents_for_city,
        get_city_pipeline_freshness,
        seed_from_json,
        update_extraction,
        update_incident,
    )
else:
    from .store import (
        append_mention,
        count_city_incidents,
        count_city_incidents_filtered,
        find_recent_duplicate,
        get_conn,
        get_extraction,
        get_incident,
        get_recent_extractions,
        incident_count,
        inhibitor_stats,
        insert_extraction,
        insert_incident,
        list_incidents,
        list_incidents_for_city,
        get_city_pipeline_freshness,
        seed_from_json,
        update_extraction,
    )

    def get_word_timings(incident_id):  # type: ignore[misc]
        # SQLite keeps word_timings inline on the incident row.
        inc = get_incident(incident_id)
        return (inc or {}).get("word_timings")

    def find_latest_city_incidents(  # type: ignore[misc]
        slug,
        *,
        severity_category=None,
        since_iso=None,
        before_iso=None,
        limit=25,
    ):
        # Dev SQLite fallback: list_incidents_for_city already filters by
        # category and orders newest-first; over-fetch then slice.
        rows = list_incidents_for_city(
            slug,
            since=since_iso,
            category=severity_category,
            before_iso=before_iso,
            limit=max(int(limit), 200),
        )
        return rows[: int(limit)]

    def update_incident(incident_id, updates):  # type: ignore[misc]
        raise NotImplementedError("update_incident not supported in SQLite mode")

    def delete_incident(incident_id):  # type: ignore[misc]
        raise NotImplementedError("delete_incident not supported in SQLite mode")
