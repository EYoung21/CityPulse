from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from philly_pulse import (
    auto_verify,
    firestore_store,
    geocode,
    persistence,
    prefilter,
    server,
    store as sqlite_store,
    weights,
)


class FakeDoc:
    def __init__(self, doc_id: str, data: dict):
        self.id = doc_id
        self._data = data

    def to_dict(self):
        return dict(self._data)


class FakeQuery:
    def __init__(self, rows: list[FakeDoc]):
        self.rows = rows
        self.calls: list[tuple] = []

    def where(self, *args, **kwargs):
        if "filter" in kwargs:
            field_filter = kwargs["filter"]
            args = (
                field_filter.field_path,
                field_filter.op_string,
                field_filter.value,
            )
        self.calls.append(("where", args))
        return self

    def order_by(self, *args, **kwargs):
        self.calls.append(("order_by", args, kwargs))
        return self

    def limit(self, n):
        self.calls.append(("limit", n))
        return self

    def stream(self):
        return iter(self.rows)


class FakeDb:
    def __init__(self, query: FakeQuery):
        self.query = query

    def collection(self, name: str):
        assert name == "incidents"
        return self.query


def test_firestore_rows_replace_nested_non_finite_numbers() -> None:
    row = firestore_store._doc_to_row(
        "incident-1",
        {
            "lat": float("nan"),
            "mentions": [{"confidence": float("inf")}],
        },
    )

    assert row == {
        "id": "incident-1",
        "lat": None,
        "mentions": [{"confidence": None}],
    }


def test_firestore_timestamps_use_one_sortable_utc_representation() -> None:
    assert firestore_store._canonical_utc_iso(
        "2026-07-20T06:30:00-04:00"
    ) == "2026-07-20T10:30:00+00:00"
    assert firestore_store._canonical_utc_iso(
        "2026-07-20T10:30:00Z"
    ) == "2026-07-20T10:30:00+00:00"
    with pytest.raises(ValueError):
        firestore_store._canonical_utc_iso("not-a-timestamp")


def test_weight_calculation_survives_malformed_numeric_fields() -> None:
    reported_at = "2026-01-01T00:00:00+00:00"
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)

    assert weights.compute_w_eff("bad", reported_at, float("nan"), now=now) == 0.5
    assert weights.compute_w_eff(float("inf"), reported_at, "bad", now=now) == 0.5


def test_sqlite_city_adapter_does_not_query_a_missing_city_column(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setattr(sqlite_store, "DB_PATH", str(tmp_path / "citypulse.sqlite"))
    monkeypatch.setattr(sqlite_store, "_conn", None)
    sqlite_store.insert_incident(
        incident_id="sqlite-city-row",
        raw_text="test",
        severity_category="medical_other",
        s_base=0.5,
        confidence=0.8,
        reported_at="2099-01-01T00:00:00+00:00",
    )

    rows = sqlite_store.list_incidents_for_city("philly", limit=20)

    assert [row["id"] for row in rows] == ["sqlite-city-row"]
    assert sqlite_store._conn is not None
    sqlite_store._conn.close()
    sqlite_store._conn = None


def test_auto_store_selection_honors_firestore_emulator(monkeypatch) -> None:
    monkeypatch.delenv("PHILLY_PULSE_STORE", raising=False)
    monkeypatch.delenv("GOOGLE_APPLICATION_CREDENTIALS", raising=False)
    monkeypatch.delenv("FIREBASE_SERVICE_ACCOUNT_JSON", raising=False)
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080")

    assert persistence._should_use_firestore() is True


def test_firestore_find_latest_city_incidents_filters_and_queries(monkeypatch):
    query = FakeQuery(
        [
            FakeDoc("visible", {"city": "philly", "reported_at": "2026-01-03", "severity_category": "violent_weapon"}),
            FakeDoc("blocked", {"city": "philly", "reported_at": "2026-01-02", "inhibitor_status": "blocked"}),
            FakeDoc("hidden", {"city": "philly", "reported_at": "2026-01-01", "hidden": True}),
        ]
    )
    monkeypatch.setattr(firestore_store, "_ensure_client", lambda: FakeDb(query))

    rows = firestore_store.find_latest_city_incidents(
        "philly",
        severity_category="violent_weapon",
        since_iso="2026-01-01T00:00:00Z",
        before_iso="2026-02-01T00:00:00Z",
        limit=5,
    )

    assert [r["id"] for r in rows] == ["visible"]
    assert ("where", ("city", "==", "philly")) in query.calls
    assert ("where", ("severity_category", "==", "violent_weapon")) in query.calls
    assert ("where", ("reported_at", ">=", "2026-01-01T00:00:00Z")) in query.calls
    assert ("where", ("reported_at", "<", "2026-02-01T00:00:00Z")) in query.calls
    assert ("limit", 5) in query.calls


def test_firestore_city_page_filters_before_limit_and_fills_visible_rows(monkeypatch):
    query = FakeQuery(
        [
            FakeDoc("blocked", {"inhibitor_status": "blocked", "severity_category": "shots_heard"}),
            FakeDoc("hidden", {"hidden": True, "severity_category": "shots_heard"}),
            FakeDoc("visible-2", {"severity_category": "shots_heard", "reported_at": "2026-01-02"}),
            FakeDoc("visible-1", {"severity_category": "shots_heard", "reported_at": "2026-01-01"}),
        ]
    )
    monkeypatch.setattr(firestore_store, "_ensure_client", lambda: FakeDb(query))

    rows = firestore_store.list_incidents_for_city(
        "philly", category="shots_heard", limit=2
    )

    assert [row["id"] for row in rows] == ["visible-2", "visible-1"]
    category_call = ("where", ("severity_category", "==", "shots_heard"))
    assert category_call in query.calls
    assert query.calls.index(category_call) < next(
        i for i, call in enumerate(query.calls) if call[0] == "limit"
    )


def test_firestore_public_read_failure_propagates(monkeypatch):
    class FailingQuery(FakeQuery):
        def stream(self):
            raise RuntimeError("database unavailable")

    query = FailingQuery([])
    monkeypatch.setattr(firestore_store, "_ensure_client", lambda: FakeDb(query))

    with pytest.raises(RuntimeError, match="database unavailable"):
        firestore_store.list_incidents(
            since="2026-01-01T00:00:00+00:00", category="shots_heard"
        )


def test_pulse_find_latest_tool_overfetches_and_keyword_filters(monkeypatch):
    captured = {}

    def fake_find_latest_city_incidents(city_slug, *, severity_category, since_iso, before_iso, limit):
        captured.update(
            city_slug=city_slug,
            severity_category=severity_category,
            since_iso=since_iso,
            before_iso=before_iso,
            limit=limit,
        )
        return [
            {"id": "nope", "reported_at": "2026-01-03", "severity_category": "violent_weapon", "raw_text": "weapon recovered"},
            {"id": "hit", "reported_at": "2026-01-02", "severity_category": "violent_weapon", "raw_text": "shooting near market"},
        ]

    monkeypatch.setattr(server.store, "find_latest_city_incidents", fake_find_latest_city_incidents)

    out = server._pulse_tool_exec_find_latest(
        city_slug="philly",
        effective_since="2026-01-01T00:00:00Z",
        args={"severity_category": "violent_weapon", "keywords": "shooting", "limit": 1, "before": "2026-02-01T00:00:00Z"},
    )

    assert captured == {
        "city_slug": "philly",
        "severity_category": "violent_weapon",
        "since_iso": "2026-01-01T00:00:00Z",
        "before_iso": "2026-02-01T00:00:00+00:00",
        "limit": 60,
    }
    assert out["match_count"] == 1
    assert out["incidents"][0]["id"] == "hit"


def test_ttl_cache_expiry_and_bounding(monkeypatch):
    server._TTL_CACHES.clear()
    clock = SimpleNamespace(now=100.0)
    monkeypatch.setattr(server.time, "monotonic", lambda: clock.now)

    server._ttl_put("unit", "a", {"ok": True}, ttl=5)
    assert server._ttl_get("unit", "a") == {"ok": True}
    clock.now = 106.0
    assert server._ttl_get("unit", "a") is None

    server._TTL_CACHES["bounded"] = {i: (0.0, i) for i in range(129)}
    server._ttl_put("bounded", "fresh", 1, ttl=10)
    assert list(server._TTL_CACHES["bounded"].keys()) == ["fresh"]


def test_pulse_count_tool_clamps_to_user_window(monkeypatch):
    captured = {}

    def fake_count(city_slug, *, since_iso, until_iso, severity_category):
        captured.update(
            city_slug=city_slug,
            since_iso=since_iso,
            until_iso=until_iso,
            severity_category=severity_category,
        )
        return 7

    monkeypatch.setattr(server.store, "count_city_incidents_filtered", fake_count)

    out = server._pulse_tool_exec_count(
        city_slug="philly",
        effective_since="2026-01-02T00:00:00Z",
        args={
            "since": "2025-01-01T00:00:00Z",
            "until": "2026-01-03T00:00:00Z",
            "severity_category": "traffic_crash_injury",
        },
    )

    assert out["count"] == 7
    assert out["clamped_to_user_window"] is True
    assert captured == {
        "city_slug": "philly",
        "since_iso": "2026-01-02T00:00:00+00:00",
        "until_iso": "2026-01-03T00:00:00+00:00",
        "severity_category": "traffic_crash_injury",
    }


def test_pulse_count_tool_reports_unavailable(monkeypatch):
    monkeypatch.setattr(server.store, "count_city_incidents_filtered", lambda *args, **kwargs: -1)
    out = server._pulse_tool_exec_count(city_slug="philly", effective_since=None, args={})
    assert out["error"] == "count_unavailable"


def test_geocode_helpers_normalize_reject_vague_and_extract_crash_cross_streets():
    assert (
        geocode.normalize_location_text_for_geocode(
            "  Broad Ave. and Pine Rd.  ",
            suffix="Philadelphia, PA",
        )
        == "Broad Ave and Pine Rd"
    )
    assert geocode._is_too_vague("Walmart", ", Chattanooga, TN") is True
    assert geocode.transcript_geocode_candidates(
        "Two vehicle crash at 8th Avenue and 42nd Street with injury",
        city="nyc",
    )[:2] == ["8 Avenue and 42 Street", "42 Street and 8 Avenue"]


def test_prefilter_keeps_crashes_but_skips_empty():
    prefilter.reset_metrics()
    assert prefilter.is_dispatch_likely("", city="philly") == (False, "empty")
    keep, reason = prefilter.is_dispatch_likely(
        "radio check, traffic crash with injuries at broad and pine",
        city="philly",
    )
    assert keep is True
    assert reason is None
    assert prefilter.get_metrics()["philly"]["seen"] == 2


def test_auto_verify_crash_category_signals_pass_and_conflicts_warn():
    result = auto_verify.run_rules(
        {
            "raw_text": "MVA crash with injuries and entrapment at Broad and Pine",
            "severity_category": "traffic_crash_injury",
            "s_base": 0.55,
            "confidence": 0.8,
            "location_text": "Broad and Pine",
            "geocode_status": "success_direct",
            "lat": 39.95,
        }
    )
    assert result.auto_status in {"pass", "warn"}
    assert not any(f.id == "strong_keyword_conflict" for f in result.flags)

    mismatch = auto_verify.run_rules(
        {
            "raw_text": "MVA crash accident collision with injuries at Broad and Pine",
            "severity_category": "medical_other",
            "s_base": 0.35,
            "confidence": 0.9,
            "location_text": "Broad and Pine",
            "geocode_status": "success_direct",
            "lat": 39.95,
        }
    )
    assert any(f.id == "strong_keyword_conflict" for f in mismatch.flags)
