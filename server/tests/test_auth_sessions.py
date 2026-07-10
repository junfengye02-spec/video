from concurrent.futures import ThreadPoolExecutor
import hashlib
import inspect
import json
import os
from threading import Barrier, Lock

import fakeredis
import pytest
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from starlette.requests import Request

os.environ.setdefault("AUTH_HMAC_SECRET", "x" * 32)

from server.app.auth.dependencies import (
    CurrentUser,
    load_session,
    require_admin,
    require_csrf,
    require_public_csrf,
    require_user,
    validate_origin,
)
from server.app.auth.models import User
from server.app.auth.provisioning import NoopUserProvisioner, UserProvisioner
from server.app.auth.sessions import SessionRecord, SessionStore
from server.app.core.config import AppSettings, get_settings
from server.app.db.base import Base
from server.app.db.session import get_db as canonical_get_db
from server.app.redis import get_redis as canonical_get_redis


PREFIX = "test:"
ORIGIN = "https://studio.example.com"


@pytest.fixture
def redis_client():
    return fakeredis.FakeRedis(decode_responses=True)


@pytest.fixture
def store(redis_client):
    return SessionStore(redis_client, prefix=PREFIX, idle_seconds=60, absolute_seconds=300)


@pytest.fixture
def settings():
    return AppSettings(
        _env_file=None,
        environment="test",
        database_url="sqlite+pysqlite:///:memory:",
        redis_url="redis://unused/0",
        redis_prefix=PREFIX,
        public_origin=ORIGIN,
        session_cookie_name="om_session",
        session_idle_seconds=60,
        session_absolute_seconds=300,
        auth_hmac_secret="x" * 32,
    )


@pytest.fixture
def db():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def _request(
    *,
    method: str = "POST",
    session_id: str | None = None,
    origin: str | None = ORIGIN,
    csrf_token: str | None = None,
) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if session_id is not None:
        headers.append((b"cookie", f"om_session={session_id}".encode("ascii")))
    if origin is not None:
        headers.append((b"origin", origin.encode("ascii")))
    if csrf_token is not None:
        headers.append((b"x-csrf-token", csrf_token.encode("ascii")))
    return Request({"type": "http", "method": method, "path": "/", "headers": headers})


def _stored_text(redis_client) -> str:
    parts: list[str] = []
    for key in redis_client.scan_iter(match=f"{PREFIX}*"):
        parts.append(key)
        key_type = redis_client.type(key)
        if key_type == "string":
            parts.append(redis_client.get(key))
        elif key_type == "set":
            parts.extend(sorted(redis_client.smembers(key)))
    return "\n".join(parts)


def _session_key(session_id: str) -> str:
    digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
    return f"{PREFIX}session:{digest}"


def _assert_http_error(status_code: int, detail: str, call) -> None:
    with pytest.raises(HTTPException) as exc_info:
        call()
    assert exc_info.value.status_code == status_code
    assert exc_info.value.detail == detail


def test_create_uses_random_opaque_identifiers_and_csrf_tokens(store):
    first_id, first = store.create(now=100)
    second_id, second = store.create(now=100)

    assert first_id != second_id
    assert first.csrf_token != second.csrf_token
    assert len(first_id) >= 32
    assert len(first.csrf_token) >= 32


def test_raw_session_identifier_is_absent_from_redis_keys_values_and_indexes(
    redis_client, store
):
    session_id, _ = store.create("u1", now=100)

    assert session_id not in _stored_text(redis_client)
    assert _session_key(session_id) in redis_client.scan_iter(match=f"{PREFIX}session:*")


def test_create_anonymous_session_has_no_user_binding(store):
    session_id, created = store.create(now=100)

    assert created == SessionRecord(
        user_id=None,
        csrf_token=created.csrf_token,
        created_at=100,
        last_seen_at=100,
        absolute_expires_at=400,
    )
    assert store.get(session_id, now=101).user_id is None


def test_create_rejects_an_empty_user_id(store):
    with pytest.raises(ValueError, match="user_id must be non-empty"):
        store.create("")


def test_rotation_revokes_old_session_and_preserves_user(store):
    old_id, old = store.create("u1", now=100)

    rotated = store.rotate(old_id, now=101)

    assert rotated is not None
    new_id, new = rotated
    assert old.user_id == new.user_id == "u1"
    assert new_id != old_id
    assert new.csrf_token != old.csrf_token
    assert store.get(old_id, now=102) is None
    assert store.get(new_id, now=102).csrf_token == new.csrf_token


def test_rotation_can_bind_an_anonymous_session_to_a_user(store):
    old_id, old = store.create(now=100)

    rotated = store.rotate(old_id, user_id="u1", now=101)

    assert rotated is not None
    new_id, new = rotated
    assert old.user_id is None
    assert new.user_id == "u1"
    assert store.get(old_id, now=102) is None
    assert store.get(new_id, now=102).user_id == "u1"


def test_rotation_rejects_an_explicit_empty_user_id_without_revoking_old_session(store):
    old_id, _ = store.create("u1", now=100)

    with pytest.raises(ValueError, match="user_id must be non-empty"):
        store.rotate(old_id, user_id="", now=101)

    assert store.get(old_id, now=102).user_id == "u1"


def test_rotation_of_missing_or_expired_session_fails_closed(store):
    session_id, _ = store.create("u1", now=100)

    assert store.rotate("missing", now=101) is None
    assert store.rotate(session_id, now=401) is None


def test_get_slides_idle_expiry_without_crossing_absolute_cutoff(redis_client):
    store = SessionStore(redis_client, prefix=PREFIX, idle_seconds=60, absolute_seconds=120)
    session_id, _ = store.create("u1", now=100)

    touched = store.get(session_id, now=159)
    assert touched is not None
    assert touched.last_seen_at == 159
    assert 0 < redis_client.ttl(_session_key(session_id)) <= 60
    assert store.get(session_id, now=218) is not None
    assert 0 < redis_client.ttl(_session_key(session_id)) <= 2
    assert store.get(session_id, now=220) is None


def test_idle_expiry_is_enforced_at_the_exact_boundary(store):
    session_id, _ = store.create("u1", now=100)

    assert store.get(session_id, now=160) is None


def test_a_backwards_clock_does_not_move_last_seen_backwards(store):
    session_id, _ = store.create("u1", now=100)

    record = store.get(session_id, now=99)

    assert record is not None
    assert record.last_seen_at == 100


def test_concurrent_valid_gets_do_not_spuriously_invalidate_one_request(
    redis_client, store, monkeypatch
):
    session_id, _ = store.create("u1", now=100)
    original_get = redis_client.get
    barrier = Barrier(2)
    lock = Lock()
    read_count = 0

    def synchronized_first_read(key):
        nonlocal read_count
        raw = original_get(key)
        with lock:
            read_count += 1
            synchronize = read_count <= 2
        if synchronize:
            barrier.wait(timeout=5)
        return raw

    monkeypatch.setattr(redis_client, "get", synchronized_first_read)

    with ThreadPoolExecutor(max_workers=2) as executor:
        records = list(executor.map(lambda _: store.get(session_id, now=101), range(2)))

    assert all(record is not None for record in records)
    assert [record.user_id for record in records] == ["u1", "u1"]


@pytest.mark.parametrize(
    "malformed",
    [
        "not-json",
        "{}",
        json.dumps(
            {
                "user_id": "u1",
                "csrf_token": "token",
                "created_at": 100,
                "last_seen_at": 99,
                "absolute_expires_at": 400,
            }
        ),
        json.dumps(
            {
                "user_id": "u1",
                "csrf_token": "token",
                "created_at": True,
                "last_seen_at": 100,
                "absolute_expires_at": 400,
            }
        ),
    ],
)
def test_malformed_records_fail_closed_and_are_removed(redis_client, store, malformed):
    session_id, _ = store.create("u1", now=100)
    key = _session_key(session_id)
    redis_client.set(key, malformed, ex=60)

    assert store.get(session_id, now=101) is None
    assert redis_client.get(key) is None
    assert not redis_client.exists(f"{PREFIX}sessions:user:u1")


def test_revoke_removes_session_and_user_index(redis_client, store):
    session_id, _ = store.create("u1", now=100)

    store.revoke(session_id)

    assert store.get(session_id, now=101) is None
    assert not list(redis_client.scan_iter(match=f"{PREFIX}*"))


def test_revoke_all_removes_multiple_sessions_without_touching_other_users(
    redis_client, store
):
    first_id, _ = store.create("u1", now=100)
    second_id, _ = store.create("u1", now=101)
    other_id, _ = store.create("u2", now=102)

    store.revoke_all("u1")

    assert store.get(first_id, now=103) is None
    assert store.get(second_id, now=103) is None
    assert store.get(other_id, now=103).user_id == "u2"
    assert not redis_client.exists(f"{PREFIX}sessions:user:u1")
    assert first_id not in _stored_text(redis_client)
    assert second_id not in _stored_text(redis_client)


def test_from_settings_uses_the_configured_namespace_and_expiry(redis_client, settings):
    store = SessionStore.from_settings(redis_client, settings)

    session_id, record = store.create("u1", now=100)

    assert record.absolute_expires_at == 400
    assert _session_key(session_id) in list(redis_client.scan_iter(match=f"{PREFIX}session:*"))


def test_load_session_rejects_missing_and_invalid_cookies(redis_client, settings):
    for request in (_request(session_id=None), _request(session_id="invalid")):
        _assert_http_error(
            401,
            "Authentication required",
            lambda request=request: load_session(request, redis_client, settings),
        )


def test_anonymous_session_bootstraps_public_csrf_but_cannot_authenticate(
    db, redis_client, settings
):
    session_id, record = SessionStore.from_settings(redis_client, settings).create()
    request = _request(session_id=session_id, csrf_token=record.csrf_token)

    assert require_public_csrf(request, redis_client, settings) is None
    _assert_http_error(
        401,
        "Authentication required",
        lambda: require_user(request, db, redis_client, settings),
    )


def test_require_user_returns_the_stable_current_user_shape(db, redis_client, settings):
    user = User(
        id="u1",
        email="person@example.com",
        password_hash="hash",
        role="user",
        status="active",
    )
    db.add(user)
    db.commit()
    session_id, _ = SessionStore.from_settings(redis_client, settings).create("u1")

    current = require_user(_request(session_id=session_id), db, redis_client, settings)

    assert current == CurrentUser(id="u1", email="person@example.com", role="user")


def test_fastapi_overrides_keyed_by_canonical_providers_satisfy_require_user(
    redis_client, settings
):
    user = User(
        id="u1",
        email="person@example.com",
        password_hash="hash",
        role="user",
        status="active",
    )

    class OverrideDb:
        def get(self, model, user_id):
            assert model is User
            return user if user_id == user.id else None

    session_id, _ = SessionStore.from_settings(redis_client, settings).create("u1")
    app = FastAPI()

    @app.get("/me")
    def me(current: CurrentUser = Depends(require_user)):
        return {"id": current.id, "email": current.email, "role": current.role}

    app.dependency_overrides[canonical_get_db] = OverrideDb
    app.dependency_overrides[canonical_get_redis] = lambda: redis_client
    app.dependency_overrides[get_settings] = lambda: settings

    with TestClient(app) as client:
        client.cookies.set(settings.session_cookie_name, session_id)
        response = client.get("/me")

    assert response.status_code == 200
    assert response.json() == {
        "id": "u1",
        "email": "person@example.com",
        "role": "user",
    }


def test_require_user_rejects_a_session_for_a_missing_user(db, redis_client, settings):
    session_id, _ = SessionStore.from_settings(redis_client, settings).create("missing")

    _assert_http_error(
        401,
        "Authentication required",
        lambda: require_user(_request(session_id=session_id), db, redis_client, settings),
    )


@pytest.mark.parametrize("status", ["banned", "inactive"])
def test_unavailable_user_revokes_all_sessions_and_returns_403(
    db, redis_client, settings, status
):
    user = User(
        id="u1",
        email="person@example.com",
        password_hash="hash",
        role="user",
        status=status,
    )
    db.add(user)
    db.commit()
    store = SessionStore.from_settings(redis_client, settings)
    first_id, _ = store.create("u1")
    second_id, _ = store.create("u1")

    _assert_http_error(
        403,
        "Account unavailable",
        lambda: require_user(_request(session_id=first_id), db, redis_client, settings),
    )
    assert store.get(first_id, now=102) is None
    assert store.get(second_id, now=102) is None
    assert not redis_client.exists(f"{PREFIX}sessions:user:u1")


def test_require_admin_enforces_the_exact_role_boundary():
    user = CurrentUser(id="u1", email="user@example.com", role="user")
    admin = CurrentUser(id="a1", email="admin@example.com", role="admin")

    _assert_http_error(
        403,
        "Administrator access required",
        lambda: require_admin(user),
    )
    assert require_admin(admin) is admin


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_unsafe_methods_require_the_exact_same_origin(method):
    validate_origin(_request(method=method, origin=ORIGIN), ORIGIN)

    for origin in (None, f"{ORIGIN}/", "https://STUDIO.example.com", "https://evil.example"):
        _assert_http_error(
            403,
            "Invalid request origin",
            lambda origin=origin: validate_origin(_request(method=method, origin=origin), ORIGIN),
        )


@pytest.mark.parametrize("method", ["GET", "HEAD", "OPTIONS"])
def test_safe_methods_deliberately_skip_origin_validation(method):
    assert validate_origin(_request(method=method, origin=None), ORIGIN) is None


def test_public_csrf_checks_origin_before_comparing_the_token(
    redis_client, settings, monkeypatch
):
    session_id, record = SessionStore.from_settings(redis_client, settings).create()
    compared = False

    def track_compare(left, right):
        nonlocal compared
        compared = True
        return left == right

    monkeypatch.setattr("server.app.auth.dependencies.secrets.compare_digest", track_compare)

    _assert_http_error(
        403,
        "Invalid request origin",
        lambda: require_public_csrf(
            _request(session_id=session_id, origin="https://evil.example", csrf_token=record.csrf_token),
            redis_client,
            settings,
        ),
    )
    assert compared is False


@pytest.mark.parametrize("supplied", [None, "", "wrong-token"])
def test_public_csrf_rejects_missing_or_invalid_tokens(redis_client, settings, supplied):
    session_id, _ = SessionStore.from_settings(redis_client, settings).create()

    _assert_http_error(
        403,
        "Invalid CSRF token",
        lambda: require_public_csrf(
            _request(session_id=session_id, csrf_token=supplied), redis_client, settings
        ),
    )


def test_public_csrf_uses_compare_digest(redis_client, settings, monkeypatch):
    session_id, record = SessionStore.from_settings(redis_client, settings).create()
    compared: list[tuple[str, str]] = []

    def track_compare(left, right):
        compared.append((left, right))
        return True

    monkeypatch.setattr("server.app.auth.dependencies.secrets.compare_digest", track_compare)

    require_public_csrf(
        _request(session_id=session_id, csrf_token="supplied"), redis_client, settings
    )
    assert compared == [("supplied", record.csrf_token)]


def test_authenticated_csrf_returns_current_user(redis_client, settings):
    current = CurrentUser(id="u1", email="person@example.com", role="user")
    session_id, record = SessionStore.from_settings(redis_client, settings).create("u1")

    result = require_csrf(
        _request(session_id=session_id, csrf_token=record.csrf_token),
        current,
        redis_client,
        settings,
    )

    assert result is current


def test_authenticated_csrf_rejects_wrong_origin_and_token(redis_client, settings):
    current = CurrentUser(id="u1", email="person@example.com", role="user")
    session_id, _ = SessionStore.from_settings(redis_client, settings).create("u1")

    _assert_http_error(
        403,
        "Invalid request origin",
        lambda: require_csrf(
            _request(
                session_id=session_id,
                origin="https://evil.example",
                csrf_token="wrong",
            ),
            current,
            redis_client,
            settings,
        ),
    )
    _assert_http_error(
        403,
        "Invalid CSRF token",
        lambda: require_csrf(
            _request(session_id=session_id, csrf_token="wrong"),
            current,
            redis_client,
            settings,
        ),
    )


def test_safe_method_with_csrf_dependency_still_compares_token(redis_client, settings):
    session_id, record = SessionStore.from_settings(redis_client, settings).create()

    require_public_csrf(
        _request(
            method="GET",
            session_id=session_id,
            origin=None,
            csrf_token=record.csrf_token,
        ),
        redis_client,
        settings,
    )
    _assert_http_error(
        403,
        "Invalid CSRF token",
        lambda: require_public_csrf(
            _request(method="GET", session_id=session_id, origin=None, csrf_token="wrong"),
            redis_client,
            settings,
        ),
    )


def test_user_provisioner_is_structural_and_noop_does_not_mutate_the_session(db):
    calls: list[tuple[Session, str]] = []

    class RecordingProvisioner:
        def provision(self, session: Session, user_id: str) -> None:
            calls.append((session, user_id))

    def provision(provisioner: UserProvisioner) -> None:
        provisioner.provision(db, "u1")

    provision(RecordingProvisioner())
    before = (set(db.new), set(db.dirty), set(db.deleted))
    assert NoopUserProvisioner().provision(db, "u2") is None
    after = (set(db.new), set(db.dirty), set(db.deleted))

    assert calls == [(db, "u1")]
    assert after == before
    assert list(inspect.signature(UserProvisioner.provision).parameters) == [
        "self",
        "db",
        "user_id",
    ]
