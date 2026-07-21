import asyncio
import base64
import hashlib
import io
import json
import re
import time
import wave
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import BackgroundTasks, HTTPException, Response
from pydantic import ValidationError

from philly_pulse import server


def _test_wav_bytes(sample_count: int = 160) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16_000)
        wav.writeframes(b"\x00\x00" * sample_count)
    return output.getvalue()


def setup_function() -> None:
    server._ADMIN_TICKETS.clear()
    server._TOKEN_CACHE.clear()
    server._TIER_CACHE.clear()
    server._TTL_CACHES.clear()
    server.push_mod._PREFS_CACHE.clear()
    server.push_mod._USER_TIER_CACHE.clear()


def _run_asgi_request(
    middleware,
    *,
    path: str,
    chunks: list[bytes],
    content_length: bytes | None = None,
) -> list[dict]:
    sent: list[dict] = []
    messages = [
        {
            "type": "http.request",
            "body": chunk,
            "more_body": index < len(chunks) - 1,
        }
        for index, chunk in enumerate(chunks)
    ]

    async def receive() -> dict:
        return messages.pop(0)

    async def send(message: dict) -> None:
        sent.append(message)

    headers = [] if content_length is None else [(b"content-length", content_length)]
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": headers,
        "client": ("127.0.0.1", 1234),
        "server": ("test", 80),
    }
    asyncio.run(middleware(scope, receive, send))
    return sent


def test_request_body_limit_rejects_declared_oversize_before_route() -> None:
    called = False

    async def downstream(_scope, _receive, _send) -> None:
        nonlocal called
        called = True

    messages = _run_asgi_request(
        server.RequestBodyLimitMiddleware(downstream),
        path="/api/feedback",
        chunks=[b""],
        content_length=str(server._DEFAULT_REQUEST_BODY_LIMIT_BYTES + 1).encode(),
    )

    assert called is False
    assert messages[0]["status"] == 413
    assert b"Request body too large" in messages[1]["body"]


def test_request_body_limit_counts_chunked_requests() -> None:
    async def downstream(_scope, receive, _send) -> None:
        while True:
            message = await receive()
            if not message.get("more_body"):
                break

    half_limit = server._DEFAULT_REQUEST_BODY_LIMIT_BYTES // 2
    messages = _run_asgi_request(
        server.RequestBodyLimitMiddleware(downstream),
        path="/api/feedback",
        chunks=[b"a" * half_limit, b"b" * (half_limit + 1)],
    )

    assert messages[0]["status"] == 413


def test_request_body_limit_allows_larger_ingest_payloads() -> None:
    received = 0

    async def downstream(_scope, receive, send) -> None:
        nonlocal received
        while True:
            message = await receive()
            received += len(message.get("body", b""))
            if not message.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    payload_size = server._DEFAULT_REQUEST_BODY_LIMIT_BYTES + 1
    messages = _run_asgi_request(
        server.RequestBodyLimitMiddleware(downstream),
        path="/api/ingest",
        chunks=[b"a" * payload_size],
        content_length=str(payload_size).encode(),
    )

    assert received == payload_size
    assert messages[0]["status"] == 204


def test_admin_ticket_is_one_shot_and_scope_limited() -> None:
    ticket = server._mint_admin_ticket({"uid": "admin-1"}, "stream", "4603")

    assert not server._consume_admin_ticket(ticket, "stream", "17310")
    assert not server._consume_admin_ticket(ticket, "stream", "4603")

    ticket = server._mint_admin_ticket({"uid": "admin-1"}, "stream", "4603")
    assert server._consume_admin_ticket(ticket, "stream", "4603")
    assert not server._consume_admin_ticket(ticket, "stream", "4603")


def test_admin_ticket_rejects_expiry() -> None:
    ticket = server._mint_admin_ticket({"uid": "admin-1"}, "ws")
    digest = server._admin_ticket_digest(ticket)
    expires_at, purpose, resource, uid = server._ADMIN_TICKETS[digest]
    server._ADMIN_TICKETS[digest] = (time.monotonic() - 1, purpose, resource, uid)

    assert not server._consume_admin_ticket(ticket, "ws")


def test_raw_audio_ticket_is_bound_to_one_clip() -> None:
    ticket = server._mint_admin_ticket(
        {"uid": "admin-1"}, "raw_audio", "abcdef123456"
    )

    assert not server._consume_admin_ticket(ticket, "raw_audio", "123456abcdef")
    assert not server._consume_admin_ticket(ticket, "raw_audio", "abcdef123456")


def test_admin_stream_keeps_credentials_out_of_url_and_process_args(monkeypatch) -> None:
    feed_id = server.FEEDS[0]["feed_id"]
    ticket = server._mint_admin_ticket({"uid": "admin-1"}, "stream", feed_id)
    monkeypatch.setattr(server, "_bf_username", "user:name")
    monkeypatch.setattr(server, "_bf_password", "secret/password")
    captured: dict = {}

    class FakeUpstream:
        status_code = 200
        headers = {"content-type": "audio/mpeg"}

        async def aiter_bytes(self, _size):
            yield b"mp3-data"

        async def aclose(self):
            captured["upstream_closed"] = True

    class FakeClient:
        def __init__(self, **kwargs):
            captured["auth"] = kwargs.get("auth")

        def build_request(self, method, url):
            captured["method"] = method
            captured["url"] = url
            return object()

        async def send(self, _request, *, stream):
            captured["stream"] = stream
            return FakeUpstream()

        async def aclose(self):
            captured["client_closed"] = True

    monkeypatch.setattr(server.httpx, "AsyncClient", FakeClient)

    response = asyncio.run(server.admin_stream(feed_id, ticket))

    async def consume() -> bytes:
        return b"".join([chunk async for chunk in response.body_iterator])

    assert asyncio.run(consume()) == b"mp3-data"
    assert captured["auth"] == ("user:name", "secret/password")
    assert captured["url"] == f"https://audio.broadcastify.com/{feed_id}.mp3"
    assert "secret" not in captured["url"]
    assert captured["upstream_closed"] is True
    assert captured["client_closed"] is True


def test_admin_verification_checks_revocation(monkeypatch) -> None:
    from firebase_admin import auth as firebase_auth

    calls: list[tuple[str, bool]] = []

    def verify(token: str, check_revoked: bool = False) -> dict:
        calls.append((token, check_revoked))
        return {
            "uid": "admin-1",
            "email": "eliyoung4now@gmail.com",
            "email_verified": True,
        }

    monkeypatch.setattr(firebase_auth, "verify_id_token", verify)

    decoded = server._verify_firebase_admin("Bearer current-token")
    assert decoded["uid"] == "admin-1"
    assert calls == [("current-token", True)]


def test_ingest_authentication_fails_closed_when_unconfigured(monkeypatch) -> None:
    monkeypatch.setattr(server, "_PULSE_INGEST_SECRET", None)
    monkeypatch.setattr(server, "_INGEST_SECRET_WARNED", False)

    with pytest.raises(HTTPException) as exc:
        server._verify_ingest_secret(None)
    assert exc.value.status_code == 503


def test_ingest_authentication_rejects_mismatch_and_accepts_secret(monkeypatch) -> None:
    monkeypatch.setattr(server, "_PULSE_INGEST_SECRET", "scanner-secret")

    with pytest.raises(HTTPException) as exc:
        server._verify_ingest_secret("Bearer wrong")
    assert exc.value.status_code == 401

    server._verify_ingest_secret("Bearer scanner-secret")


def test_timestamp_epoch_supports_firestore_datetime_and_milliseconds() -> None:
    expiry = datetime.now(timezone.utc) + timedelta(hours=72)
    assert server._timestamp_epoch(expiry) == pytest.approx(expiry.timestamp())
    assert server._timestamp_epoch(expiry.timestamp() * 1000) == pytest.approx(
        expiry.timestamp()
    )
    assert server._timestamp_epoch(float("nan")) is None


def test_user_tier_honors_active_temporary_pass(monkeypatch) -> None:
    from philly_pulse import firestore_store

    expiry = datetime.now(timezone.utc) + timedelta(seconds=30)

    class Snapshot:
        exists = True

        @staticmethod
        def to_dict() -> dict:
            return {"tier": "free", "proUntil": expiry}

    class Document:
        @staticmethod
        def get() -> Snapshot:
            return Snapshot()

    class Collection:
        @staticmethod
        def document(_uid: str) -> Document:
            return Document()

    class Database:
        @staticmethod
        def collection(_name: str) -> Collection:
            return Collection()

    monkeypatch.setattr(firestore_store, "_ensure_client", lambda: Database())
    server._TIER_CACHE.clear()

    assert server._user_tier("pass-user") == "pro"
    cache_expires, cached_tier = server._TIER_CACHE["pass-user"]
    assert cached_tier == "pro"
    assert cache_expires <= expiry.timestamp()


def test_route_directions_rejects_bad_modes_and_coordinates() -> None:
    with pytest.raises(HTTPException) as mode_exc:
        asyncio.run(
            server.route_directions(
                server.RouteDirectionsRequest(
                    waypoints=[[39.95, -75.16], [39.96, -75.17]],
                    mode="teleport",
                )
            )
        )
    assert mode_exc.value.status_code == 400

    with pytest.raises(HTTPException) as coord_exc:
        asyncio.run(
            server.route_directions(
                server.RouteDirectionsRequest(
                    waypoints=[[91, -75.16], [39.96, -75.17]],
                    mode="foot-walking",
                )
            )
        )
    assert coord_exc.value.status_code == 400


def test_route_directions_rejects_malformed_upstream_geometry(monkeypatch) -> None:
    class FakeResponse:
        status_code = 200
        headers: dict[str, str] = {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def aiter_bytes(self):
            yield json.dumps({
                "code": "Ok",
                "routes": [{
                    "geometry": {"coordinates": [[-75.16, 39.95], [999, 39.96]]},
                    "distance": 1000,
                    "duration": 600,
                }],
            }).encode()

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        def stream(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setattr(server.httpx, "AsyncClient", lambda **_kwargs: FakeClient())
    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            server.route_directions(
                server.RouteDirectionsRequest(
                    waypoints=[[39.95, -75.16], [39.96, -75.17]],
                    mode="foot-walking",
                )
            )
        )
    assert exc.value.status_code == 502


def test_route_response_stream_is_bounded(monkeypatch) -> None:
    class FakeResponse:
        def __init__(self, chunks: list[bytes], content_length: str | None = None):
            self.headers = {} if content_length is None else {"content-length": content_length}
            self._chunks = chunks

        async def aiter_bytes(self):
            for chunk in self._chunks:
                yield chunk

    monkeypatch.setattr(server, "_MAX_ROUTE_RESPONSE_BYTES", 8)

    with pytest.raises(HTTPException) as declared:
        asyncio.run(server._read_bounded_route_response(FakeResponse([], "9")))
    assert declared.value.status_code == 502

    with pytest.raises(HTTPException) as streamed:
        asyncio.run(server._read_bounded_route_response(FakeResponse([b"12345", b"6789"])))
    assert streamed.value.status_code == 502


def test_pulse_chat_request_bounds_conversation_shape() -> None:
    with pytest.raises(ValidationError):
        server.PulseChatRequest(
            messages=[
                server.PulseChatMessage(role="user", content="ok")
                for _ in range(501)
            ]
        )

    with pytest.raises(ValidationError):
        server.PulseChatMessage(role="user", content="x" * 12_001)


def test_push_subscription_rejects_radius_without_coordinates(monkeypatch) -> None:
    monkeypatch.setattr(
        server,
        "_verify_firebase_token",
        lambda _auth: {"uid": "user-1"},
    )
    monkeypatch.setattr(
        server.push_mod,
        "is_safe_push_endpoint",
        lambda *_args, **_kwargs: pytest.fail("DNS validation should not run"),
    )

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            server.push_subscribe(
                server.PushSubscribeRequest(
                    endpoint="https://push.example/token",
                    p256dh="a" * 40,
                    auth="b" * 8,
                    notifyRadiusKm=3.0,
                ),
                authorization="Bearer test",
            )
        )

    assert exc.value.status_code == 400
    assert "coordinates" in str(exc.value.detail).lower()


def test_incident_page_skips_malformed_rows_and_sorts_real_timestamps(monkeypatch) -> None:
    monkeypatch.setattr(server, "_try_verify_firebase_token", lambda _auth: {"uid": "pro"})
    monkeypatch.setattr(server, "_is_pro_uid", lambda _decoded: True)
    monkeypatch.setattr(
        server.store,
        "list_incidents_for_city",
        lambda *_args, **_kwargs: [
            None,
            {
                "id": "older",
                "reported_at": "2026-07-20T10:15:00Z",
                "severity_category": "disorder",
            },
            {
                "id": "newer",
                "reported_at": "2026-07-20T06:30:00-04:00",
                "severity_category": "disorder",
            },
        ],
    )

    result = server.page_incidents(
        Response(),
        cursor=None,
        limit=20,
        since="2026-07-20T00:00:00Z",
        category=None,
        city=server.CITY_SLUG,
        near_lat=None,
        near_lng=None,
        authorization="Bearer test",
    )

    assert [row["id"] for row in result["incidents"]] == ["newer", "older"]


def test_incident_search_compares_iso_instants_not_timestamp_strings(monkeypatch) -> None:
    monkeypatch.setattr(server, "_try_verify_firebase_token", lambda _auth: {"uid": "pro"})
    monkeypatch.setattr(server, "_is_pro_uid", lambda _decoded: True)
    monkeypatch.setattr(
        server.store,
        "list_incidents_for_city",
        lambda *_args, **_kwargs: [
            None,
            {
                "id": "same-instant",
                "reported_at": "2026-07-20T10:30:00Z",
                "severity_category": "disorder",
                "raw_text": "alarm sounding",
            },
            {
                "id": "later",
                "reported_at": "2026-07-20T10:31:00Z",
                "severity_category": "disorder",
                "raw_text": "alarm sounding",
            },
        ],
    )

    result = server.search_incidents(
        Response(),
        q="alarm",
        since="2026-07-20T00:00:00Z",
        until="2026-07-20T06:30:00-04:00",
        category=None,
        limit=50,
        city=server.CITY_SLUG,
        authorization="Bearer test",
    )

    assert [row["id"] for row in result["results"]] == ["same-instant"]


def test_pulse_tools_validate_limits_and_compare_iso_instants(monkeypatch) -> None:
    pool = {
        "same": {
            "id": "same",
            "reported_at": "2026-07-20T10:30:00Z",
            "severity_category": "disorder",
        },
        "later": {
            "id": "later",
            "reported_at": "2026-07-20T10:31:00Z",
            "severity_category": "disorder",
        },
    }
    search = server._pulse_tool_exec_search(
        pool,
        {
            "until_reported_at": "2026-07-20T06:30:00-04:00",
            "limit": {"malformed": True},
        },
    )
    assert [row["id"] for row in search["incidents"]] == ["same"]

    captured: dict = {}

    def count(_city: str, **kwargs) -> int:
        captured.update(kwargs)
        return 2

    monkeypatch.setattr(server.store, "count_city_incidents_filtered", count)
    counted = server._pulse_tool_exec_count(
        city_slug=server.CITY_SLUG,
        effective_since="2026-07-20T10:00:00Z",
        args={"since": "2026-07-20T05:30:00-04:00"},
    )
    assert captured["since_iso"] == "2026-07-20T10:00:00+00:00"
    assert counted["clamped_to_user_window"] is True


def test_best_effort_token_cache_hashes_and_honors_expiry(monkeypatch) -> None:
    from firebase_admin import auth as firebase_auth

    calls: list[str] = []

    def verify(token: str, check_revoked: bool = False) -> dict:
        calls.append(token)
        return {
            "uid": "user-1",
            "exp": time.time() + 1,
        }

    monkeypatch.setattr(firebase_auth, "verify_id_token", verify)

    first = server._try_verify_firebase_token("Bearer reusable-secret-token")
    second = server._try_verify_firebase_token("Bearer reusable-secret-token")

    assert first == second == {"uid": "user-1", "exp": first["exp"]}
    assert calls == ["reusable-secret-token"]
    assert "reusable-secret-token" not in server._TOKEN_CACHE
    digest = hashlib.sha256(b"reusable-secret-token").hexdigest()
    cache_until, _decoded = server._TOKEN_CACHE[digest]
    assert cache_until <= first["exp"]


def test_push_endpoint_rejects_local_and_non_https_destinations(monkeypatch) -> None:
    from philly_pulse import push

    assert not push.is_safe_push_endpoint("http://push.example/path", resolve_dns=False)
    assert not push.is_safe_push_endpoint("https://127.0.0.1/push", resolve_dns=False)
    assert not push.is_safe_push_endpoint("https://[::1]/push", resolve_dns=False)
    assert not push.is_safe_push_endpoint("https://metadata.internal/push", resolve_dns=False)
    assert push.is_safe_push_endpoint("https://fcm.googleapis.com/fcm/send/id", resolve_dns=False)

    monkeypatch.setattr(
        push.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(2, 1, 6, "", ("10.0.0.5", 443))],
    )
    assert not push.is_safe_push_endpoint("https://rebound.example/push", resolve_dns=True)


def test_audio_decoder_checks_encoded_size_and_document_ids() -> None:
    wav_bytes = _test_wav_bytes()
    encoded = base64.b64encode(wav_bytes).decode("ascii")
    assert server._decode_bounded_audio(encoded) == wav_bytes
    assert server._decode_bounded_audio("a" * (server._MAX_AUDIO_B64_CHARS + 1)) is None
    assert server._decode_bounded_audio("not valid base64!") is None
    assert server._decode_bounded_audio(base64.b64encode(b"RIFF-test").decode()) is None

    server._require_document_id("abcdef123456", "incident ID")
    with pytest.raises(HTTPException) as exc:
        server._require_document_id("bad/path", "incident ID")
    assert exc.value.status_code == 400

    with pytest.raises(HTTPException) as exc:
        server._validate_audio_payload(
            {"bad/path": encoded}, raw_suffix_allowed=False
        )
    assert exc.value.status_code == 400


def test_storage_audio_stream_is_bounded_by_declared_and_actual_size(monkeypatch) -> None:
    class FakeResponse:
        def __init__(self, chunks: list[bytes], content_length: str | None = None):
            self.headers = {} if content_length is None else {"content-length": content_length}
            self._chunks = chunks

        async def aiter_bytes(self):
            for chunk in self._chunks:
                yield chunk

    monkeypatch.setattr(server, "_MAX_AUDIO_CLIP_BYTES", 8)

    with pytest.raises(HTTPException) as declared:
        asyncio.run(server._read_bounded_audio_response(FakeResponse([], "9")))
    assert declared.value.status_code == 502

    with pytest.raises(HTTPException) as streamed:
        asyncio.run(
            server._read_bounded_audio_response(
                FakeResponse([b"12345", b"6789"], "not-a-number")
            )
        )
    assert streamed.value.status_code == 502

    assert asyncio.run(
        server._read_bounded_audio_response(FakeResponse([b"1234", b"5678"], "8"))
    ) == b"12345678"


def test_ingest_metadata_is_bounded_before_persistence() -> None:
    with pytest.raises(HTTPException) as exc:
        server._validate_ingest_metadata(
            server.IngestRequest(
                text="scanner transcript",
                preprocess_meta={"padding": "x" * (65 * 1024)},
            )
        )
    assert exc.value.status_code == 413

    with pytest.raises(HTTPException) as exc:
        server._validate_ingest_metadata(
            server.IngestRequest(
                text="scanner transcript",
                variants=[{"name": "standard", "audio_clip": "bad/path"}],
            )
        )
    assert exc.value.status_code == 400

    with pytest.raises(HTTPException) as exc:
        server._validate_ingest_metadata(
            server.IngestRequest(
                text="scanner transcript",
                variants=[{"name": "standard", "padding": "x" * (513 * 1024)}],
            )
        )
    assert exc.value.status_code == 413

def test_collection_mode_durably_saves_private_source_audio(monkeypatch, tmp_path) -> None:
    raw_dir = tmp_path / "raw"
    raw_dir.mkdir()
    monkeypatch.setattr(server, "_RAW_CLIPS_DIR", raw_dir)
    monkeypatch.setattr(server, "_PULSE_INGEST_SECRET", "scanner-secret")
    monkeypatch.setattr(server, "LLM_AUTO_ENABLED", False)
    writes: list[dict] = []
    monkeypatch.setattr(
        server.store,
        "insert_extraction",
        lambda **kwargs: writes.append(kwargs),
    )
    clip_id = "abcdef123456"
    wav_bytes = _test_wav_bytes()
    encoded = base64.b64encode(wav_bytes).decode("ascii")
    request = server.IngestRequest(
        text="scanner transcript",
        city="philly",
        raw_audio_clip=clip_id,
        audio_clip="123456abcdef",
        audio_data={f"{clip_id}_raw": encoded},
        variants=[{"name": "standard", "audio_clip": "123456abcdef"}],
    )

    result = asyncio.run(
        server.ingest(
            request,
            background_tasks=BackgroundTasks(),
            authorization="Bearer scanner-secret",
        )
    )

    assert result["status"] == "collected"
    assert (raw_dir / f"{clip_id}.wav").read_bytes() == wav_bytes
    assert writes[0]["raw_audio_clip"] == clip_id
    assert writes[0]["audio_clip"] is None
    assert writes[0]["variants"][0]["audio_clip"] is None


def test_prefiltered_ingest_durably_saves_private_source_audio(monkeypatch, tmp_path) -> None:
    raw_dir = tmp_path / "raw"
    raw_dir.mkdir()
    monkeypatch.setattr(server, "_RAW_CLIPS_DIR", raw_dir)
    monkeypatch.setattr(server, "_PULSE_INGEST_SECRET", "scanner-secret")
    monkeypatch.setattr(server, "LLM_AUTO_ENABLED", True)
    monkeypatch.setattr(
        server.prefilter, "is_dispatch_likely", lambda *_args, **_kwargs: (False, "noise")
    )
    writes: list[dict] = []
    monkeypatch.setattr(
        server.store, "insert_extraction", lambda **kwargs: writes.append(kwargs)
    )
    clip_id = "abcdef123456"
    wav_bytes = _test_wav_bytes()
    encoded = base64.b64encode(wav_bytes).decode("ascii")
    request = server.IngestRequest(
        text="radio check",
        city="philly",
        timestamp="2026-07-20T06:30:00-04:00",
        segment_start_utc="2026-07-20T06:29:30-04:00",
        raw_audio_clip=clip_id,
        audio_clip="123456abcdef",
        audio_data={f"{clip_id}_raw": encoded},
        variants=[{"name": "standard", "audio_clip": "123456abcdef"}],
    )

    result = asyncio.run(
        server.ingest(
            request,
            background_tasks=BackgroundTasks(),
            authorization="Bearer scanner-secret",
        )
    )

    assert result["status"] == "prefiltered"
    assert (raw_dir / f"{clip_id}.wav").read_bytes() == wav_bytes
    assert writes[0]["raw_audio_clip"] == clip_id
    assert writes[0]["audio_clip"] is None
    assert writes[0]["variants"][0]["audio_clip"] is None
    assert writes[0]["reported_at"] == "2026-07-20T10:30:00+00:00"
    assert writes[0]["segment_start_utc"] == "2026-07-20T10:29:30+00:00"
    assert isinstance(writes[0]["ingest_lag_sec"], float)


def test_ingest_identity_is_stable_for_retries_and_changes_for_new_audio() -> None:
    common = {
        "city": "philly",
        "feed_id": "4603",
        "reported_at": "2026-07-20T12:00:00+00:00",
        "segment_start_utc": "2026-07-20T11:59:30+00:00",
        "audio_clip": "123456abcdef",
        "text": "shots fired at Broad and Pine",
    }
    first = server._stable_ingest_id(
        **common, raw_audio_clip="abcdef123456"
    )
    retry = server._stable_ingest_id(
        **common, raw_audio_clip="abcdef123456"
    )
    next_clip = server._stable_ingest_id(
        **common, raw_audio_clip="fedcba654321"
    )

    assert first == retry
    assert re.fullmatch(r"[a-f0-9]{24}", first)
    assert next_clip != first


def test_retranscribe_request_bounds_expensive_parameters() -> None:
    with pytest.raises(ValidationError):
        server.RetranscribeRequest(extraction_id="abcdef123456", beam_size=1000)
    with pytest.raises(ValidationError):
        server.RetranscribeRequest(
            extraction_id="abcdef123456", vad_aggressiveness=4
        )
    with pytest.raises(ValidationError):
        server.RetranscribeRequest(extraction_id="abcdef123456", highpass_hz=-1)


def test_retranscribe_rejects_invalid_archived_wav(monkeypatch, tmp_path) -> None:
    raw_dir = tmp_path / "raw"
    raw_dir.mkdir()
    clip_id = "abcdef123456"
    (raw_dir / f"{clip_id}.wav").write_bytes(b"not-a-wav")
    monkeypatch.setattr(server, "_RAW_CLIPS_DIR", raw_dir)
    monkeypatch.setattr(
        server.store,
        "get_extraction",
        lambda _eid: {"raw_audio_clip": clip_id, "variants": []},
    )

    with pytest.raises(HTTPException) as exc:
        server._retranscribe_sync(
            server.RetranscribeRequest(extraction_id="abcdef123456")
        )
    assert exc.value.status_code == 400


def test_ingest_rejects_invalid_machine_payload_before_writes(monkeypatch) -> None:
    monkeypatch.setattr(server, "_PULSE_INGEST_SECRET", "scanner-secret")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            server.ingest(
                server.IngestRequest(text="", city="philly"),
                background_tasks=BackgroundTasks(),
                authorization="Bearer scanner-secret",
            )
        )
    assert exc.value.status_code == 400

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            server.ingest(
                server.IngestRequest(text="test", city="typo-city"),
                background_tasks=BackgroundTasks(),
                authorization="Bearer scanner-secret",
            )
        )
    assert exc.value.status_code == 400


def test_incident_reads_reject_invalid_filters_before_store_access() -> None:
    with pytest.raises(HTTPException) as exc:
        server.page_incidents(
            Response(),
            cursor=None,
            limit=20,
            since=None,
            category=None,
            city="philly",
            near_lat=39.95,
            near_lng=None,
            authorization=None,
        )
    assert exc.value.status_code == 400

    with pytest.raises(HTTPException) as exc:
        server.search_incidents(
            Response(),
            q="x" * 201,
            since=None,
            until=None,
            category=None,
            limit=50,
            city=None,
            authorization=None,
        )
    assert exc.value.status_code == 400

    with pytest.raises(HTTPException) as exc:
        server.get_incidents(
            Response(), since="not-a-date", category=None, city=None, authorization=None
        )
    assert exc.value.status_code == 400


def test_incident_read_outage_is_not_misreported_as_empty(monkeypatch) -> None:
    monkeypatch.setattr(server, "_try_verify_firebase_token", lambda _auth: None)

    def fail_read(**_kwargs):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(server.store, "list_incidents_for_city", fail_read)
    with pytest.raises(HTTPException) as exc:
        server.get_incidents(
            Response(), since=None, category=None, city=None, authorization=None
        )
    assert exc.value.status_code == 503


def test_ttl_cache_has_a_hard_size_ceiling() -> None:
    for index in range(server._TTL_CACHE_MAX + 25):
        server._ttl_put("test", index, index, 300)
    assert len(server._TTL_CACHES["test"]) == server._TTL_CACHE_MAX


def test_since_offsets_are_normalized_to_utc() -> None:
    normalized, clamped = server._apply_free_since(
        "2099-01-01T05:00:00+05:00", is_pro=True
    )
    assert normalized == "2099-01-01T00:00:00+00:00"
    assert clamped is False


def test_incident_page_default_uses_configured_free_window(monkeypatch) -> None:
    captured: dict[str, object] = {}
    server._TTL_CACHES.pop("incidents", None)
    monkeypatch.setattr(server, "FREE_INCIDENT_WINDOW_SECONDS", 72 * 60 * 60)
    monkeypatch.setattr(server, "_try_verify_firebase_token", lambda _auth: None)
    monkeypatch.setattr(server, "_is_pro_uid", lambda _decoded: False)

    def load_city(_slug: str, **kwargs):
        captured.update(kwargs)
        return []

    monkeypatch.setattr(server.store, "list_incidents_for_city", load_city)
    before = datetime.now(timezone.utc) - timedelta(hours=72)
    result = server.page_incidents(
        Response(),
        cursor=None,
        limit=20,
        since=None,
        category=None,
        city="philly",
        near_lat=None,
        near_lng=None,
        authorization=None,
    )
    after = datetime.now(timezone.utc) - timedelta(hours=72)

    since = datetime.fromisoformat(str(captured["since"]))
    assert before <= since <= after
    assert result["meta"]["freeWindowSec"] == 72 * 60 * 60


def test_push_tier_honors_temporary_pass(monkeypatch) -> None:
    from philly_pulse import firestore_store, push

    expiry = datetime.now(timezone.utc) + timedelta(minutes=10)

    class Snapshot:
        exists = True

        @staticmethod
        def to_dict() -> dict:
            return {"tier": "free", "proUntil": expiry}

    class Document:
        @staticmethod
        def get() -> Snapshot:
            return Snapshot()

    class Collection:
        @staticmethod
        def document(_uid: str) -> Document:
            return Document()

    class Database:
        @staticmethod
        def collection(_name: str) -> Collection:
            return Collection()

    monkeypatch.setattr(firestore_store, "_ensure_client", lambda: Database())
    assert push._user_tier_for_push("pass-user") == "pro"
    cache_expiry, cached_tier = push._USER_TIER_CACHE["pass-user"]
    assert cached_tier == "pro"
    assert cache_expiry <= expiry.timestamp()


def test_keyword_and_newsroom_fanout_skip_non_pro_users(monkeypatch) -> None:
    from philly_pulse import push

    monkeypatch.setattr(push, "push_available", lambda: True)
    monkeypatch.setattr(push, "_user_tier_for_push", lambda _uid: "free")
    monkeypatch.setattr(
        push,
        "list_active_keyword_watches",
        lambda _city: [{
            "id": "watch-1",
            "uid": "free-user",
            "keyword": "shots",
            "severityFloor": 0,
            "lastFiredMs": 0,
        }],
    )
    monkeypatch.setattr(
        push,
        "find_newsroom_subscriptions",
        lambda _city: [{
            "id": "sub-1",
            "uid": "free-user",
            "notifyNewsroom": True,
            "lastNewsroomPushMs": 0,
        }],
    )
    sends: list[str] = []
    monkeypatch.setattr(
        push,
        "send_to_uid",
        lambda uid, *_args, **_kwargs: sends.append(uid) or {"sent": 1, "failed": 0, "gone": 0},
    )
    monkeypatch.setattr(
        push,
        "send_to_subscription",
        lambda sub, *_args, **_kwargs: sends.append(sub["uid"]) or (True, "ok"),
    )

    keyword = push.notify_keyword_watches(
        incident_id="abcdef123456",
        city="philly",
        raw_text="reports of shots fired",
        severity_category="shots_heard",
        s_base=0.8,
    )
    newsroom = push.notify_newsroom_incident(
        incident_id="abcdef123456",
        city="philly",
        severity_category="shots_heard",
        s_base=0.8,
    )

    assert keyword["not_pro"] == 1
    assert newsroom["not_pro"] == 1
    assert sends == []


def test_push_preferences_fail_closed_on_datastore_outage(monkeypatch) -> None:
    from philly_pulse import push

    push._PREFS_CACHE.clear()

    class BrokenDb:
        def collection(self, _name):
            raise RuntimeError("database unavailable")

    monkeypatch.setattr(push, "_db", lambda: BrokenDb())

    assert push._load_user_prefs("user-1") is None
    assert push._is_quiet_now_for_uid("user-1", "America/New_York") is True
    assert push._is_snoozed_for_uid("user-1") is True
    assert push._is_category_muted_for_uid("user-1", "shots_heard") is True
    assert "user-1" not in push._PREFS_CACHE


def test_malformed_push_preferences_and_subscription_rows_fail_closed(
    monkeypatch,
) -> None:
    from philly_pulse import push

    monkeypatch.setattr(
        push,
        "_load_user_prefs",
        lambda _uid: {
            "pp:quiet-hours": '{"enabled":true,"startHour":"bad"}',
            "pp:muted-categories": '{"shots_heard":true}',
        },
    )
    assert push._is_quiet_now_for_uid("user-1", "America/New_York") is True
    assert push._is_category_muted_for_uid("user-1", "shots_heard") is True

    monkeypatch.setattr(
        push,
        "list_all_subscriptions",
        lambda city=None: [
            {
                "id": "bad",
                "notifyLat": "not-a-number",
                "notifyLng": -75.16,
                "notifyRadiusKm": 3,
            },
            {
                "id": "good",
                "notifyLat": 39.95,
                "notifyLng": -75.16,
                "notifyRadiusKm": 3,
            },
        ],
    )
    matches = push.find_nearby_subscriptions("philly", 39.95, -75.16)
    assert [row["id"] for row in matches] == ["good"]


def test_keyword_fanout_claims_before_send_and_finalizes(monkeypatch) -> None:
    from philly_pulse import push

    monkeypatch.setattr(push, "push_available", lambda: True)
    monkeypatch.setattr(push, "_user_tier_for_push", lambda _uid: "pro")
    monkeypatch.setattr(push, "_is_snoozed_for_uid", lambda _uid: False)
    monkeypatch.setattr(push, "_is_quiet_now_for_uid", lambda _uid, _tz: False)
    monkeypatch.setattr(
        push,
        "list_active_keyword_watches",
        lambda _city: [{
            "id": "watch-1",
            "uid": "user-1",
            "keyword": "shots",
            "severityFloor": 0,
            "lastFiredMs": 0,
        }],
    )
    events: list[str] = []
    monkeypatch.setattr(
        push,
        "_claim_delivery_cooldown",
        lambda *_args, **_kwargs: events.append("claim") or "lease-token",
    )
    monkeypatch.setattr(
        push,
        "send_to_uid",
        lambda *_args, **_kwargs: events.append("send") or {"sent": 1},
    )
    monkeypatch.setattr(
        push,
        "_finish_delivery_cooldown",
        lambda *_args, **_kwargs: events.append("finish") or True,
    )

    result = push.notify_keyword_watches(
        incident_id="abcdef123456",
        city="philly",
        raw_text="reports of shots fired",
        severity_category="shots_heard",
        s_base=0.8,
    )

    assert result["sent"] == 1
    assert events == ["claim", "send", "finish"]


def test_nearby_failed_send_releases_delivery_claim(monkeypatch) -> None:
    from philly_pulse import push

    monkeypatch.setattr(push, "push_available", lambda: True)
    monkeypatch.setattr(
        push,
        "find_nearby_subscriptions",
        lambda *_args: [{"id": "sub-1", "uid": "", "lastNearbyPushMs": 0}],
    )
    events: list[str] = []
    monkeypatch.setattr(
        push,
        "_claim_delivery_cooldown",
        lambda *_args, **_kwargs: events.append("claim") or "lease-token",
    )
    monkeypatch.setattr(
        push,
        "send_to_subscription",
        lambda *_args, **_kwargs: events.append("send") or (False, "failed"),
    )
    monkeypatch.setattr(
        push,
        "_release_delivery_claim",
        lambda *_args, **_kwargs: events.append("release") or True,
    )

    result = push.notify_nearby_incident(
        incident_id="abcdef123456",
        city="philly",
        lat=39.95,
        lng=-75.16,
        severity_category="shots_heard",
        s_base=0.8,
        location_confidence="high",
    )

    assert result["failed"] == 1
    assert events == ["claim", "send", "release"]


def test_newsroom_email_works_without_web_push_and_deduplicates_devices(
    monkeypatch,
) -> None:
    from philly_pulse import push, ses_email

    monkeypatch.setattr(push, "push_available", lambda: False)
    monkeypatch.setattr(push, "_user_tier_for_push", lambda _uid: "pro")
    monkeypatch.setattr(push, "_is_snoozed_for_uid", lambda _uid: False)
    monkeypatch.setattr(push, "_is_quiet_now_for_uid", lambda _uid, _tz: False)
    monkeypatch.setattr(
        push, "_is_category_muted_for_uid", lambda _uid, _category: False
    )
    monkeypatch.setattr(
        push,
        "find_newsroom_subscriptions",
        lambda _city: [
            {
                "id": "sub-b",
                "uid": "user-1",
                "notifyNewsroomEmail": True,
                "email": "reporter@example.com",
                "lastNewsroomPushMs": 0,
            },
            {
                "id": "sub-a",
                "uid": "user-1",
                "notifyNewsroomEmail": True,
                "email": "reporter@example.com",
                "lastNewsroomPushMs": 0,
            },
        ],
    )
    claims: list[str] = []
    emails: list[str] = []
    monkeypatch.setattr(
        push,
        "_claim_delivery_cooldown",
        lambda _collection, document_id, **_kwargs: claims.append(document_id)
        or "lease-token",
    )
    monkeypatch.setattr(push, "_finish_delivery_cooldown", lambda *_a, **_k: True)
    monkeypatch.setattr(
        ses_email,
        "send_email",
        lambda **kwargs: emails.append(kwargs["to"]) or True,
    )

    result = push.notify_newsroom_incident(
        incident_id="abcdef123456",
        city="philly",
        severity_category="shots_heard",
        s_base=0.8,
    )

    assert result["sent"] == 0
    assert result["emailed"] == 1
    assert result["skipped_no_push"] == 1
    assert claims == ["sub-a"]
    assert emails == ["reporter@example.com"]


def test_health_reports_database_failure_as_degraded(monkeypatch) -> None:
    def fail_count() -> int:
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(server.store, "incident_count", fail_count)
    response = Response()
    body = asyncio.run(server.health(response))
    assert response.status_code == 503
    assert body["status"] == "degraded"
    assert body["database_ok"] is False


def test_health_treats_negative_count_as_database_failure(monkeypatch) -> None:
    monkeypatch.setattr(server.store, "incident_count", lambda: -1)
    response = Response()
    body = asyncio.run(server.health(response))
    assert response.status_code == 503
    assert body["status"] == "degraded"
    assert body["database_ok"] is False


def test_incident_timings_outage_is_not_misreported_as_empty(monkeypatch) -> None:
    def fail_read(_incident_id: str):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(server.store, "get_word_timings", fail_read)
    with pytest.raises(HTTPException) as exc:
        server.get_incident_timings("abcdef123456", Response())
    assert exc.value.status_code == 503


def test_transparency_stats_outage_is_not_misreported_as_zero(monkeypatch) -> None:
    def fail_count(_slug: str) -> int:
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(server.store, "city_incident_count", fail_count)
    with pytest.raises(HTTPException) as exc:
        server.stats()
    assert exc.value.status_code == 503


def test_city_stats_rejects_unregistered_and_traversal_slugs() -> None:
    for slug in ("not-a-city", "..", "."):
        with pytest.raises(HTTPException) as exc:
            server.city_stats(slug)
        assert exc.value.status_code == 404


def test_public_incident_summary_and_stats_reads_are_city_scoped(monkeypatch) -> None:
    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(server.store, "USING_FIRESTORE", True)

    def list_city(slug: str, **_kwargs):
        calls.append(("incidents", slug))
        return []

    monkeypatch.setattr(server.store, "list_incidents_for_city", list_city)
    incident_body = server.get_incidents(
        Response(), since=None, category=None, city="sf", authorization=None
    )
    page_body = server.page_incidents(
        Response(),
        cursor=None,
        limit=20,
        since=None,
        category=None,
        city="sf",
        near_lat=None,
        near_lng=None,
        authorization=None,
    )
    search_body = server.search_incidents(
        Response(),
        q="test",
        since=None,
        until=None,
        category=None,
        limit=20,
        city="sf",
        authorization=None,
    )
    summary_body = asyncio.run(server.summary(Response(), city="sf"))

    monkeypatch.setattr(
        server.store,
        "city_incident_count",
        lambda slug: calls.append(("count", slug)) or 7,
    )
    monkeypatch.setattr(
        server.store,
        "city_inhibitor_stats",
        lambda slug: calls.append(("inhibitors", slug)) or {"passed": 7},
    )
    stats_body = server.stats(city="sf")

    assert incident_body["meta"]["city"] == "sf"
    assert page_body["meta"]["city"] == "sf"
    assert search_body["meta"]["city"] == "sf"
    assert summary_body["meta"]["city"] == "sf"
    assert stats_body["city"] == "sf"
    assert calls == [
        ("incidents", "sf"),
        ("incidents", "sf"),
        ("incidents", "sf"),
        ("incidents", "sf"),
        ("count", "sf"),
        ("inhibitors", "sf"),
    ]

    for reader in (
        lambda: server.get_incidents(
            Response(), since=None, category=None, city="not-real", authorization=None
        ),
        lambda: asyncio.run(server.summary(Response(), city="not-real")),
        lambda: server.stats(city="not-real"),
    ):
        with pytest.raises(HTTPException) as exc:
            reader()
        assert exc.value.status_code == 400


def test_nearby_incident_page_drops_malformed_stored_coordinates(monkeypatch) -> None:
    monkeypatch.setattr(
        server.store,
        "list_incidents_for_city",
        lambda *_args, **_kwargs: [
            {
                "id": "bad-nan",
                "lat": float("nan"),
                "lng": -75.16,
                "reported_at": "2099-01-01T00:00:00+00:00",
                "s_base": 0.5,
                "confidence": 0.8,
            },
            {
                "id": "bad-range",
                "lat": 999,
                "lng": -75.16,
                "reported_at": "2099-01-01T00:00:00+00:00",
                "s_base": 0.5,
                "confidence": 0.8,
            },
            {
                "id": "good",
                "lat": 39.95,
                "lng": -75.16,
                "reported_at": "2099-01-01T00:00:00+00:00",
                "s_base": 0.5,
                "confidence": 0.8,
            },
        ],
    )

    result = server.page_incidents(
        Response(),
        cursor=None,
        limit=20,
        since=None,
        category=None,
        city="philly",
        near_lat=39.95,
        near_lng=-75.16,
        authorization=None,
    )

    assert [row["id"] for row in result["incidents"]] == ["good"]
    assert result["incidents"][0]["distance_km"] == 0.0


def test_summary_cache_is_separated_by_city_and_entitlement(monkeypatch) -> None:
    monkeypatch.setattr(server.store, "USING_FIRESTORE", True)
    row = {
        "id": "same-id",
        "reported_at": "2099-01-01T00:00:00+00:00",
        "severity_category": "medical_other",
        "location_text": "Test location",
        "confidence": 0.9,
    }
    monkeypatch.setattr(
        server.store,
        "list_incidents_for_city",
        lambda _slug, **_kwargs: [row],
    )
    monkeypatch.setattr(server.llm, "is_configured", lambda: True)
    monkeypatch.setattr(
        server,
        "_try_verify_firebase_token",
        lambda auth: {"uid": "pro-user"} if auth == "Bearer pro" else None,
    )
    monkeypatch.setattr(server, "_is_pro_uid", lambda _decoded: True)
    prompts: list[str] = []

    async def fake_chat(messages, **_kwargs):
        prompts.append(messages[0]["content"])
        return f"summary-{len(prompts)}"

    monkeypatch.setattr(server.llm_client, "chat_completion", fake_chat)

    sf_free = asyncio.run(server.summary(Response(), city="sf"))
    philly_free = asyncio.run(server.summary(Response(), city="philly"))
    sf_cached = asyncio.run(server.summary(Response(), city="sf"))
    sf_pro = asyncio.run(
        server.summary(Response(), city="sf", authorization="Bearer pro")
    )

    assert sf_free["summary"] == "summary-1"
    assert philly_free["summary"] == "summary-2"
    assert sf_cached["summary"] == "summary-1"
    assert sf_pro["summary"] == "summary-3"
    assert len(prompts) == 3


def test_single_city_store_rejects_other_registered_city(monkeypatch) -> None:
    monkeypatch.setattr(server.store, "USING_FIRESTORE", False)
    with pytest.raises(HTTPException) as exc:
        server.get_incidents(
            Response(), since=None, category=None, city="sf", authorization=None
        )
    assert exc.value.status_code == 400


def test_incident_page_accepts_compound_cursor_and_preserves_equal_timestamps(
    monkeypatch,
) -> None:
    timestamp = "2099-01-02T03:04:05+00:00"
    captured: dict = {}

    monkeypatch.setattr(
        server, "_try_verify_firebase_token", lambda _auth: {"uid": "pro-user"}
    )
    monkeypatch.setattr(server, "_is_pro_uid", lambda _decoded: True)

    def load_city(*_args, **kwargs):
        captured.update(kwargs)
        return [
            {"id": "same-c", "reported_at": timestamp, "severity_category": "shots_heard"},
            {"id": "same-b", "reported_at": timestamp, "severity_category": "shots_heard"},
            {"id": "same-a", "reported_at": timestamp, "severity_category": "shots_heard"},
        ]

    monkeypatch.setattr(server.store, "list_incidents_for_city", load_city)
    result = server.page_incidents(
        Response(),
        cursor=f"{timestamp}{server._INCIDENT_CURSOR_SEPARATOR}same-d",
        limit=2,
        since="2099-01-01T00:00:00+00:00",
        category=None,
        city="philly",
        near_lat=None,
        near_lng=None,
        authorization=None,
    )

    assert captured["before_iso"] == timestamp
    assert captured["cursor_id"] == "same-d"
    assert captured["limit"] == 3
    assert [row["id"] for row in result["incidents"]] == ["same-c", "same-b"]
    assert result["next_cursor"] == (
        f"{timestamp}{server._INCIDENT_CURSOR_SEPARATOR}same-b"
    )


def test_keyword_watch_create_fails_closed_on_store_outage(monkeypatch) -> None:
    monkeypatch.setattr(
        server,
        "_verify_firebase_token",
        lambda _auth: {"uid": "pro-user", "email": "pro@example.com"},
    )
    monkeypatch.setattr(server, "_require_pro", lambda _decoded: None)

    def fail_create(*_args, **_kwargs):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(server, "_create_keyword_watch_atomic", fail_create)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            server.create_keyword_watch(
                server.KeywordWatchCreateRequest(keyword="shots fired"),
                authorization="Bearer test",
            )
        )
    assert exc.value.status_code == 503


def test_push_device_response_sanitizes_malformed_legacy_rows(monkeypatch) -> None:
    monkeypatch.setattr(
        server,
        "_verify_firebase_token",
        lambda _auth: {"uid": "user-1"},
    )
    monkeypatch.setattr(
        server.push_mod,
        "list_subscriptions_for_uid",
        lambda _uid: [{
            "id": "sub-1",
            "endpoint": "https://push.example/token",
            "createdAtMs": "not-a-number",
            "lastUsedMs": float("nan"),
            "lastNearbyPushMs": float("inf"),
            "notifyLat": "bad",
            "notifyLng": -75.16,
            "notifyRadiusKm": float("nan"),
        }],
    )

    result = asyncio.run(server.push_list_devices("Bearer test"))

    assert result["devices"][0]["createdAtMs"] == 0
    assert result["devices"][0]["lastUsedMs"] == 0
    assert result["devices"][0]["lastNearbyPushMs"] == 0
    assert result["devices"][0]["notifyLat"] is None
    assert result["devices"][0]["notifyLng"] is None
    assert result["devices"][0]["notifyRadiusKm"] == 3.0


def test_keyword_watch_response_sanitizes_malformed_legacy_rows() -> None:
    result = server._watch_to_response({
        "id": "watch-1",
        "keyword": "shots",
        "severityFloor": float("nan"),
        "active": "false",
        "createdAtMs": "bad",
        "lastFiredMs": float("inf"),
    })

    assert result["severityFloor"] == 0.0
    assert result["active"] is False
    assert result["createdAtMs"] == 0
    assert result["lastFiredMs"] == 0
