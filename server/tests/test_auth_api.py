from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import logging
from threading import Event, Lock

import fakeredis
import pytest
from fastapi import BackgroundTasks
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.dialects import postgresql
from starlette.requests import Request

pytest_plugins = ["server.tests.conftest_auth"]

from server.app.auth.models import User
from server.app.auth.security import hash_password, verify_password
from server.app.auth.sessions import SessionStore
from server.app.auth.verification import InvalidCode, VerificationStore


AUTH_ORIGIN = "https://studio.example.com"
EMAIL = "person@example.com"
PASSWORD = "correct horse"
NEW_PASSWORD = "new secure password"


def _bootstrap(client: TestClient) -> tuple[str, str]:
    response = client.get("/api/auth/csrf")
    assert response.status_code == 200, response.text
    session_id = client.cookies.get("om_session")
    token = response.json()["csrf_token"]
    assert session_id
    assert token
    client.headers.update({"Origin": AUTH_ORIGIN, "X-CSRF-Token": token})
    return session_id, token


def _register(client: TestClient, mailer, *, email: str = EMAIL, password: str = PASSWORD):
    verification = client.post("/api/auth/email-verifications", json={"email": email})
    assert verification.status_code == 202, verification.text
    code = mailer.messages[-1][2]
    response = client.post(
        "/api/auth/register",
        json={
            "email": f" {email.title()} ",
            "password": password,
            "code": code,
            "role": "admin",
        },
    )
    assert response.status_code == 201, response.text
    client.headers.update({"X-CSRF-Token": response.json()["csrf_token"]})
    return response


def _insert_user(auth_db, *, email: str = EMAIL, password: str = PASSWORD, status="active"):
    user = User(
        id="user0000000000000000000000000001",
        email=email,
        password_hash=hash_password(password),
        role="user",
        status=status,
    )
    auth_db.add(user)
    auth_db.commit()
    return user


def test_anonymous_csrf_bootstrap_creates_one_opaque_session(auth_client, session_store):
    first = auth_client.get("/api/auth/csrf")

    assert first.status_code == 200
    assert set(first.json()) == {"csrf_token"}
    session_id = auth_client.cookies.get("om_session")
    assert session_id
    record = session_store.get(session_id)
    assert record is not None
    assert record.user_id is None
    assert record.csrf_token == first.json()["csrf_token"]

    second = auth_client.get("/api/auth/csrf")
    assert second.status_code == 200
    assert second.json() == first.json()
    assert auth_client.cookies.get("om_session") == session_id


def test_public_routes_validate_origin_before_payload_or_csrf(auth_client):
    _, token = _bootstrap(auth_client)

    bad_origin = auth_client.post(
        "/api/auth/login",
        headers={"Origin": "https://evil.example", "X-CSRF-Token": token},
        json={"not": "a login payload"},
    )
    missing_csrf = auth_client.post(
        "/api/auth/login",
        headers={"Origin": AUTH_ORIGIN, "X-CSRF-Token": ""},
        json={"email": EMAIL, "password": PASSWORD},
    )

    assert bad_origin.status_code == 403
    assert bad_origin.json() == {"detail": "Invalid request origin"}
    assert missing_csrf.status_code == 403
    assert missing_csrf.json() == {"detail": "Invalid CSRF token"}


def test_malformed_login_json_checks_origin_before_body_parsing(auth_client):
    _, token = _bootstrap(auth_client)

    response = auth_client.post(
        "/api/auth/login",
        headers={
            "Origin": "https://evil.example",
            "X-CSRF-Token": token,
            "Content-Type": "application/json",
        },
        content=b'{"email":',
    )

    assert response.status_code == 403
    assert response.json() == {"detail": "Invalid request origin"}


def test_login_validation_never_exposes_submitted_password_or_context(
    auth_client, caplog
):
    _bootstrap(auth_client)
    secret = "login-validation-secret-" + ("x" * 64)

    with caplog.at_level(logging.DEBUG):
        response = auth_client.post(
            "/api/auth/login",
            json={"email": EMAIL, "password": secret},
        )

    assert response.status_code == 422
    assert secret not in response.text
    assert secret not in caplog.text
    for error in response.json()["detail"]:
        assert "input" not in error
        assert "ctx" not in error


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/api/auth/email-verifications", {"email": EMAIL}),
        ("/api/auth/register", {"email": EMAIL, "password": PASSWORD, "code": "123456"}),
        ("/api/auth/login", {"email": EMAIL, "password": PASSWORD}),
        ("/api/auth/password-reset/request", {"email": EMAIL}),
        (
            "/api/auth/password-reset/confirm",
            {"email": EMAIL, "code": "123456", "new_password": NEW_PASSWORD},
        ),
    ],
)
def test_every_public_mutation_requires_a_bootstrapped_session(auth_client, path, payload):
    response = auth_client.post(
        path,
        headers={"Origin": AUTH_ORIGIN, "X-CSRF-Token": "not-a-token"},
        json=payload,
    )

    assert response.status_code == 401
    assert response.json() == {"detail": "Authentication required"}


def test_register_normalizes_consumes_code_ignores_role_and_rotates_session(
    auth_client, mailer, auth_db, provisioner, session_store
):
    old_session_id, _ = _bootstrap(auth_client)

    response = _register(auth_client, mailer)

    assert response.json()["user"] == {
        "id": response.json()["user"]["id"],
        "email": EMAIL,
        "role": "user",
    }
    assert response.json()["csrf_token"]
    new_session_id = auth_client.cookies.get("om_session")
    assert new_session_id != old_session_id
    assert session_store.get(old_session_id) is None
    assert session_store.get(new_session_id).user_id == response.json()["user"]["id"]
    user = auth_db.scalar(select(User).where(User.email == EMAIL))
    assert user is not None
    assert user.role == "user"
    assert provisioner.calls == [(auth_db, user.id)]
    assert provisioner.users_were_persistent == [True]


def test_mixed_case_verification_and_registration_share_canonical_email(
    auth_client, mailer
):
    _bootstrap(auth_client)

    verification = auth_client.post(
        "/api/auth/email-verifications", json={"email": " Person@Example.com "}
    )
    assert verification.status_code == 202
    assert mailer.messages == [("register", EMAIL, mailer.messages[0][2])]

    response = auth_client.post(
        "/api/auth/register",
        json={
            "email": " Person@Example.com ",
            "password": PASSWORD,
            "code": mailer.messages[0][2],
        },
    )
    assert response.status_code == 201
    assert response.json()["user"]["email"] == EMAIL


def test_duplicate_registration_is_atomic_and_does_not_rotate_anonymous_session(
    auth_client, mailer, auth_redis, auth_settings, auth_db, provisioner, session_store
):
    _bootstrap(auth_client)
    _register(auth_client, mailer)
    original_user_id = auth_db.scalar(select(User.id).where(User.email == EMAIL))

    auth_client.cookies.clear()
    anonymous_session_id, _ = _bootstrap(auth_client)
    auth_redis.delete(f"{auth_settings.redis_prefix}verification:resend:{EMAIL}")
    assert auth_client.post("/api/auth/email-verifications", json={"email": EMAIL}).status_code == 202
    code = mailer.messages[-1][2]
    duplicate = auth_client.post(
        "/api/auth/register",
        json={"email": EMAIL, "password": PASSWORD, "code": code},
    )

    assert duplicate.status_code == 409
    assert duplicate.json() == {"detail": "Registration could not be completed"}
    assert auth_client.cookies.get("om_session") == anonymous_session_id
    assert session_store.get(anonymous_session_id).user_id is None
    assert auth_db.scalars(select(User).where(User.email == EMAIL)).all() == [
        auth_db.get(User, original_user_id)
    ]
    assert len(provisioner.calls) == 1


def test_provisioning_failure_rolls_back_user_and_leaves_anonymous_session(
    auth_client, mailer, auth_db, provisioner, session_store
):
    anonymous_session_id, _ = _bootstrap(auth_client)
    assert auth_client.post("/api/auth/email-verifications", json={"email": EMAIL}).status_code == 202
    provisioner.fail = True

    response = auth_client.post(
        "/api/auth/register",
        json={"email": EMAIL, "password": PASSWORD, "code": mailer.messages[-1][2]},
    )

    assert response.status_code == 500
    assert auth_db.scalar(select(User).where(User.email == EMAIL)) is None
    assert auth_client.cookies.get("om_session") == anonymous_session_id
    assert session_store.get(anonymous_session_id).user_id is None


@pytest.mark.parametrize(
    "payload",
    [
        {"email": "a" * 310 + "@example.com"},
        {"email": EMAIL, "password": "x" * 7, "code": "123456"},
        {"email": EMAIL, "password": "x" * 65, "code": "123456"},
        {"email": EMAIL, "password": PASSWORD, "code": "12345"},
        {"email": EMAIL, "password": PASSWORD, "code": "12345a"},
    ],
)
def test_auth_schemas_enforce_email_password_and_code_bounds(auth_client, payload):
    _bootstrap(auth_client)
    path = "/api/auth/email-verifications" if set(payload) == {"email"} else "/api/auth/register"

    response = auth_client.post(path, json=payload)

    assert response.status_code == 422


def test_login_error_is_identical_for_missing_and_wrong_accounts(auth_client, auth_db):
    _insert_user(auth_db)
    _bootstrap(auth_client)

    missing = auth_client.post(
        "/api/auth/login", json={"email": "none@example.com", "password": "wrong-pass"}
    )
    existing = auth_client.post(
        "/api/auth/login", json={"email": EMAIL, "password": "wrong-pass"}
    )

    expected = {"detail": "Email or password is incorrect"}
    assert missing.status_code == existing.status_code == 401
    assert missing.json() == existing.json() == expected


def test_missing_login_performs_dummy_argon2_verification(
    auth_client, monkeypatch
):
    _bootstrap(auth_client)
    from server.app.auth import service

    calls: list[tuple[str, str]] = []

    def recording_verify(encoded: str, password: str) -> bool:
        calls.append((encoded, password))
        return False

    monkeypatch.setattr(service, "verify_password", recording_verify)

    response = auth_client.post(
        "/api/auth/login", json={"email": "missing@example.com", "password": "wrong-pass"}
    )

    assert response.status_code == 401
    assert len(calls) == 1
    assert calls[0][0].startswith("$argon2id$")
    assert calls[0][1] == "wrong-pass"


def test_login_enforces_atomic_email_and_ip_limits(auth_client, monkeypatch):
    _bootstrap(auth_client)
    from server.app.auth import service

    monkeypatch.setattr(service, "verify_password", lambda encoded, password: False)

    email_attempts = [
        auth_client.post(
            "/api/auth/login", json={"email": "limited@example.com", "password": "wrong-pass"}
        )
        for _ in range(11)
    ]
    assert [response.status_code for response in email_attempts[:10]] == [401] * 10
    assert email_attempts[10].status_code == 429

    auth_client.cookies.clear()
    _bootstrap(auth_client)
    ip_attempts = [
        auth_client.post(
            "/api/auth/login",
            json={"email": f"person{index}@example.com", "password": "wrong-pass"},
        )
        for index in range(21)
    ]
    assert [response.status_code for response in ip_attempts[:20]] == [401] * 20
    assert ip_attempts[20].status_code == 429


def test_successful_login_clears_email_limit_rotates_and_binds_session(
    auth_client, auth_db, auth_redis, auth_settings, session_store
):
    user = _insert_user(auth_db)
    anonymous_session_id, _ = _bootstrap(auth_client)
    wrong = auth_client.post(
        "/api/auth/login", json={"email": " Person@Example.com ", "password": "wrong-pass"}
    )
    assert wrong.status_code == 401
    assert list(
        auth_redis.scan_iter(
            match=f"{auth_settings.redis_prefix}login:rate:email:{EMAIL}*"
        )
    )

    response = auth_client.post(
        "/api/auth/login", json={"email": " Person@Example.com ", "password": PASSWORD}
    )

    assert response.status_code == 200
    assert response.json()["user"] == {"id": user.id, "email": EMAIL, "role": "user"}
    new_session_id = auth_client.cookies.get("om_session")
    assert new_session_id != anonymous_session_id
    assert session_store.get(anonymous_session_id) is None
    assert session_store.get(new_session_id).user_id == user.id
    assert not list(
        auth_redis.scan_iter(
            match=f"{auth_settings.redis_prefix}login:rate:email:{EMAIL}*"
        )
    )


@pytest.mark.parametrize("status", ["banned", "inactive"])
def test_login_rejects_unavailable_account_without_binding_session(
    auth_client, auth_db, session_store, status
):
    _insert_user(auth_db, status=status)
    anonymous_session_id, _ = _bootstrap(auth_client)

    response = auth_client.post(
        "/api/auth/login", json={"email": EMAIL, "password": PASSWORD}
    )

    assert response.status_code == 403
    assert response.json() == {"detail": "Account unavailable"}
    assert auth_client.cookies.get("om_session") == anonymous_session_id
    assert session_store.get(anonymous_session_id).user_id is None


def test_me_exposes_only_stable_user_fields(auth_client, mailer):
    _bootstrap(auth_client)
    assert auth_client.get("/api/auth/me").status_code == 401
    registered = _register(auth_client, mailer)

    response = auth_client.get("/api/auth/me")

    assert response.status_code == 200
    assert response.json() == {"user": registered.json()["user"]}
    assert set(response.json()["user"]) == {"id", "email", "role"}


def test_logout_requires_authenticated_csrf_revokes_current_and_clears_cookie(
    auth_client, mailer, session_store
):
    _bootstrap(auth_client)
    _register(auth_client, mailer)
    session_id = auth_client.cookies.get("om_session")

    rejected = auth_client.post(
        "/api/auth/logout", headers={"Origin": AUTH_ORIGIN, "X-CSRF-Token": "wrong"}
    )
    assert rejected.status_code == 403
    assert session_store.get(session_id) is not None

    response = auth_client.post("/api/auth/logout")

    assert response.status_code == 204
    assert response.content == b""
    assert session_store.get(session_id) is None
    assert auth_client.cookies.get("om_session") is None


def test_logout_all_revokes_every_current_user_session(
    auth_client, auth_app, mailer, session_store
):
    _bootstrap(auth_client)
    _register(auth_client, mailer)
    first_session_id = auth_client.cookies.get("om_session")

    with TestClient(auth_app, base_url=AUTH_ORIGIN, raise_server_exceptions=False) as second:
        _bootstrap(second)
        login = second.post(
            "/api/auth/login", json={"email": EMAIL, "password": PASSWORD}
        )
        assert login.status_code == 200
        second.headers.update({
            "Origin": AUTH_ORIGIN,
            "X-CSRF-Token": login.json()["csrf_token"],
        })
        second_session_id = second.cookies.get("om_session")

        response = auth_client.post("/api/auth/logout-all")

        assert response.status_code == 204
        assert session_store.get(first_session_id) is None
        assert session_store.get(second_session_id) is None
        assert auth_client.get("/api/auth/me").status_code == 401
        assert second.get("/api/auth/me").status_code == 401


def test_password_reset_request_is_neutral_and_enumeration_resistant(
    auth_client, auth_db, mailer
):
    _insert_user(auth_db)
    _bootstrap(auth_client)

    missing = auth_client.post(
        "/api/auth/password-reset/request", json={"email": "missing@example.com"}
    )
    existing = auth_client.post(
        "/api/auth/password-reset/request", json={"email": " Person@Example.com "}
    )

    expected = {"detail": "If the account can be reset, a code has been sent"}
    assert missing.status_code == existing.status_code == 202
    assert missing.json() == existing.json() == expected
    assert mailer.messages == [("reset", EMAIL, mailer.messages[0][2])]


def test_reset_request_cannot_create_a_verification_route_account_oracle(
    auth_client,
    auth_db,
    auth_redis,
    auth_settings,
    mailer,
):
    _insert_user(auth_db)
    _bootstrap(auth_client)
    emails = (EMAIL, "missing@example.com")

    reset_requests = [
        auth_client.post("/api/auth/password-reset/request", json={"email": email})
        for email in emails
    ]
    verification_requests = [
        auth_client.post("/api/auth/email-verifications", json={"email": email})
        for email in emails
    ]

    neutral = {"detail": "If the account can be reset, a code has been sent"}
    limited = {"detail": "Verification request rate limited"}
    assert [response.status_code for response in reset_requests] == [202, 202]
    assert [response.json() for response in reset_requests] == [neutral, neutral]
    assert [response.status_code for response in verification_requests] == [429, 429]
    assert [response.json() for response in verification_requests] == [limited, limited]
    for email in emails:
        assert auth_redis.exists(
            f"{auth_settings.redis_prefix}verification:reset:{email}"
        )
        assert auth_redis.get(
            f"{auth_settings.redis_prefix}verification:resend:{email}"
        ) == "1"
        email_rate_keys = list(
            auth_redis.scan_iter(
                match=(
                    f"{auth_settings.redis_prefix}verification:rate:email:{email}:*"
                )
            )
        )
        assert len(email_rate_keys) == 1
        assert auth_redis.get(email_rate_keys[0]) == "1"
    assert [(purpose, email) for purpose, email, _ in mailer.messages] == [
        ("reset", EMAIL)
    ]


def test_password_reset_schedules_same_background_shape_without_capturing_db(
    auth_db, verification_store, mailer
):
    from server.app.auth.router import request_password_reset_route
    from server.app.auth.schemas import EmailRequest

    _insert_user(auth_db)
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/auth/password-reset/request",
            "headers": [],
            "client": ("reset-source", 1234),
        }
    )
    results = []
    scheduled = []
    for email in (EMAIL, "missing@example.com"):
        background_tasks = BackgroundTasks()
        result = request_password_reset_route(
            payload=EmailRequest(email=email),
            request=request,
            background_tasks=background_tasks,
            db=auth_db,
            verification_store=verification_store,
            mailer=mailer,
        )
        results.append(result.model_dump())
        assert len(background_tasks.tasks) == 1
        task = background_tasks.tasks[0]
        assert auth_db not in task.args
        assert auth_db not in task.kwargs.values()
        scheduled.append((task.func, set(task.kwargs)))

    assert results == [
        {"detail": "If the account can be reset, a code has been sent"},
        {"detail": "If the account can be reset, a code has been sent"},
    ]
    assert scheduled[0] == scheduled[1]
    assert mailer.messages == []


def test_password_reset_delivery_failure_cannot_change_neutral_response(
    auth_client, auth_app, auth_db
):
    from server.app.auth.router import get_mailer

    class FailingMailer:
        def send_verification(self, email: str, code: str) -> None:
            raise RuntimeError("delivery unavailable")

        def send_password_reset(self, email: str, code: str) -> None:
            raise RuntimeError("delivery unavailable")

    _insert_user(auth_db)
    auth_app.dependency_overrides[get_mailer] = FailingMailer
    _bootstrap(auth_client)

    existing = auth_client.post(
        "/api/auth/password-reset/request", json={"email": EMAIL}
    )
    missing = auth_client.post(
        "/api/auth/password-reset/request", json={"email": "missing@example.com"}
    )

    expected = {"detail": "If the account can be reset, a code has been sent"}
    assert existing.status_code == missing.status_code == 202
    assert existing.json() == missing.json() == expected


def test_password_reset_revocation_failure_rolls_back_hash_and_returns_generic_error(
    auth_client,
    auth_app,
    auth_db,
    verification_store,
    session_store,
):
    from server.app.auth.router import get_session_store

    class FailingRevocationStore:
        def revoke_all(self, user_id: str) -> None:
            raise RuntimeError("redis unavailable")

    user = _insert_user(auth_db)
    original_hash = user.password_hash
    _bootstrap(auth_client)
    login = auth_client.post(
        "/api/auth/login", json={"email": EMAIL, "password": PASSWORD}
    )
    assert login.status_code == 200
    auth_client.headers.update({"X-CSRF-Token": login.json()["csrf_token"]})
    session_id = auth_client.cookies.get("om_session")
    code = verification_store.issue(EMAIL, purpose="reset", source_ip="reset-ip")
    auth_app.dependency_overrides[get_session_store] = FailingRevocationStore

    response = auth_client.post(
        "/api/auth/password-reset/confirm",
        json={"email": EMAIL, "code": code, "new_password": NEW_PASSWORD},
    )

    auth_db.expire_all()
    persisted = auth_db.get(User, user.id)
    assert persisted.password_hash == original_hash
    assert verify_password(persisted.password_hash, PASSWORD)
    assert not verify_password(persisted.password_hash, NEW_PASSWORD)
    assert session_store.get(session_id) is not None
    assert response.status_code == 503
    assert response.json() == {"detail": "Password reset could not be completed"}
    assert code not in response.text
    assert EMAIL not in response.text
    assert NEW_PASSWORD not in response.text
    with pytest.raises(InvalidCode):
        verification_store.consume(EMAIL, code, purpose="reset")


def test_password_reset_is_one_time_changes_hash_and_revokes_all_sessions(
    auth_client,
    auth_app,
    mailer,
    session_store,
    auth_redis,
    auth_settings,
):
    _bootstrap(auth_client)
    registered = _register(auth_client, mailer)
    first_session_id = auth_client.cookies.get("om_session")

    with TestClient(auth_app, base_url=AUTH_ORIGIN, raise_server_exceptions=False) as second:
        _bootstrap(second)
        login = second.post(
            "/api/auth/login", json={"email": EMAIL, "password": PASSWORD}
        )
        assert login.status_code == 200
        second_session_id = second.cookies.get("om_session")

        auth_redis.delete(
            f"{auth_settings.redis_prefix}verification:resend:{EMAIL}"
        )
        request = auth_client.post(
            "/api/auth/password-reset/request", json={"email": registered.json()["user"]["email"]}
        )
        assert request.status_code == 202
        code = mailer.messages[-1][2]
        reset = auth_client.post(
            "/api/auth/password-reset/confirm",
            json={"email": EMAIL, "code": code, "new_password": NEW_PASSWORD},
        )

        assert reset.status_code == 204
        assert reset.content == b""
        assert session_store.get(first_session_id) is None
        assert session_store.get(second_session_id) is None
        assert auth_client.get("/api/auth/me").status_code == 401
        assert second.get("/api/auth/me").status_code == 401

    auth_client.cookies.clear()
    _bootstrap(auth_client)
    reused = auth_client.post(
        "/api/auth/password-reset/confirm",
        json={"email": EMAIL, "code": code, "new_password": NEW_PASSWORD},
    )
    assert reused.status_code == 400
    assert reused.json() == {"detail": "Invalid or expired reset code"}

    old_login = auth_client.post(
        "/api/auth/login", json={"email": EMAIL, "password": PASSWORD}
    )
    new_login = auth_client.post(
        "/api/auth/login", json={"email": EMAIL, "password": NEW_PASSWORD}
    )
    assert old_login.status_code == 401
    assert new_login.status_code == 200


def test_auth_cookies_have_required_flags_and_contain_no_identity(
    auth_client, mailer
):
    bootstrap = auth_client.get("/api/auth/csrf")
    auth_client.headers.update(
        {"Origin": AUTH_ORIGIN, "X-CSRF-Token": bootstrap.json()["csrf_token"]}
    )
    registered = _register(auth_client, mailer)

    for response in (bootstrap, registered):
        cookie = response.headers["set-cookie"]
        assert "HttpOnly" in cookie
        assert "Secure" in cookie
        assert "SameSite=lax" in cookie
        assert "Path=/" in cookie
        assert EMAIL not in cookie
        assert registered.json()["user"]["id"] not in cookie


def test_reset_responses_and_logs_never_expose_codes_or_account_existence(
    auth_client, auth_db, mailer, caplog
):
    _insert_user(auth_db)
    _bootstrap(auth_client)
    caplog.set_level(logging.DEBUG)

    response = auth_client.post(
        "/api/auth/password-reset/request", json={"email": EMAIL}
    )
    code = mailer.messages[-1][2]
    invalid = auth_client.post(
        "/api/auth/password-reset/confirm",
        json={"email": EMAIL, "code": "000000", "new_password": NEW_PASSWORD},
    )

    rendered = response.text + invalid.text + caplog.text
    assert code not in rendered
    assert "000000" not in rendered
    assert EMAIL not in rendered
    assert PASSWORD not in rendered


def test_login_rate_limiter_is_atomic_under_concurrency(auth_settings):
    from server.app.auth.service import LoginRateLimited, LoginRateLimiter

    redis = fakeredis.FakeRedis(decode_responses=True)
    limiter = LoginRateLimiter(redis, prefix=auth_settings.redis_prefix)

    def attempt_email(_):
        try:
            limiter.consume("limited@example.com", "ip-email")
        except LoginRateLimited:
            return False
        return True

    with ThreadPoolExecutor(max_workers=20) as executor:
        email_results = list(executor.map(attempt_email, range(40)))
    assert email_results.count(True) == 10

    def attempt_ip(index):
        try:
            limiter.consume(f"person{index}@example.com", "ip-shared")
        except LoginRateLimited:
            return False
        return True

    with ThreadPoolExecutor(max_workers=40) as executor:
        ip_results = list(executor.map(attempt_ip, range(50)))
    assert ip_results.count(True) == 30


class _ScalarResult:
    def __init__(self, value):
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class _SharedRow:
    def __init__(self, user: User):
        self.user = user
        self.lock = Lock()
        self.statements = []
        self.commits: list[str] = []
        self.events: list[str] = []


class _LockingSession:
    def __init__(
        self,
        shared: _SharedRow,
        name: str,
        before_lock=None,
        after_lock=None,
    ):
        self.shared = shared
        self.name = name
        self.before_lock = before_lock
        self.after_lock = after_lock
        self.holds_lock = False

    def execute(self, statement):
        self.shared.statements.append(statement)
        assert statement._for_update_arg is not None
        if self.before_lock is not None:
            self.before_lock()
        self.shared.lock.acquire()
        self.holds_lock = True
        if self.after_lock is not None:
            self.after_lock()
        return _ScalarResult(self.shared.user)

    def commit(self):
        self.shared.commits.append(self.name)
        self.shared.events.append(f"{self.name}:commit")
        self._release()

    def rollback(self):
        self._release()

    def _release(self):
        if self.holds_lock:
            self.holds_lock = False
            self.shared.lock.release()


class _LockAwareSessionStore:
    def __init__(
        self,
        delegate: SessionStore,
        shared: _SharedRow,
        login_db: _LockingSession,
        reset_db: _LockingSession,
    ):
        self.delegate = delegate
        self.shared = shared
        self.login_db = login_db
        self.reset_db = reset_db
        self.session_issued = Event()

    def rotate(self, session_id: str, user_id: str):
        assert self.login_db.holds_lock
        self.shared.events.append("login:rotate")
        rotated = self.delegate.rotate(session_id, user_id)
        self.session_issued.set()
        return rotated

    def revoke(self, session_id: str) -> None:
        self.delegate.revoke(session_id)

    def revoke_all(self, user_id: str) -> None:
        assert self.reset_db.holds_lock
        assert self.shared.lock.locked()
        self.shared.events.append("reset:revoke_all")
        self.delegate.revoke_all(user_id)


def test_old_credential_login_cannot_survive_concurrent_password_reset(
    auth_settings, monkeypatch
):
    from server.app.auth import service

    redis = fakeredis.FakeRedis(decode_responses=True)
    sessions = SessionStore.from_settings(redis, auth_settings)
    verification = VerificationStore(
        redis,
        prefix=auth_settings.redis_prefix,
        hmac_secret=auth_settings.auth_hmac_secret,
    )
    reset_code = verification.issue(EMAIL, purpose="reset", source_ip="reset-ip")
    anonymous_session_id, _ = sessions.create()
    user = User(
        id="race0000000000000000000000000001",
        email=EMAIL,
        password_hash=hash_password(PASSWORD),
        role="user",
        status="active",
    )
    shared = _SharedRow(user)
    reset_attempted_lock = Event()
    old_password_verified = Event()
    release_login = Event()
    reset_done = Event()
    login_db = _LockingSession(shared, "login")

    def reset_acquired_lock():
        assert tracked_sessions.session_issued.is_set()

    reset_db = _LockingSession(
        shared,
        "reset",
        before_lock=reset_attempted_lock.set,
        after_lock=reset_acquired_lock,
    )
    tracked_sessions = _LockAwareSessionStore(
        sessions,
        shared,
        login_db,
        reset_db,
    )
    real_verify = service.verify_password

    def pause_after_old_password_verification(encoded: str, password: str) -> bool:
        matched = real_verify(encoded, password)
        if matched and password == PASSWORD:
            old_password_verified.set()
            assert release_login.wait(timeout=5)
        return matched

    monkeypatch.setattr(service, "verify_password", pause_after_old_password_verification)

    def login_with_old_password():
        return service.authenticate_user(
            db=login_db,
            rate_limiter=service.LoginRateLimiter(
                redis, prefix=auth_settings.redis_prefix
            ),
            session_store=tracked_sessions,
            incoming_session_id=anonymous_session_id,
            email=EMAIL,
            password=PASSWORD,
            source_ip="login-ip",
        )

    def reset_concurrently():
        try:
            service.reset_password(
                db=reset_db,
                verification_store=verification,
                session_store=tracked_sessions,
                email=EMAIL,
                code=reset_code,
                new_password=NEW_PASSWORD,
            )
        finally:
            reset_done.set()

    with ThreadPoolExecutor(max_workers=2) as executor:
        login_future = executor.submit(login_with_old_password)
        assert old_password_verified.wait(timeout=5)
        reset_future = executor.submit(reset_concurrently)
        assert reset_attempted_lock.wait(timeout=5)
        assert not reset_done.wait(timeout=0.1)
        release_login.set()
        login_result = login_future.result(timeout=5)
        reset_future.result(timeout=5)

    assert shared.commits == ["login", "reset"]
    assert shared.events == [
        "login:rotate",
        "login:commit",
        "reset:revoke_all",
        "reset:commit",
    ]
    assert sessions.get(login_result.session_id) is None
    assert verify_password(user.password_hash, NEW_PASSWORD)
    postgres_sql = [
        str(statement.compile(dialect=postgresql.dialect())).upper()
        for statement in shared.statements
    ]
    assert len(postgres_sql) == 2
    assert all("FOR UPDATE" in statement for statement in postgres_sql)


def test_auth_router_is_integrated_exactly_once(auth_app):
    from server.app.auth.router import router as auth_router

    included = [
        route
        for route in auth_app.routes
        if getattr(route, "original_router", None) is auth_router
    ]
    assert len(included) == 1
    route_paths = [route.path for route in auth_router.routes]

    for path in (
        "/api/auth/csrf",
        "/api/auth/email-verifications",
        "/api/auth/register",
        "/api/auth/login",
        "/api/auth/logout",
        "/api/auth/logout-all",
        "/api/auth/me",
        "/api/auth/password-reset/request",
        "/api/auth/password-reset/confirm",
    ):
        assert route_paths.count(path) == 1
