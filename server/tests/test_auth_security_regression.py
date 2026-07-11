from __future__ import annotations

import os

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
    assert "om_session" not in response.text
    assert PASSWORD not in response.text
    assert "om_session=" in response.headers["set-cookie"]


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
