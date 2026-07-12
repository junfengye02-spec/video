from __future__ import annotations

import json
import logging
import os
from http.cookies import SimpleCookie

import httpx
import pytest

os.environ.setdefault("AUTH_HMAC_SECRET", "x" * 32)

pytest_plugins = ["server.tests.conftest_auth"]

from server.app.auth.models import User
from server.app.auth.security import hash_password
from server.tests.test_project_ownership import (
    ALICE_ID,
    BOB_ID,
    _create_project,
    ownership_context,
)


PASSWORD = "correct horse"


def _assert_session_secret_absent_from_json(response: httpx.Response) -> None:
    cookies = SimpleCookie()
    for header in response.headers.get_list("set-cookie"):
        cookies.load(header)
    session_cookie = cookies.get("om_session")
    assert session_cookie is not None
    session_secret = session_cookie.value
    assert session_secret
    serialized_json = json.dumps(
        response.json(), ensure_ascii=True, sort_keys=True, separators=(",", ":")
    )
    assert session_secret not in serialized_json


@pytest.fixture
def registered_user(auth_db) -> User:
    user = User(
        id="security000000000000000000000001",
        email="security@example.com",
        password_hash=hash_password(PASSWORD),
        role="user",
        status="active",
    )
    auth_db.add(user)
    auth_db.commit()
    return user


def test_session_cookie_and_secrets_never_appear_in_json(
    auth_client, registered_user
):
    bootstrap = auth_client.get("/api/auth/csrf")
    auth_client.headers.update(
        {
            "Origin": "https://studio.example.com",
            "X-CSRF-Token": bootstrap.json()["csrf_token"],
        }
    )

    response = auth_client.post(
        "/api/auth/login",
        json={"email": registered_user.email, "password": PASSWORD},
    )

    assert response.status_code == 200
    assert "password_hash" not in response.text
    assert PASSWORD not in response.text
    assert "om_session=" in response.headers["set-cookie"]
    _assert_session_secret_absent_from_json(response)


def test_session_json_guard_detects_a_value_only_cookie_leak():
    session_secret = "opaque-session-secret-without-cookie-name"
    response = httpx.Response(
        200,
        headers={
            "set-cookie": (
                f"om_session={session_secret}; Path=/; Secure; HttpOnly; SameSite=Lax"
            )
        },
        json={"debug": session_secret},
    )

    with pytest.raises(AssertionError):
        _assert_session_secret_absent_from_json(response)


@pytest.mark.parametrize(
    "headers",
    [
        {"Origin": "https://evil.example"},
        {"Origin": "https://studio.example.com", "X-CSRF-Token": "wrong"},
    ],
)
def test_mutation_rejects_invalid_origin_or_csrf(ownership_context, headers):
    alice = ownership_context["clients"][ALICE_ID]
    project = _create_project(alice)

    response = alice.patch(
        f"/api/projects/{project['id']}/continuity",
        headers=headers,
        json={"project_type": "single_video"},
    )

    assert response.status_code == 403


def test_media_path_check_happens_after_owner_check(ownership_context):
    alice = ownership_context["clients"][ALICE_ID]
    bob = ownership_context["clients"][BOB_ID]
    project = _create_project(bob, title="Bob's project")

    response = alice.get(
        f"/api/projects/{project['id']}/media/%2E%2E/%2E%2E/.env"
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "Project not found"}


def test_gateway_malformed_json_checks_origin_before_body_parsing(
    ownership_context,
):
    alice = ownership_context["clients"][ALICE_ID]

    response = alice.post(
        "/api/session/key",
        headers={
            "Origin": "https://evil.example",
            "Content-Type": "application/json",
        },
        content=b'{"video_key":',
    )

    assert response.status_code == 404


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        (
            "/api/session/key",
            {
                "text_key": {"submitted": "gateway-validation-secret"},
                "image_key": "image-key",
                "video_key": "video-key",
            },
        ),
        (
            "/api/projects",
            {
                "title": {"submitted": "project-validation-secret"},
                "project_type": "single_video",
            },
        ),
    ],
)
def test_validation_errors_redact_gateway_and_project_inputs(
    ownership_context, caplog, path, payload
):
    alice = ownership_context["clients"][ALICE_ID]
    secret = next(iter(payload["text_key" if path.endswith("/key") else "title"].values()))

    with caplog.at_level(logging.DEBUG):
        response = alice.post(path, json=payload)

    assert response.status_code == (404 if path.endswith("/key") else 422)
    assert secret not in response.text
    assert secret not in caplog.text
    if response.status_code == 422:
        for error in response.json()["detail"]:
            assert "input" not in error
            assert "ctx" not in error
