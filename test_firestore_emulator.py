"""Firestore transaction integration checks (opt-in; requires emulator)."""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor

import pytest
from google.auth.credentials import AnonymousCredentials
from google.cloud import firestore

from philly_pulse import firestore_store, push, server


pytestmark = pytest.mark.skipif(
    not os.environ.get("FIRESTORE_EMULATOR_HOST"),
    reason="Firestore emulator is not running",
)


@pytest.fixture()
def emulator_db(monkeypatch):
    db = firestore.Client(
        project="demo-citypulse",
        credentials=AnonymousCredentials(),
    )
    monkeypatch.setattr(firestore_store, "_db", db)
    monkeypatch.setattr(push, "_db", lambda: db)
    yield db
    for collection_name in (
        "incidents",
        "incident_word_timings",
        "extractions",
        "pushSubscriptions",
        "keywordWatches",
        "commuteSchedules",
    ):
        for snapshot in db.collection(collection_name).stream():
            snapshot.reference.delete()
    db.close()


def test_incident_and_extraction_retries_are_idempotent(emulator_db) -> None:
    mention = {
        "at": "2026-07-20T12:00:00+00:00",
        "feed_id": "4603",
        "audio_clip": "abcdef123456",
        "raw_text": "shots fired at Broad and Pine",
        "confidence": 0.8,
        "severity_category": "shots_heard",
        "s_base": 0.8,
    }
    kwargs = {
        "incident_id": "qa-incident-idempotent",
        "raw_text": mention["raw_text"],
        "severity_category": "shots_heard",
        "s_base": 0.8,
        "confidence": 0.8,
        "lat": 39.95,
        "lng": -75.16,
        "reported_at": mention["at"],
        "city": "philly",
        "mentions": [mention],
    }
    first = firestore_store.insert_incident(**kwargs)
    retry = firestore_store.insert_incident(**{**kwargs, "raw_text": "changed"})
    assert first["_was_created"] is True
    assert retry["_was_created"] is False
    assert retry["raw_text"] == mention["raw_text"]

    duplicate = firestore_store.append_mention(first["id"], mention)
    assert duplicate and duplicate["_mention_added"] is False
    assert duplicate["mention_count"] == 1
    for index in range(30):
        update = {
            **mention,
            "at": f"2026-07-20T12:{index + 1:02d}:00+00:00",
            "raw_text": f"update {index}",
        }
        appended = firestore_store.append_mention(first["id"], update)
        assert appended and appended["_mention_added"] is True
    stored = firestore_store.get_incident(first["id"])
    assert stored and stored["mention_count"] == 31
    assert len(stored["mentions"]) == 25

    emulator_db.collection("incidents").document("qa-philly-blocked").set({
        "city": "philly",
        "inhibitor_status": "blocked",
    })
    emulator_db.collection("incidents").document("qa-sf-passed").set({
        "city": "sf",
        "inhibitor_status": "passed",
    })
    assert firestore_store.city_incident_count("philly") == 2
    assert firestore_store.city_incident_count("sf") == 1
    assert firestore_store.city_inhibitor_stats("philly") == {
        "passed": 1,
        "blocked": 1,
    }
    assert firestore_store.city_inhibitor_stats("sf") == {
        "passed": 1,
        "blocked": 0,
    }

    extraction = firestore_store.insert_extraction(
        extraction_id="qa-extraction-idempotent",
        feed_id="4603",
        raw_text="first payload",
    )
    extraction_retry = firestore_store.insert_extraction(
        extraction_id="qa-extraction-idempotent",
        feed_id="4603",
        raw_text="second payload",
    )
    assert extraction["raw_text"] == "first payload"
    assert extraction_retry["raw_text"] == "first payload"


def test_notification_and_commute_leases_are_single_winner(emulator_db) -> None:
    endpoint = "https://updates.push.services.mozilla.com/wpush/v2/qa-citypulse"
    subscription = push.PushSubscription(
        endpoint=endpoint,
        p256dh="key-one",
        auth="auth-one",
        uid="qa-user",
        created_at_ms=100,
        last_used_ms=10,
    )
    document_id = push.upsert_subscription(subscription)
    ref = emulator_db.collection("pushSubscriptions").document(document_id)
    ref.update({"lastNearbyPushMs": 123, "lastNewsroomPushMs": 456})
    push.upsert_subscription(
        push.PushSubscription(
            endpoint=endpoint,
            p256dh="key-two",
            auth="auth-two",
            uid="qa-user",
            created_at_ms=200,
            last_used_ms=20,
        )
    )
    preserved = ref.get().to_dict() or {}
    assert preserved["createdAtMs"] == 100
    assert preserved["lastNearbyPushMs"] == 123
    assert preserved["lastNewsroomPushMs"] == 456
    assert preserved["p256dh"] == "key-two"

    ref.update({"lastNearbyPushMs": 0})
    now_ms = 1_784_560_000_000
    with ThreadPoolExecutor(max_workers=8) as pool:
        tokens = list(
            pool.map(
                lambda _: push._claim_delivery_cooldown(
                    "pushSubscriptions",
                    document_id,
                    last_field="lastNearbyPushMs",
                    claim_prefix="nearby",
                    now_ms=now_ms,
                    cooldown_ms=300_000,
                ),
                range(8),
            )
        )
    winners = [token for token in tokens if token]
    assert len(winners) == 1
    assert push._finish_delivery_cooldown(
        "pushSubscriptions",
        document_id,
        last_field="lastNearbyPushMs",
        claim_prefix="nearby",
        now_ms=now_ms,
        claim_token=winners[0],
    )

    commute_ref = emulator_db.collection("commuteSchedules").document("qa-commute")
    commute_ref.set({"uid": "qa-user", "updatedAt": now_ms})
    with ThreadPoolExecutor(max_workers=4) as pool:
        commute_tokens = list(
            pool.map(
                lambda _: push._claim_commute_fire(
                    commute_ref.id, "2026-07-20", now_ms
                ),
                range(4),
            )
        )
    commute_winners = [token for token in commute_tokens if token]
    assert len(commute_winners) == 1
    assert push._finish_commute_fire(
        commute_ref.id,
        "2026-07-20",
        now_ms,
        commute_winners[0],
    )


def test_keyword_watch_limit_survives_concurrent_creates(emulator_db) -> None:
    def create(uid: str, keyword: str):
        return server._create_keyword_watch_atomic(
            uid,
            keyword,
            {
                "uid": uid,
                "keyword": keyword,
                "city": "philly",
                "severityFloor": 0.0,
                "active": True,
                "createdAtMs": 1,
                "lastFiredMs": 0,
            },
        )

    with ThreadPoolExecutor(max_workers=10) as pool:
        same_results = list(pool.map(lambda _: create("same-user", "shots"), range(10)))
    assert [status for status, _ in same_results].count("created") == 1
    assert [status for status, _ in same_results].count("duplicate") == 9

    with ThreadPoolExecutor(max_workers=12) as pool:
        limit_results = list(
            pool.map(
                lambda index: create("limit-user", f"keyword-{index}"),
                range(35),
            )
        )
    assert [status for status, _ in limit_results].count("created") == 25
    assert [status for status, _ in limit_results].count("limit") == 10
