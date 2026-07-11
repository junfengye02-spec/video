from __future__ import annotations

import importlib.util
import json
import logging
import os
import shutil
import sqlite3
import subprocess
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Event

import fakeredis
import pytest
from fastapi.testclient import TestClient
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartParser
from starlette.requests import Request
from sqlalchemy import create_engine, select
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from server.app.auth.models import AdminAuditLog, User
from server.app.auth.security import hash_password
from server.app.auth.sessions import SessionStore
from server.app.core.config import AppSettings, get_settings
from server.app.db.base import Base
from server.app.db.session import get_db
from server.app.main import _json_request_openapi, create_app
from server.app.projects.repository import ProjectRepository
from server.app.redis import get_redis


AUTH_ORIGIN = "https://studio.example.com"
ALICE_ID = "alice000000000000000000000000001"
BOB_ID = "bob00000000000000000000000000002"
ADMIN_ID = "admin000000000000000000000000001"
PASSWORD = "correct horse"
CSRF_HEADER = "X-CSRF-Token"
LEGACY_ID = "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa"
ASSIGNMENT_ID = "bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb"
REJECTED_ASSIGNMENT_ID = "cccccccccccc4ccc8ccccccccccccccc"


@pytest.fixture
def ownership_context(tmp_path):
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.exec_driver_sql("drop table projects")
        connection.exec_driver_sql(
            """
            create table projects (
                id varchar(32) primary key,
                owner_user_id varchar(32) null references users(id),
                title varchar(255) not null,
                mode varchar(32) not null,
                project_type varchar(32) not null,
                created_at datetime not null,
                updated_at datetime not null
            )
            """
        )
        connection.exec_driver_sql(
            "create index ix_projects_owner_user_id on projects (owner_user_id)"
        )
    db = Session(engine, expire_on_commit=False)
    users = [
        User(
            id=ALICE_ID,
            email="alice@example.com",
            password_hash=hash_password(PASSWORD),
            role="user",
            status="active",
        ),
        User(
            id=BOB_ID,
            email="bob@example.com",
            password_hash=hash_password(PASSWORD),
            role="user",
            status="active",
        ),
        User(
            id=ADMIN_ID,
            email="admin@example.com",
            password_hash=hash_password(PASSWORD),
            role="admin",
            status="active",
        ),
    ]
    db.add_all(users)
    db.commit()

    settings = AppSettings(
        _env_file=None,
        environment="test",
        database_url="sqlite+pysqlite:///:memory:",
        redis_url="redis://unused/0",
        redis_prefix="ownership-test:",
        public_origin=AUTH_ORIGIN,
        session_cookie_name="om_session",
        session_cookie_secure=True,
        session_idle_seconds=60,
        session_absolute_seconds=300,
        auth_hmac_secret="x" * 32,
    )
    redis = fakeredis.FakeRedis(decode_responses=True)
    session_store = SessionStore.from_settings(redis, settings)
    app = create_app(
        db_path=tmp_path / "legacy-workbench.sqlite3",
        projects_root=tmp_path / "projects",
    )
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_redis] = lambda: redis
    app.dependency_overrides[get_settings] = lambda: settings

    clients: dict[str, TestClient] = {}
    for user in users:
        client = TestClient(app, base_url=AUTH_ORIGIN, raise_server_exceptions=False)
        session_id, session = session_store.create(user.id)
        client.cookies.set(settings.session_cookie_name, session_id)
        client.headers.update({"Origin": AUTH_ORIGIN, CSRF_HEADER: session.csrf_token})
        clients[user.id] = client

    yield {
        "app": app,
        "db": db,
        "engine": engine,
        "clients": clients,
        "users": {user.id: user for user in users},
        "tmp_path": tmp_path,
        "session_store": session_store,
    }

    for client in clients.values():
        client.close()
    db.close()
    engine.dispose()


def _alice(context) -> TestClient:
    return context["clients"][ALICE_ID]


def _bob(context) -> TestClient:
    return context["clients"][BOB_ID]


def _create_project(client: TestClient, *, title: str = "Mine") -> dict:
    response = client.post(
        "/api/projects",
        json={"title": title, "project_type": "single_video"},
    )
    assert response.status_code in {200, 201}, response.text
    return response.json()["project"]


def _link_file(link: Path, target: Path) -> bool:
    try:
        link.symlink_to(target)
    except (NotImplementedError, OSError):
        return False
    return True


def _link_directory(link: Path, target: Path) -> None:
    try:
        link.symlink_to(target, target_is_directory=True)
        return
    except (NotImplementedError, OSError) as exc:
        if os.name != "nt":
            pytest.skip(f"directory symlinks are not available: {exc}")

    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        pytest.skip(f"directory links are not available: {result.stderr or result.stdout}")


def _terminal_recovery_operation(
    context,
    project_id: str,
    state: str,
) -> tuple[Path, dict]:
    operation_id = "c" * 32
    operation_dir = (
        context["app"].state.store.projects_root
        / ".recovery"
        / project_id
        / operation_id
    )
    operation_dir.mkdir(parents=True)
    (operation_dir / "marker.json").write_text(
        json.dumps(
            {
                "project_id": project_id,
                "operation_id": operation_id,
                "operation": "continuity",
                "state": state,
            }
        ),
        encoding="utf-8",
    )
    manifest = {
        "project_id": project_id,
        "operation_id": operation_id,
        "operation": "continuity",
        "new_workspace": False,
        "entries": [{"path": "assets/new/output.png", "existed": False}],
        "created_dirs": ["assets/new"],
    }
    return operation_dir, manifest


def _write_manifest_case(
    context,
    operation_dir: Path,
    manifest: dict,
    case: str,
    monkeypatch,
) -> None:
    manifest_path = operation_dir / "manifest.json"
    if case == "malformed_json":
        manifest_path.write_text('{"credential":"operator-secret"', encoding="utf-8")
        return
    if case == "non_object":
        manifest_path.write_text(json.dumps([manifest]), encoding="utf-8")
        return
    if case == "missing_key":
        manifest.pop("created_dirs")
    elif case == "extra_key":
        manifest["metadata"] = {"credential": "operator-secret"}
    elif case == "foreign_project_id":
        manifest["project_id"] = "d" * 32
    elif case == "foreign_operation_id":
        manifest["operation_id"] = "e" * 32
    elif case == "foreign_operation":
        manifest["operation"] = "render"
    elif case == "non_boolean_new_workspace":
        manifest["new_workspace"] = 0
    elif case == "non_list_entries":
        manifest["entries"] = {"path": "assets/new/output.png", "existed": False}
    elif case == "non_list_created_dirs":
        manifest["created_dirs"] = "assets/new"
    elif case == "non_object_entry":
        manifest["entries"] = ["assets/new/output.png"]
    elif case == "alternate_entry_kind":
        manifest["entries"] = [
            {"path": "assets/new/output.png", "kind": "new"}
        ]
    elif case == "entry_metadata":
        manifest["entries"][0]["credential"] = "operator-secret"
    elif case == "non_string_entry_path":
        manifest["entries"][0]["path"] = ["assets", "new", "output.png"]
    elif case == "non_boolean_existed":
        manifest["entries"][0]["existed"] = 0
    elif case == "noncanonical_entry_path":
        manifest["entries"][0]["path"] = "assets/./new/output.png"
    elif case == "traversing_entry_path":
        manifest["entries"][0]["path"] = "assets/../outside.png"
    elif case == "noncanonical_created_dir":
        manifest["created_dirs"] = ["assets\\new"]
    elif case == "traversing_created_dir":
        manifest["created_dirs"] = ["assets/../outside"]
    elif case in TERMINAL_MANIFEST_PLATFORM_PATHS:
        manifest["entries"][0]["path"] = TERMINAL_MANIFEST_PLATFORM_PATHS[case]
    elif case == "reserved_created_dir":
        manifest["created_dirs"] = ["assets/CON.cache"]
    elif case == "control_created_dir":
        manifest["created_dirs"] = ["assets/new\x7f"]
    elif case == "duplicate_entry":
        manifest["entries"].append(manifest["entries"][0].copy())
    elif case == "duplicate_created_dir":
        manifest["created_dirs"].append(manifest["created_dirs"][0])
    elif case == "case_alias_new_entries":
        manifest["entries"] = [
            {"path": "assets/A.png", "existed": False},
            {"path": "assets/a.png", "existed": False},
        ]
        manifest["created_dirs"] = []
    elif case == "case_alias_mixed_entries":
        manifest["entries"] = [
            {"path": "assets/A.png", "existed": True},
            {"path": "assets/a.png", "existed": False},
        ]
        manifest["created_dirs"] = []
        backup = operation_dir / "backups" / "assets" / "A.png"
        backup.parent.mkdir(parents=True)
        backup.write_bytes(b"backup")
    elif case == "case_alias_created_dirs":
        manifest["created_dirs"] = ["assets/New", "assets/new"]
    elif case == "case_alias_file_created_dir":
        manifest["entries"] = [{"path": "assets/A.png", "existed": False}]
        manifest["created_dirs"] = ["assets/a.png"]
    elif case == "case_alias_file_ancestor":
        manifest["entries"] = [
            {"path": "assets/A", "existed": False},
            {"path": "ASSETS/a/child.png", "existed": False},
        ]
        manifest["created_dirs"] = []
    elif case == "case_alias_file_created_dir_ancestor":
        manifest["entries"] = [{"path": "assets/A", "existed": False}]
        manifest["created_dirs"] = ["ASSETS/a/child"]
    elif case == "file_ancestor":
        manifest["entries"] = [
            {"path": "assets/new", "existed": False},
            {"path": "assets/new/output.png", "existed": False},
        ]
        manifest["created_dirs"] = []
    elif case == "file_directory_conflict":
        manifest["entries"] = [{"path": "assets", "existed": False}]
        manifest["created_dirs"] = ["assets/new"]
    elif case == "missing_backup":
        manifest["entries"][0]["existed"] = True
    elif case == "backup_for_new_file":
        backup = operation_dir / "backups" / "assets" / "new" / "output.png"
        backup.parent.mkdir(parents=True)
        backup.write_bytes(b"unexpected")
    elif case == "unexpected_backup_file":
        backup = operation_dir / "backups" / "unlisted.bin"
        backup.parent.mkdir(parents=True)
        backup.write_bytes(b"unexpected")
    elif case == "unexpected_backup_directory":
        (operation_dir / "backups" / "unlisted").mkdir(parents=True)
    elif case == "mismatched_backup_path":
        manifest["entries"][0]["existed"] = True
        backup = operation_dir / "backups" / "assets" / "new" / "other.png"
        backup.parent.mkdir(parents=True)
        backup.write_bytes(b"wrong path")
    elif case == "nonregular_backup":
        manifest["entries"][0]["existed"] = True
        (operation_dir / "backups" / "assets" / "new" / "output.png").mkdir(
            parents=True
        )
    elif case == "linked_backup_file":
        manifest["entries"][0]["existed"] = True
        backup = operation_dir / "backups" / "assets" / "new" / "output.png"
        backup.parent.mkdir(parents=True)
        outside = context["tmp_path"] / "outside-backup.bin"
        outside.write_bytes(b"outside")
        if not _link_file(backup, outside):
            backup.write_bytes(b"outside")
            original_is_symlink = Path.is_symlink
            monkeypatch.setattr(
                Path,
                "is_symlink",
                lambda path: path == backup or original_is_symlink(path),
            )
    elif case == "linked_backup_directory":
        manifest["entries"] = [{"path": "linked/output.png", "existed": True}]
        manifest["created_dirs"] = []
        backups = operation_dir / "backups"
        backups.mkdir()
        outside = context["tmp_path"] / "outside-backup-dir"
        outside.mkdir()
        (outside / "output.png").write_bytes(b"outside")
        linked = backups / "linked"
        try:
            linked.symlink_to(outside, target_is_directory=True)
        except (NotImplementedError, OSError):
            linked.mkdir()
            (linked / "output.png").write_bytes(b"outside")
            original_is_junction = getattr(Path, "is_junction", lambda path: False)
            monkeypatch.setattr(
                Path,
                "is_junction",
                lambda path: path == linked or original_is_junction(path),
                raising=False,
            )
    elif case == "hardlinked_backup_file":
        manifest["entries"][0]["existed"] = True
        backup = operation_dir / "backups" / "assets" / "new" / "output.png"
        backup.parent.mkdir(parents=True)
        outside = context["tmp_path"] / "outside-hardlink.bin"
        outside.write_bytes(b"outside")
        try:
            os.link(outside, backup)
        except (NotImplementedError, OSError) as exc:
            pytest.skip(f"hard links are not available: {exc}")
    else:
        raise AssertionError(f"Unknown terminal manifest case: {case}")
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")


def _prepare_project_surface(context, client: TestClient) -> dict:
    project = _create_project(client, title="Bob's project")
    store = context["app"].state.store
    storyboard = {
        "shots": [
            {
                "id": "s1",
                "scene_id": "scene-1",
                "index": 1,
                "beat": "Hook",
                "prompt": "A safe test prompt.",
                "characters": [],
                "location": None,
                "props": [],
                "status": "ready",
                "consistency_score": 100,
                "output_url": None,
                "output_path": None,
                "asset_ids": [],
                "version": 1,
                "history": [],
            }
        ]
    }
    store.write_artifact(project["id"], "episode_storyboard.json", storyboard)
    media = store.project_dir(project["id"]) / "assets" / "images" / "character" / "a.png"
    media.parent.mkdir(parents=True, exist_ok=True)
    media.write_bytes(b"png")
    return project


def _finite_stream(_project_id: str):
    async def generate():
        yield "event: done\ndata: {}\n\n"

    return generate()


def _cleanup_guard(project_recovery: Path) -> tuple[Path, dict]:
    guards = list(project_recovery.glob("*.cleanup.json"))
    assert len(guards) == 1
    guard = json.loads(guards[0].read_text(encoding="utf-8"))
    assert set(guard) == {"project_id", "operation_id", "operation", "state"}
    return guards[0], guard


def _assert_project_recovery_quarantine(
    context,
    client: TestClient,
    project_id: str,
    monkeypatch,
) -> None:
    monkeypatch.setattr(context["app"].state.events, "stream", _finite_stream)
    responses = [
        client.get(f"/api/projects/{project_id}"),
        client.get(f"/api/projects/{project_id}/media/assets/images/missing.png"),
        client.get(f"/api/projects/{project_id}/events"),
        client.patch(
            f"/api/projects/{project_id}/continuity",
            json={"project_type": "single_video"},
        ),
    ]
    assert [response.status_code for response in responses] == [503] * 4
    assert [response.json() for response in responses] == [
        {"detail": "Project is unavailable pending recovery"}
    ] * 4


SURFACE_CASES = [
    ("GET", "", {}),
    ("PATCH", "/continuity", {"json": {}}),
    (
        "POST",
        "/assets/upload",
        {
            "data": {"kind": "character", "label": "A"},
            "files": {"file": ("a.png", b"png", "image/png")},
        },
    ),
    ("GET", "/media/assets/images/character/a.png", {}),
    ("PATCH", "/shots/s1", {"json": {"prompt": "Changed"}}),
    (
        "POST",
        "/prompt-optimize",
        {
            "json": {
                "target": "shot",
                "target_id": "s1",
                "source_text": "Prompt",
                "text_key": "text-key",
            }
        },
    ),
    (
        "POST",
        "/shots/s1/regenerate",
        {"json": {"video_key": "video-key"}},
    ),
    ("POST", "/render", {"json": {"video_key": "video-key"}}),
    ("GET", "/events", {}),
]


@pytest.mark.parametrize(("method", "path_suffix", "request_kwargs"), SURFACE_CASES)
def test_other_users_project_is_hidden_as_404(
    ownership_context, monkeypatch, method, path_suffix, request_kwargs
):
    project = _prepare_project_surface(ownership_context, _bob(ownership_context))
    monkeypatch.setattr(
        ownership_context["app"].state.events,
        "stream",
        _finite_stream,
    )
    monkeypatch.setattr(
        "server.app.main.optimize_text_prompt",
        lambda **kwargs: {"optimized_text": "safe", "notes": []},
    )
    monkeypatch.setattr(
        "server.app.main.run_single_shot_generation",
        lambda **kwargs: {"output_path": None, "tool_result": {}},
    )
    monkeypatch.setattr(
        "server.app.main.render_short_drama_project",
        lambda **kwargs: pytest.fail("provider must not run for another user's project"),
    )

    response = _alice(ownership_context).request(
        method,
        f"/api/projects/{project['id']}{path_suffix}",
        **request_kwargs,
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "Project not found"}


@pytest.mark.parametrize(
    ("method", "path_suffix"),
    [
        ("PATCH", "/continuity"),
        ("POST", "/assets/upload"),
        ("PATCH", "/shots/s1"),
        ("POST", "/prompt-optimize"),
        ("POST", "/shots/s1/regenerate"),
        ("POST", "/render"),
    ],
)
def test_other_users_project_is_hidden_before_body_or_media_validation(
    ownership_context, method, path_suffix
):
    project = _create_project(_bob(ownership_context), title="Bob's project")

    response = _alice(ownership_context).request(
        method,
        f"/api/projects/{project['id']}{path_suffix}",
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "Project not found"}


@pytest.mark.parametrize(
    ("method", "path_suffix"),
    [
        ("PATCH", "/continuity"),
        ("PATCH", "/shots/s1"),
        ("POST", "/prompt-optimize"),
        ("POST", "/shots/s1/regenerate"),
        ("POST", "/render"),
    ],
)
def test_other_users_project_is_hidden_before_malformed_json_parsing(
    ownership_context, method, path_suffix
):
    project = _create_project(_bob(ownership_context), title="Bob's project")

    response = _alice(ownership_context).request(
        method,
        f"/api/projects/{project['id']}{path_suffix}",
        content=b'{"unterminated":',
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "Project not found"}


def test_other_users_project_is_hidden_before_malformed_multipart_parsing(
    ownership_context,
):
    project = _create_project(_bob(ownership_context), title="Bob's project")

    response = _alice(ownership_context).post(
        f"/api/projects/{project['id']}/assets/upload",
        content=b"--wrong-boundary\r\ninvalid multipart",
        headers={"Content-Type": "multipart/form-data; boundary=expected-boundary"},
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "Project not found"}


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/api/projects"),
        ("POST", "/api/projects/import"),
        ("POST", "/api/projects/short-drama"),
        ("PATCH", "/api/projects/not-owned/continuity"),
        ("PATCH", "/api/projects/not-owned/shots/s1"),
        ("POST", "/api/projects/not-owned/prompt-optimize"),
        ("POST", "/api/projects/not-owned/shots/s1/regenerate"),
        ("POST", "/api/projects/not-owned/render"),
    ],
)
def test_invalid_origin_precedes_malformed_project_json(
    ownership_context, method, path
):
    response = _alice(ownership_context).request(
        method,
        path,
        content=b'{"unterminated":',
        headers={"Content-Type": "application/json", "Origin": "https://evil.example"},
    )

    assert response.status_code == 403
    assert response.json() == {"detail": "Invalid request origin"}


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/api/projects"),
        ("POST", "/api/projects/import"),
        ("POST", "/api/projects/short-drama"),
        ("PATCH", "/api/projects/not-owned/continuity"),
        ("PATCH", "/api/projects/not-owned/shots/s1"),
        ("POST", "/api/projects/not-owned/prompt-optimize"),
        ("POST", "/api/projects/not-owned/shots/s1/regenerate"),
        ("POST", "/api/projects/not-owned/render"),
    ],
)
def test_anonymous_json_mutation_rejects_before_reading_body(
    ownership_context, monkeypatch, method, path
):
    body_reads: list[bool] = []

    async def reject_body_read(request: Request) -> bytes:
        body_reads.append(True)
        pytest.fail("anonymous request body was read")

    monkeypatch.setattr(Request, "body", reject_body_read)
    client = TestClient(
        ownership_context["app"],
        base_url=AUTH_ORIGIN,
        raise_server_exceptions=False,
        headers={"Origin": AUTH_ORIGIN},
    )

    response = client.request(
        method,
        path,
        content=b'{"title":"Unread"}',
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 401
    assert body_reads == []


def test_anonymous_upload_rejects_before_multipart_parsing(
    ownership_context, monkeypatch
):
    form_parses: list[bool] = []

    async def reject_form_parse(parser: MultiPartParser):
        form_parses.append(True)
        pytest.fail("anonymous multipart body was parsed")

    monkeypatch.setattr(MultiPartParser, "parse", reject_form_parse)
    client = TestClient(
        ownership_context["app"],
        base_url=AUTH_ORIGIN,
        raise_server_exceptions=False,
        headers={"Origin": AUTH_ORIGIN},
    )

    response = client.post(
        "/api/projects/not-owned/assets/upload",
        data={"kind": "character", "label": "Unread"},
        files={"file": ("unread.png", b"unread", "image/png")},
    )

    assert response.status_code == 401
    assert form_parses == []


def test_invalid_origin_upload_rejects_before_multipart_parsing(
    ownership_context, monkeypatch
):
    form_parses: list[bool] = []

    async def reject_form_parse(parser: MultiPartParser):
        form_parses.append(True)
        pytest.fail("invalid-Origin multipart body was parsed")

    monkeypatch.setattr(MultiPartParser, "parse", reject_form_parse)

    response = _alice(ownership_context).post(
        "/api/projects/not-owned/assets/upload",
        headers={"Origin": "https://evil.example"},
        data={"kind": "character", "label": "Unread"},
        files={"file": ("unread.png", b"unread", "image/png")},
    )

    assert response.status_code == 403
    assert response.json() == {"detail": "Invalid request origin"}
    assert form_parses == []


def test_authorized_malformed_project_bodies_preserve_validation_statuses(
    ownership_context,
):
    project = _create_project(_alice(ownership_context), title="Alice's project")

    malformed_json = _alice(ownership_context).patch(
        f"/api/projects/{project['id']}/continuity",
        content=b'{"unterminated":',
        headers={"Content-Type": "application/json"},
    )
    malformed_multipart = _alice(ownership_context).post(
        f"/api/projects/{project['id']}/assets/upload",
        content=b"--wrong-boundary\r\ninvalid multipart",
        headers={"Content-Type": "multipart/form-data; boundary=expected-boundary"},
    )

    assert malformed_json.status_code == 422
    assert malformed_multipart.status_code == 400


@pytest.mark.parametrize(
    ("method", "path_suffix"),
    [
        ("PATCH", "/continuity"),
        ("PATCH", "/shots/s1"),
        ("POST", "/prompt-optimize"),
        ("POST", "/shots/s1/regenerate"),
        ("POST", "/render"),
    ],
)
def test_malformed_project_json_authorizes_without_taking_write_lock(
    ownership_context, monkeypatch, method, path_suffix
):
    project = _create_project(_alice(ownership_context), title="Parse ordering")
    calls: list[str] = []
    original_require_owned = ProjectRepository.require_owned
    original_require_owned_for_update = ProjectRepository.require_owned_for_update

    def observed_require_owned(repository, project_id, owner_user_id):
        result = original_require_owned(repository, project_id, owner_user_id)
        calls.append("require_owned")
        return result

    def observed_require_owned_for_update(repository, project_id, owner_user_id):
        result = original_require_owned_for_update(
            repository,
            project_id,
            owner_user_id,
        )
        calls.append("require_owned_for_update")
        return result

    monkeypatch.setattr(ProjectRepository, "require_owned", observed_require_owned)
    monkeypatch.setattr(
        ProjectRepository,
        "require_owned_for_update",
        observed_require_owned_for_update,
    )

    response = _alice(ownership_context).request(
        method,
        f"/api/projects/{project['id']}{path_suffix}",
        content=b'{"unterminated":',
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 422
    assert calls == ["require_owned"]


def test_slow_project_json_parses_between_nonlocking_auth_and_write_lock(
    ownership_context, monkeypatch
):
    project = _create_project(_alice(ownership_context), title="Slow parse ordering")
    calls: list[str] = []
    parse_started = Event()
    release_parse = Event()
    original_require_owned = ProjectRepository.require_owned
    original_require_owned_for_update = ProjectRepository.require_owned_for_update

    from server.app import main as main_module

    original_parse_json_request = main_module.parse_json_request

    def observed_require_owned(repository, project_id, owner_user_id):
        result = original_require_owned(repository, project_id, owner_user_id)
        calls.append("require_owned")
        return result

    def observed_require_owned_for_update(repository, project_id, owner_user_id):
        result = original_require_owned_for_update(
            repository,
            project_id,
            owner_user_id,
        )
        calls.append("require_owned_for_update")
        return result

    async def controlled_parse(request, model, **kwargs):
        calls.append("parse_started")
        parse_started.set()
        assert release_parse.wait(timeout=5), "test did not release controlled parser"
        result = await original_parse_json_request(request, model, **kwargs)
        calls.append("parse_finished")
        return result

    monkeypatch.setattr(ProjectRepository, "require_owned", observed_require_owned)
    monkeypatch.setattr(
        ProjectRepository,
        "require_owned_for_update",
        observed_require_owned_for_update,
    )
    monkeypatch.setattr(main_module, "parse_json_request", controlled_parse)

    with ThreadPoolExecutor(max_workers=1) as executor:
        response_future = executor.submit(
            _alice(ownership_context).patch,
            f"/api/projects/{project['id']}/continuity",
            json={"project_type": "single_video"},
        )
        assert parse_started.wait(timeout=5), "controlled parser did not start"
        calls_while_parsing = list(calls)
        release_parse.set()
        response = response_future.result(timeout=5)

    assert response.status_code == 200, response.text
    assert calls_while_parsing == ["require_owned", "parse_started"]
    assert calls[:4] == [
        "require_owned",
        "parse_started",
        "parse_finished",
        "require_owned_for_update",
    ]


def test_malformed_upload_authorizes_without_taking_write_lock(
    ownership_context, monkeypatch
):
    project = _create_project(_alice(ownership_context), title="Upload parse ordering")
    calls: list[str] = []
    original_require_owned = ProjectRepository.require_owned
    original_require_owned_for_update = ProjectRepository.require_owned_for_update

    def observed_require_owned(repository, project_id, owner_user_id):
        result = original_require_owned(repository, project_id, owner_user_id)
        calls.append("require_owned")
        return result

    def observed_require_owned_for_update(repository, project_id, owner_user_id):
        result = original_require_owned_for_update(
            repository,
            project_id,
            owner_user_id,
        )
        calls.append("require_owned_for_update")
        return result

    monkeypatch.setattr(ProjectRepository, "require_owned", observed_require_owned)
    monkeypatch.setattr(
        ProjectRepository,
        "require_owned_for_update",
        observed_require_owned_for_update,
    )

    response = _alice(ownership_context).post(
        f"/api/projects/{project['id']}/assets/upload",
        content=b"--wrong-boundary\r\ninvalid multipart",
        headers={"Content-Type": "multipart/form-data; boundary=expected-boundary"},
    )

    assert response.status_code == 400
    assert calls == ["require_owned"]


@pytest.mark.parametrize(
    "mutation_family",
    ["continuity", "upload", "shot", "regenerate", "render"],
)
def test_existing_mutation_locks_and_rechecks_before_first_project_boundary(
    ownership_context, monkeypatch, mutation_family
):
    project = _create_project(_alice(ownership_context), title="Mutation boundary")
    project_id = project["id"]
    store = ownership_context["app"].state.store
    calls: list[str] = []
    original_require_owned = ProjectRepository.require_owned
    original_require_owned_for_update = ProjectRepository.require_owned_for_update
    original_available = store.assert_project_available

    def observed_require_owned(repository, owned_project_id, owner_user_id):
        result = original_require_owned(repository, owned_project_id, owner_user_id)
        calls.append("require_owned")
        return result

    def observed_require_owned_for_update(repository, owned_project_id, owner_user_id):
        result = original_require_owned_for_update(
            repository,
            owned_project_id,
            owner_user_id,
        )
        calls.append("require_owned_for_update")
        return result

    def observed_available(available_project_id):
        result = original_available(available_project_id)
        calls.append("available")
        return result

    def stop_at_boundary(*args, **kwargs):
        calls.append("project_boundary")
        raise RuntimeError("controlled first project boundary")

    monkeypatch.setattr(ProjectRepository, "require_owned", observed_require_owned)
    monkeypatch.setattr(
        ProjectRepository,
        "require_owned_for_update",
        observed_require_owned_for_update,
    )
    monkeypatch.setattr(store, "assert_project_available", observed_available)
    if mutation_family == "continuity":
        monkeypatch.setattr(store, "begin_project_mutation", stop_at_boundary)
    else:
        monkeypatch.setattr(store, "read_artifact", stop_at_boundary)

    if mutation_family == "upload":
        from server.app import main as main_module

        original_safe_destination = main_module.safe_project_media_destination

        def observed_safe_destination(*args, **kwargs):
            result = original_safe_destination(*args, **kwargs)
            calls.append("dynamic_path")
            return result

        monkeypatch.setattr(
            main_module,
            "safe_project_media_destination",
            observed_safe_destination,
        )
        response = _alice(ownership_context).post(
            f"/api/projects/{project_id}/assets/upload",
            data={"kind": "character", "label": "Uploaded"},
            files={"file": ("uploaded.png", b"uploaded", "image/png")},
        )
    elif mutation_family == "shot":
        response = _alice(ownership_context).patch(
            f"/api/projects/{project_id}/shots/s1",
            json={"prompt": "Changed prompt"},
        )
    elif mutation_family == "regenerate":
        response = _alice(ownership_context).post(
            f"/api/projects/{project_id}/shots/s1/regenerate",
            json={"video_key": "video-key"},
        )
    elif mutation_family == "render":
        response = _alice(ownership_context).post(
            f"/api/projects/{project_id}/render",
            json={"video_key": "video-key"},
        )
    else:
        response = _alice(ownership_context).patch(
            f"/api/projects/{project_id}/continuity",
            json={"project_type": "single_video"},
        )

    assert response.status_code == 500
    expected_prefix = ["require_owned", "available"]
    if mutation_family == "upload":
        expected_prefix.append("dynamic_path")
    expected_prefix.extend(
        ["require_owned_for_update", "available", "project_boundary"]
    )
    assert calls == expected_prefix


def test_prompt_optimization_never_takes_write_lock_including_provider_call(
    ownership_context, monkeypatch
):
    project = _create_project(_alice(ownership_context), title="Prompt lock regression")
    calls: list[str] = []
    provider_observations: list[list[str]] = []
    original_require_owned = ProjectRepository.require_owned
    original_require_owned_for_update = ProjectRepository.require_owned_for_update
    store = ownership_context["app"].state.store
    original_available = store.assert_project_available

    def observed_require_owned(repository, project_id, owner_user_id):
        result = original_require_owned(repository, project_id, owner_user_id)
        calls.append("require_owned")
        return result

    def observed_require_owned_for_update(repository, project_id, owner_user_id):
        result = original_require_owned_for_update(
            repository,
            project_id,
            owner_user_id,
        )
        calls.append("require_owned_for_update")
        return result

    def observed_available(project_id):
        result = original_available(project_id)
        calls.append("available")
        return result

    def observed_provider(**kwargs):
        provider_observations.append(list(calls))
        calls.append("provider")
        return {"optimized_text": "Optimized", "notes": []}

    monkeypatch.setattr(ProjectRepository, "require_owned", observed_require_owned)
    monkeypatch.setattr(
        ProjectRepository,
        "require_owned_for_update",
        observed_require_owned_for_update,
    )
    monkeypatch.setattr(store, "assert_project_available", observed_available)
    monkeypatch.setattr("server.app.main.optimize_text_prompt", observed_provider)

    response = _alice(ownership_context).post(
        f"/api/projects/{project['id']}/prompt-optimize",
        json={
            "target": "project",
            "target_id": project["id"],
            "source_text": "Original",
            "text_key": "text-key",
        },
    )

    assert response.status_code == 200, response.text
    assert provider_observations == [["require_owned", "available"]]
    assert calls == ["require_owned", "available", "provider"]


def test_authorized_upload_is_bounded_before_file_spooling(
    ownership_context, monkeypatch
):
    from server.app.media_files import MAX_IMAGE_BYTES

    project = _create_project(_alice(ownership_context), title="Alice's project")
    original_write = UploadFile.write
    spooled_bytes = 0

    async def bounded_spool(upload: UploadFile, data: bytes) -> None:
        nonlocal spooled_bytes
        spooled_bytes += len(data)
        if spooled_bytes > MAX_IMAGE_BYTES:
            pytest.fail("multipart parser spooled an oversized file")
        await original_write(upload, data)

    monkeypatch.setattr(UploadFile, "write", bounded_spool)

    response = _alice(ownership_context).post(
        f"/api/projects/{project['id']}/assets/upload",
        data={"kind": "character", "label": "Too large"},
        files={
            "file": (
                "oversized.png",
                b"x" * (MAX_IMAGE_BYTES + 128 * 1024),
                "image/png",
            )
        },
    )

    assert response.status_code == 413
    assert spooled_bytes <= MAX_IMAGE_BYTES


def _resolve_openapi_ref(document: dict, ref: str):
    assert ref.startswith("#/"), f"unsupported OpenAPI reference: {ref}"
    current = document
    for raw_token in ref[2:].split("/"):
        token = raw_token.replace("~1", "/").replace("~0", "~")
        assert isinstance(current, dict) and token in current, f"dangling OpenAPI reference: {ref}"
        current = current[token]
    return current


def _assert_openapi_refs_resolve(document: dict, node, resolved: set[str] | None = None):
    resolved = resolved if resolved is not None else set()
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str):
            target = _resolve_openapi_ref(document, ref)
            if ref not in resolved:
                resolved.add(ref)
                _assert_openapi_refs_resolve(document, target, resolved)
        for value in node.values():
            _assert_openapi_refs_resolve(document, value, resolved)
    elif isinstance(node, list):
        for value in node:
            _assert_openapi_refs_resolve(document, value, resolved)


def _dereference_openapi_schema(document: dict, schema: dict) -> dict:
    ref = schema.get("$ref")
    return _resolve_openapi_ref(document, ref) if isinstance(ref, str) else schema


def test_project_request_openapi_schema_fails_fast_on_local_ref_cycles():
    class CyclicSchemaModel:
        @classmethod
        def model_json_schema(cls):
            return {
                "$defs": {"Loop": {"$ref": "#/$defs/Loop"}},
                "$ref": "#/$defs/Loop",
            }

    with pytest.raises(ValueError, match="Cyclic local schema reference"):
        _json_request_openapi(CyclicSchemaModel)


def test_project_mutation_openapi_keeps_valid_request_body_contracts(ownership_context):
    document = ownership_context["app"].openapi()
    paths = document["paths"]
    operations = [
        ("/api/projects", "post", "application/json"),
        ("/api/projects/import", "post", "application/json"),
        ("/api/projects/short-drama", "post", "application/json"),
        ("/api/projects/{project_id}/continuity", "patch", "application/json"),
        ("/api/projects/{project_id}/assets/upload", "post", "multipart/form-data"),
        ("/api/projects/{project_id}/shots/{shot_id}", "patch", "application/json"),
        ("/api/projects/{project_id}/prompt-optimize", "post", "application/json"),
        ("/api/projects/{project_id}/shots/{shot_id}/regenerate", "post", "application/json"),
        ("/api/projects/{project_id}/render", "post", "application/json"),
    ]

    request_schemas = {}
    for path, method, media_type in operations:
        request_body = paths[path][method]["requestBody"]
        assert request_body["required"] is True
        assert set(request_body["content"]) == {media_type}
        schema = request_body["content"][media_type]["schema"]
        assert schema.get("type") == "object"
        assert schema.get("properties")
        _assert_openapi_refs_resolve(document, schema)
        request_schemas[path] = schema

    _assert_openapi_refs_resolve(document, document)

    import_schema = request_schemas["/api/projects/import"]
    assert import_schema["properties"]["title"]["maxLength"] == 255
    imported_series = _dereference_openapi_schema(
        document,
        import_schema["properties"]["series_bible"],
    )
    assert {"title", "characters", "assets"} <= set(imported_series["properties"])

    continuity_schema = request_schemas["/api/projects/{project_id}/continuity"]
    assert continuity_schema["properties"]["project_type"]["enum"] == [
        "single_video",
        "mini_series",
        "long_series",
    ]
    continuity_series = _dereference_openapi_schema(
        document,
        continuity_schema["properties"]["series_bible"],
    )
    assert "relationship_map" in continuity_series["properties"]

    shot_schema = request_schemas["/api/projects/{project_id}/shots/{shot_id}"]
    shot_language_option = next(
        option
        for option in shot_schema["properties"]["shot_language"]["anyOf"]
        if option.get("type") != "null"
    )
    shot_language = _dereference_openapi_schema(document, shot_language_option)
    assert "shot_size" in shot_language["properties"]


def test_repository_create_list_and_owned_lookup_are_owner_scoped(ownership_context):
    from server.app.projects.repository import ProjectRepository

    db = ownership_context["db"]
    repository = ProjectRepository(db)
    older = repository.create(
        owner_user_id=ALICE_ID,
        title="Older",
        mode="short_drama",
        project_type="single_video",
    )
    newer = repository.create(
        owner_user_id=ALICE_ID,
        title="Newer",
        mode="short_drama",
        project_type="single_video",
    )
    bob = repository.create(
        owner_user_id=BOB_ID,
        title="Bob",
        mode="short_drama",
        project_type="single_video",
    )
    older.updated_at = datetime.now(UTC) - timedelta(days=1)
    newer.updated_at = datetime.now(UTC)
    db.flush()

    assert repository.get_owned(older.id, ALICE_ID) is older
    assert repository.get_owned(bob.id, ALICE_ID) is None
    assert [item.id for item in repository.list(ALICE_ID)] == [newer.id, older.id]
    assert repository.list(BOB_ID) == [bob]

    with pytest.raises(Exception) as exc_info:
        repository.require_owned(bob.id, ALICE_ID)
    assert getattr(exc_info.value, "status_code", None) == 404


def test_project_creation_uses_current_owner_and_server_uuid(ownership_context):
    from server.app.projects.models import ProjectRecord

    response = _alice(ownership_context).post(
        "/api/projects",
        json={
            "id": "attacker-selected-id",
            "owner_user_id": BOB_ID,
            "title": "Mine",
            "project_type": "single_video",
        },
    )

    assert response.status_code == 422
    created = _create_project(_alice(ownership_context))
    assert created["id"] != "attacker-selected-id"
    assert set(created) == {
        "id",
        "title",
        "mode",
        "project_type",
        "created_at",
        "updated_at",
    }
    assert ownership_context["db"].get(ProjectRecord, created["id"]).owner_user_id == ALICE_ID


def test_short_drama_creation_uses_current_owner(ownership_context, monkeypatch):
    from server.app.projects.models import ProjectRecord

    monkeypatch.setattr(
        "server.app.main.generate_short_drama_storyboard",
        lambda **kwargs: {
            "series_bible": {
                "title": "Generated",
                "mode": "short_drama",
                "style_lock": "",
                "characters": [],
                "assets": [],
            },
            "storyboard": {"shots": []},
        },
    )

    response = _alice(ownership_context).post(
        "/api/projects/short-drama",
        json={
            "title": "Generated",
            "prompt": "Generate it",
            "text_key": "text-key",
            "image_key": "image-key",
            "video_key": "video-key",
        },
    )

    assert response.status_code == 200, response.text
    project_id = response.json()["project"]["id"]
    assert ownership_context["db"].get(ProjectRecord, project_id).owner_user_id == ALICE_ID


def test_project_route_inventory_has_exactly_fourteen_surfaces(ownership_context):
    routes = {
        (method, route.path)
        for route in ownership_context["app"].routes
        if getattr(route, "path", "").startswith("/api/projects")
        for method in route.methods
        if method != "HEAD"
    }
    assert routes == {
        ("POST", "/api/projects"),
        ("POST", "/api/projects/short-drama"),
        ("GET", "/api/projects"),
        ("POST", "/api/projects/import"),
        ("GET", "/api/projects/latest"),
        ("GET", "/api/projects/{project_id}"),
        ("PATCH", "/api/projects/{project_id}/continuity"),
        ("POST", "/api/projects/{project_id}/assets/upload"),
        ("GET", "/api/projects/{project_id}/media/{relative_path:path}"),
        ("PATCH", "/api/projects/{project_id}/shots/{shot_id}"),
        ("POST", "/api/projects/{project_id}/prompt-optimize"),
        ("POST", "/api/projects/{project_id}/shots/{shot_id}/regenerate"),
        ("POST", "/api/projects/{project_id}/render"),
        ("GET", "/api/projects/{project_id}/events"),
    }


@pytest.mark.parametrize("path", ["/api/projects", "/api/projects/latest"])
def test_project_collection_gets_require_authentication(ownership_context, path):
    client = TestClient(
        ownership_context["app"],
        base_url=AUTH_ORIGIN,
        headers={"Origin": AUTH_ORIGIN},
        raise_server_exceptions=False,
    )

    assert client.get(path).status_code == 401


def test_global_latest_is_disabled_for_authenticated_users(ownership_context):
    response = _alice(ownership_context).get("/api/projects/latest")

    assert response.status_code == 404
    assert response.json() == {"detail": "Global latest project is disabled"}


def test_owner_filtered_project_list_hides_other_users_and_unowned(ownership_context):
    from server.app.projects.models import ProjectRecord
    from server.app.projects.repository import ProjectRepository

    alice_project = _create_project(_alice(ownership_context), title="Alice")
    _create_project(_bob(ownership_context), title="Bob")
    legacy = ProjectRecord(
        id="legacy-unowned",
        owner_user_id=None,
        title="Legacy",
        mode="short_drama",
        project_type="single_video",
    )
    ownership_context["db"].add(legacy)
    ownership_context["db"].commit()

    response = _alice(ownership_context).get("/api/projects")

    assert response.status_code == 200
    assert [project["id"] for project in response.json()["projects"]] == [alice_project["id"]]
    assert ProjectRepository(ownership_context["db"]).get_owned(legacy.id, ALICE_ID) is None
    assert _alice(ownership_context).get(f"/api/projects/{legacy.id}").status_code == 404


def _valid_import_payload() -> dict:
    return {
        "legacy_project_id": "legacy-information-only",
        "title": "Imported",
        "project_type": "single_video",
        "series_bible": {
            "title": "Imported",
            "mode": "short_drama",
            "style_lock": "",
            "characters": [],
            "assets": [
                {
                    "id": "asset-local",
                    "kind": "character",
                    "label": "Local",
                    "description": "",
                    "prompt": "",
                    "reference_images": ["local://media/image-1.png"],
                    "shot_ids": [],
                    "version": 1,
                }
            ],
        },
        "storyboard": {"shots": []},
        "continuity_plan": {"project_type": "single_video"},
    }


def _workspace_bytes(store, project_id: str) -> dict[str, bytes]:
    workspace = store.project_dir(project_id)
    return {
        path.relative_to(workspace).as_posix(): path.read_bytes()
        for path in workspace.rglob("*")
        if path.is_file()
    }


def _generated_storyboard_result() -> dict:
    return {
        "series_bible": {
            "title": "Generated",
            "mode": "short_drama",
            "style_lock": "",
            "characters": [],
            "assets": [],
        },
        "storyboard": {
            "shots": [
                {
                    "id": "s1",
                    "scene_id": "scene-1",
                    "index": 1,
                    "beat": "Opening",
                    "prompt": "Original prompt",
                    "characters": [],
                    "location": None,
                    "props": [],
                    "status": "ready",
                    "consistency_score": 100,
                    "output_url": None,
                    "output_path": None,
                    "asset_ids": [],
                    "version": 1,
                    "history": [],
                }
            ]
        },
    }


@pytest.mark.parametrize("create_family", ["draft", "short_drama"])
def test_create_commit_failure_rolls_back_record_and_new_workspace(
    ownership_context, monkeypatch, create_family
):
    from server.app.projects.models import ProjectRecord

    projects_root = ownership_context["tmp_path"] / "projects"
    before_entries = sorted(path.name for path in projects_root.iterdir())
    if create_family == "short_drama":
        monkeypatch.setattr(
            "server.app.main.generate_short_drama_storyboard",
            lambda **kwargs: _generated_storyboard_result(),
        )

    def fail_commit():
        raise RuntimeError("commit failed with password=create-secret")

    monkeypatch.setattr(ownership_context["db"], "commit", fail_commit)
    if create_family == "draft":
        response = _alice(ownership_context).post(
            "/api/projects",
            json={"title": "Draft", "project_type": "single_video"},
        )
    else:
        response = _alice(ownership_context).post(
            "/api/projects/short-drama",
            json={
                "title": "Generated",
                "prompt": "Generate a story",
                "text_key": "text-key",
                "image_key": "image-key",
                "video_key": "video-key",
            },
        )

    assert response.status_code == 500
    assert response.json() == {"detail": "Project creation failed"}
    assert list(ownership_context["db"].scalars(select(ProjectRecord))) == []
    assert sorted(path.name for path in projects_root.iterdir()) == before_entries


@pytest.mark.parametrize(
    "mutation_family",
    ["continuity", "upload", "shot", "regenerate", "render"],
)
def test_existing_project_commit_failure_restores_entire_workspace(
    ownership_context, monkeypatch, mutation_family
):
    client = _alice(ownership_context)
    project = _create_project(client, title="Compensation")
    project_id = project["id"]
    store = ownership_context["app"].state.store
    generated = _generated_storyboard_result()
    store.write_artifact(project_id, "series_bible.json", generated["series_bible"])
    store.write_asset_library(project_id, [])
    store.write_artifact(project_id, "episode_storyboard.json", generated["storyboard"])
    before_workspace = _workspace_bytes(store, project_id)
    record = ProjectRepository(ownership_context["db"]).require_owned(project_id, ALICE_ID)
    before_updated_at = record.updated_at

    def fake_regenerate(**kwargs):
        output = kwargs["project_dir"] / "assets" / "video" / "s1.mp4"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"generated-video")
        return {
            "operation": "reference_to_video",
            "reference_image_paths": [],
            "output_path": str(output),
            "cost_usd": 0,
            "tool_result": {"url": "https://video.example/s1.mp4"},
        }

    def fake_render(**kwargs):
        output = kwargs["project_dir"] / "renders" / "final.mp4"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"rendered-video")
        storyboard = kwargs["storyboard"]
        storyboard["shots"][0]["status"] = "complete"
        return {
            "final_path": str(output),
            "render_report": {"outputs": [{"path": str(output)}]},
            "storyboard": storyboard,
            "artifacts": {},
            "outputs": [],
        }

    monkeypatch.setattr("server.app.main.run_single_shot_generation", fake_regenerate)
    monkeypatch.setattr("server.app.main.render_short_drama_project", fake_render)

    def fail_commit():
        raise RuntimeError("commit failed with password=mutation-secret")

    monkeypatch.setattr(ownership_context["db"], "commit", fail_commit)
    if mutation_family == "continuity":
        response = client.patch(
            f"/api/projects/{project_id}/continuity",
            json={
                "project_type": "single_video",
                "series_bible": {"worldview": "Changed"},
            },
        )
    elif mutation_family == "upload":
        response = client.post(
            f"/api/projects/{project_id}/assets/upload",
            data={"kind": "character", "label": "Uploaded"},
            files={"file": ("uploaded.png", b"uploaded", "image/png")},
        )
    elif mutation_family == "shot":
        response = client.patch(
            f"/api/projects/{project_id}/shots/s1",
            json={"prompt": "Changed prompt"},
        )
    elif mutation_family == "regenerate":
        response = client.post(
            f"/api/projects/{project_id}/shots/s1/regenerate",
            json={"video_key": "video-key"},
        )
    else:
        response = client.post(
            f"/api/projects/{project_id}/render",
            json={"video_key": "video-key"},
        )

    assert response.status_code == 500
    assert response.json() == {"detail": "Project update failed"}
    assert _workspace_bytes(store, project_id) == before_workspace
    assert record.updated_at == before_updated_at


def test_owned_project_lock_uses_postgresql_for_update():
    statements = []
    project = type("LockedProject", (), {"id": LEGACY_ID})()

    class RecordingSession:
        def scalar(self, statement):
            statements.append(statement)
            return project

    locked = ProjectRepository(RecordingSession()).require_owned_for_update(
        LEGACY_ID,
        ALICE_ID,
    )

    sql = str(statements[0].compile(dialect=postgresql.dialect()))
    assert locked is project
    assert "FOR UPDATE" in sql


def test_owned_project_read_lock_uses_postgresql_for_share():
    statements = []
    project = type("LockedProject", (), {"id": LEGACY_ID})()

    class RecordingSession:
        def scalar(self, statement):
            statements.append(statement)
            return project

    locked = ProjectRepository(RecordingSession()).require_owned_for_read(
        LEGACY_ID,
        ALICE_ID,
    )

    sql = str(statements[0].compile(dialect=postgresql.dialect()))
    assert locked is project
    assert "FOR SHARE" in sql


def test_continuity_journal_never_copies_large_unrelated_media(
    ownership_context, monkeypatch
):
    client = _alice(ownership_context)
    project = _create_project(client, title="No whole workspace copy")
    store = ownership_context["app"].state.store
    unrelated = store.project_dir(project["id"]) / "assets" / "video" / "unrelated.mp4"
    unrelated.write_bytes(b"x" * (4 * 1024 * 1024))
    original_copy2 = shutil.copy2
    copied_sources: list[Path] = []

    def reject_copytree(*args, **kwargs):
        raise AssertionError("whole workspace copying is forbidden")

    def record_copy2(source, destination, *args, **kwargs):
        copied_sources.append(Path(source))
        return original_copy2(source, destination, *args, **kwargs)

    monkeypatch.setattr("server.app.storage.shutil.copytree", reject_copytree)
    monkeypatch.setattr("server.app.storage.shutil.copy2", record_copy2)

    response = client.patch(
        f"/api/projects/{project['id']}/continuity",
        json={
            "project_type": "single_video",
            "series_bible": {"worldview": "Changed without touching media"},
        },
    )

    assert response.status_code == 200, response.text
    assert unrelated.read_bytes() == b"x" * (4 * 1024 * 1024)
    assert unrelated not in copied_sources


def test_artifact_writes_use_atomic_file_replacement(ownership_context, monkeypatch):
    store = ownership_context["app"].state.store
    project_id = "11111111111141118111111111111111"
    replacements: list[tuple[Path, Path]] = []
    original_replace = os.replace

    def record_replace(source, destination):
        replacements.append((Path(source), Path(destination)))
        return original_replace(source, destination)

    monkeypatch.setattr("server.app.storage.os.replace", record_replace)

    destination = store.write_artifact(project_id, "state.json", {"value": 1})

    assert replacements
    assert replacements[-1][1] == destination
    assert replacements[-1][0].parent == destination.parent
    assert not replacements[-1][0].exists()


def test_restore_failure_retains_recovery_marker_and_quarantines_project(
    ownership_context, monkeypatch, caplog
):
    client = _alice(ownership_context)
    project = _create_project(client, title="Recovery marker")
    project_id = project["id"]
    store = ownership_context["app"].state.store
    caplog.set_level(logging.ERROR)

    def fail_commit_after_destroying_backup():
        recovery_root = store.projects_root / ".recovery" / project_id
        if recovery_root.is_dir():
            operation_dir = next(
                child for child in recovery_root.iterdir() if child.is_dir()
            )
            backups = list((operation_dir / "backups").rglob("continuity_plan.json"))
            if backups:
                backups[0].unlink()
        raise RuntimeError("commit failed with password=operator-secret")

    monkeypatch.setattr(ownership_context["db"], "commit", fail_commit_after_destroying_backup)

    response = client.patch(
        f"/api/projects/{project_id}/continuity",
        json={
            "project_type": "single_video",
            "series_bible": {"worldview": "Inconsistent state"},
        },
    )

    assert response.status_code == 500
    assert response.json() == {"detail": "Project update failed"}
    project_recovery = store.projects_root / ".recovery" / project_id
    operation_dirs = [child for child in project_recovery.iterdir() if child.is_dir()]
    assert len(operation_dirs) == 1
    marker = json.loads((operation_dirs[0] / "marker.json").read_text(encoding="utf-8"))
    assert marker == {
        "project_id": project_id,
        "operation_id": marker["operation_id"],
        "operation": "continuity",
        "state": "recovery_failed",
    }
    _guard_path, guard = _cleanup_guard(project_recovery)
    assert guard == {
        "project_id": project_id,
        "operation_id": marker["operation_id"],
        "operation": "continuity",
        "state": "cleanup_pending",
    }
    assert project_id in caplog.text
    assert marker["operation_id"] in caplog.text
    assert "recovery_failed" in caplog.text
    assert "operator-secret" not in caplog.text

    loaded = client.get(f"/api/projects/{project_id}")
    mutated = client.patch(
        f"/api/projects/{project_id}/continuity",
        json={"project_type": "single_video"},
    )
    assert loaded.status_code == 503
    assert mutated.status_code == 503
    assert loaded.json() == mutated.json() == {
        "detail": "Project is unavailable pending recovery"
    }


@pytest.mark.parametrize(
    "partial_removal",
    [False, True],
    ids=["before_tree", "partial_tree"],
)
def test_post_commit_cleanup_failure_leaves_secret_free_durable_quarantine(
    ownership_context, monkeypatch, caplog, partial_removal
):
    client = _alice(ownership_context)
    project = _create_project(client, title="Committed cleanup failure")
    project_id = project["id"]
    store = ownership_context["app"].state.store
    injected_secret = "cleanup-secret-after-commit"
    caplog.set_level(logging.ERROR, logger="server.app.project_recovery")

    def fail_operation_tree_cleanup(path, parent):
        operation_dir = Path(path)
        if partial_removal:
            (operation_dir / "marker.json").unlink()
            (operation_dir / "manifest.json").unlink()
        raise OSError(f"operation cleanup failed token={injected_secret}")

    monkeypatch.setattr(
        "server.app.storage._remove_controlled_tree",
        fail_operation_tree_cleanup,
    )

    response = client.patch(
        f"/api/projects/{project_id}/continuity",
        json={
            "project_type": "single_video",
            "series_bible": {"worldview": "Committed before cleanup"},
        },
    )

    assert response.status_code == 500
    assert response.json() == {"detail": "Project update failed"}
    assert injected_secret not in response.text + caplog.text
    project_recovery = store.projects_root / ".recovery" / project_id
    guard_path, guard = _cleanup_guard(project_recovery)
    assert guard == {
        "project_id": project_id,
        "operation_id": guard["operation_id"],
        "operation": "continuity",
        "state": "cleanup_failed",
    }
    operation_dir = project_recovery / guard["operation_id"]
    assert guard_path.parent == project_recovery
    assert operation_dir.is_dir()
    if partial_removal:
        assert not (operation_dir / "marker.json").exists()
        assert not (operation_dir / "manifest.json").exists()
    assert project_id in caplog.text
    assert guard["operation_id"] in caplog.text
    assert "state=cleanup_failed" in caplog.text
    _assert_project_recovery_quarantine(
        ownership_context,
        client,
        project_id,
        monkeypatch,
    )


def test_post_restore_cleanup_failure_preserves_compensation_and_quarantine(
    ownership_context, monkeypatch, caplog
):
    client = _alice(ownership_context)
    project = _create_project(client, title="Recovered cleanup failure")
    project_id = project["id"]
    store = ownership_context["app"].state.store
    before_workspace = _workspace_bytes(store, project_id)
    injected_secret = "cleanup-secret-after-restore"
    caplog.set_level(logging.ERROR, logger="server.app.project_recovery")

    def fail_commit():
        raise RuntimeError("commit failure credential=restore-trigger-secret")

    def fail_operation_tree_cleanup(path, parent):
        raise OSError(f"operation cleanup failed token={injected_secret}")

    monkeypatch.setattr(ownership_context["db"], "commit", fail_commit)
    monkeypatch.setattr(
        "server.app.storage._remove_controlled_tree",
        fail_operation_tree_cleanup,
    )

    response = client.patch(
        f"/api/projects/{project_id}/continuity",
        json={
            "project_type": "single_video",
            "series_bible": {"worldview": "Restored before cleanup"},
        },
    )

    assert response.status_code == 500
    assert response.json() == {"detail": "Project update failed"}
    assert _workspace_bytes(store, project_id) == before_workspace
    assert injected_secret not in response.text + caplog.text
    assert "restore-trigger-secret" not in response.text + caplog.text
    project_recovery = store.projects_root / ".recovery" / project_id
    _guard_path, guard = _cleanup_guard(project_recovery)
    assert guard == {
        "project_id": project_id,
        "operation_id": guard["operation_id"],
        "operation": "continuity",
        "state": "cleanup_failed",
    }
    assert (project_recovery / guard["operation_id"]).is_dir()
    assert project_id in caplog.text
    assert guard["operation_id"] in caplog.text
    assert "state=cleanup_failed" in caplog.text
    _assert_project_recovery_quarantine(
        ownership_context,
        client,
        project_id,
        monkeypatch,
    )


def test_cleanup_guard_removal_failure_leaves_nonhealthy_controlled_child(
    ownership_context, monkeypatch, caplog
):
    client = _alice(ownership_context)
    project = _create_project(client, title="Guard cleanup failure")
    project_id = project["id"]
    store = ownership_context["app"].state.store
    injected_secret = "cleanup-secret-removing-guard"
    caplog.set_level(logging.ERROR, logger="server.app.project_recovery")
    original_unlink = Path.unlink

    def fail_guard_unlink(path, *args, **kwargs):
        if path.name.endswith(".cleanup.json"):
            original_unlink(path, *args, **kwargs)
            raise OSError(f"guard cleanup failed token={injected_secret}")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_guard_unlink)

    response = client.patch(
        f"/api/projects/{project_id}/continuity",
        json={
            "project_type": "single_video",
            "series_bible": {"worldview": "Guard remains"},
        },
    )

    assert response.status_code == 500
    assert response.json() == {"detail": "Project update failed"}
    assert injected_secret not in response.text + caplog.text
    project_recovery = store.projects_root / ".recovery" / project_id
    guard_path, guard = _cleanup_guard(project_recovery)
    assert guard == {
        "project_id": project_id,
        "operation_id": guard["operation_id"],
        "operation": "continuity",
        "state": "cleanup_failed",
    }
    assert guard_path.is_file()
    assert not (project_recovery / guard["operation_id"]).exists()
    assert project_id in caplog.text
    assert guard["operation_id"] in caplog.text
    assert "state=cleanup_failed" in caplog.text
    _assert_project_recovery_quarantine(
        ownership_context,
        client,
        project_id,
        monkeypatch,
    )


def test_cleanup_validation_failure_is_logged_and_durably_quarantined(
    ownership_context, monkeypatch, caplog
):
    from server.app.storage import ProjectMutationJournal

    client = _alice(ownership_context)
    project = _create_project(client, title="Cleanup validation failure")
    project_id = project["id"]
    store = ownership_context["app"].state.store
    injected_secret = "cleanup-secret-validating-operation"
    caplog.set_level(logging.ERROR, logger="server.app.project_recovery")
    original_validate = ProjectMutationJournal._validate_operation_dir

    def fail_terminal_cleanup_validation(journal):
        marker_path = journal._operation_dir / "marker.json"
        if marker_path.is_file():
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
            if marker.get("state") == "committed":
                raise OSError(f"validation failed token={injected_secret}")
        return original_validate(journal)

    monkeypatch.setattr(
        ProjectMutationJournal,
        "_validate_operation_dir",
        fail_terminal_cleanup_validation,
    )

    response = client.patch(
        f"/api/projects/{project_id}/continuity",
        json={"project_type": "single_video"},
    )

    assert response.status_code == 500
    assert response.json() == {"detail": "Project update failed"}
    assert injected_secret not in response.text + caplog.text
    project_recovery = store.projects_root / ".recovery" / project_id
    _guard_path, guard = _cleanup_guard(project_recovery)
    assert guard["state"] == "cleanup_failed"
    assert project_id in caplog.text
    assert guard["operation_id"] in caplog.text
    assert "state=cleanup_failed" in caplog.text
    _assert_project_recovery_quarantine(
        ownership_context,
        client,
        project_id,
        monkeypatch,
    )


@pytest.mark.parametrize("terminal_state", ["committed", "recovered"])
def test_successful_terminal_cleanup_removes_journal_guard_and_recovery_root(
    ownership_context, monkeypatch, terminal_state
):
    client = _alice(ownership_context)
    project = _create_project(client, title="Successful cleanup")
    project_id = project["id"]
    store = ownership_context["app"].state.store
    before_workspace = _workspace_bytes(store, project_id)

    if terminal_state == "recovered":
        def fail_commit():
            raise RuntimeError("expected compensation trigger")

        monkeypatch.setattr(ownership_context["db"], "commit", fail_commit)

    response = client.patch(
        f"/api/projects/{project_id}/continuity",
        json={
            "project_type": "single_video",
            "series_bible": {"worldview": "Terminal cleanup control"},
        },
    )

    if terminal_state == "committed":
        assert response.status_code == 200, response.text
        assert _workspace_bytes(store, project_id) != before_workspace
    else:
        assert response.status_code == 500
        assert response.json() == {"detail": "Project update failed"}
        assert _workspace_bytes(store, project_id) == before_workspace
    assert not (store.projects_root / ".recovery").exists()


def test_empty_recovery_parent_removal_failure_is_best_effort(
    ownership_context, monkeypatch
):
    client = _alice(ownership_context)
    project = _create_project(client, title="Best effort parent cleanup")
    project_id = project["id"]
    store = ownership_context["app"].state.store
    original_rmdir = Path.rmdir

    def fail_recovery_root_rmdir(path):
        if path.name == ".recovery":
            raise OSError("empty recovery root removal failed")
        return original_rmdir(path)

    monkeypatch.setattr(Path, "rmdir", fail_recovery_root_rmdir)

    response = client.patch(
        f"/api/projects/{project_id}/continuity",
        json={"project_type": "single_video"},
    )

    assert response.status_code == 200, response.text
    recovery_root = store.projects_root / ".recovery"
    assert recovery_root.is_dir()
    assert list(recovery_root.iterdir()) == []
    assert client.get(f"/api/projects/{project_id}").status_code == 200


def test_malformed_recovery_marker_quarantines_project(ownership_context):
    client = _alice(ownership_context)
    project = _create_project(client, title="Malformed recovery marker")
    project_id = project["id"]
    operation_dir = (
        ownership_context["app"].state.store.projects_root
        / ".recovery"
        / project_id
        / ("a" * 32)
    )
    operation_dir.mkdir(parents=True)
    (operation_dir / "marker.json").write_text(
        json.dumps({"state": "committed"}),
        encoding="utf-8",
    )

    response = client.get(f"/api/projects/{project_id}")

    assert response.status_code == 503
    assert response.json() == {
        "detail": "Project is unavailable pending recovery"
    }


TERMINAL_MANIFEST_PLATFORM_PATHS = {
    "drive_rooted_entry": "C:/outside",
    "drive_relative_entry": "C:relative",
    "ads_entry": "assets/file.txt:stream",
    "nul_entry": "assets/new/\x00output.png",
    "c0_control_entry": "assets/new/\x1foutput.png",
    "del_control_entry": "assets/new/\x7foutput.png",
    "trailing_dot_entry": "assets/new/output.png.",
    "trailing_space_entry": "assets/new/output.png ",
    "reserved_con_entry": "assets/CON",
    "reserved_prn_extension_entry": "assets/prn.txt",
    "reserved_aux_case_entry": "assets/AuX.JSON",
    "reserved_nul_extension_entry": "assets/nUl.bin",
    **{
        f"reserved_com{number}_entry": (
            f"assets/{'COM' if number % 2 else 'com'}{number}"
            f"{'.cache' if number % 3 == 0 else ''}"
        )
        for number in range(1, 10)
    },
    **{
        f"reserved_lpt{number}_entry": (
            f"assets/{'lpt' if number % 2 else 'LPT'}{number}"
            f"{'.json' if number % 3 == 1 else ''}"
        )
        for number in range(1, 10)
    },
}


TERMINAL_MANIFEST_INVALID_CASES = [
    "missing_manifest",
    "malformed_json",
    "non_object",
    "missing_key",
    "extra_key",
    "foreign_project_id",
    "foreign_operation_id",
    "foreign_operation",
    "non_boolean_new_workspace",
    "non_list_entries",
    "non_list_created_dirs",
    "non_object_entry",
    "alternate_entry_kind",
    "entry_metadata",
    "non_string_entry_path",
    "non_boolean_existed",
    "noncanonical_entry_path",
    "traversing_entry_path",
    "noncanonical_created_dir",
    "traversing_created_dir",
    *TERMINAL_MANIFEST_PLATFORM_PATHS,
    "reserved_created_dir",
    "control_created_dir",
    "duplicate_entry",
    "duplicate_created_dir",
    "case_alias_new_entries",
    "case_alias_mixed_entries",
    "case_alias_created_dirs",
    "case_alias_file_created_dir",
    "case_alias_file_ancestor",
    "case_alias_file_created_dir_ancestor",
    "file_ancestor",
    "file_directory_conflict",
    "missing_backup",
    "backup_for_new_file",
    "unexpected_backup_file",
    "unexpected_backup_directory",
    "mismatched_backup_path",
    "nonregular_backup",
    "linked_backup_file",
    "linked_backup_directory",
    "hardlinked_backup_file",
]


@pytest.mark.parametrize("state", ["committed", "recovered"])
@pytest.mark.parametrize("manifest_case", TERMINAL_MANIFEST_INVALID_CASES)
def test_invalid_terminal_manifest_quarantines_all_project_routes(
    ownership_context, monkeypatch, state, manifest_case
):
    client = _alice(ownership_context)
    project = _create_project(client, title="Invalid terminal manifest")
    project_id = project["id"]
    operation_dir, manifest = _terminal_recovery_operation(
        ownership_context,
        project_id,
        state,
    )
    if manifest_case != "missing_manifest":
        _write_manifest_case(
            ownership_context,
            operation_dir,
            manifest,
            manifest_case,
            monkeypatch,
        )

    monkeypatch.setattr(
        ownership_context["app"].state.events,
        "stream",
        _finite_stream,
    )
    responses = [
        client.get(f"/api/projects/{project_id}"),
        client.get(f"/api/projects/{project_id}/media/assets/images/missing.png"),
        client.get(f"/api/projects/{project_id}/events"),
        client.patch(
            f"/api/projects/{project_id}/continuity",
            json={"project_type": "single_video"},
        ),
    ]

    assert [response.status_code for response in responses] == [503] * 4
    assert [response.json() for response in responses] == [
        {"detail": "Project is unavailable pending recovery"}
    ] * 4


@pytest.mark.parametrize("state", ["committed", "recovered"])
def test_valid_terminal_manifest_keeps_project_available(ownership_context, state):
    client = _alice(ownership_context)
    project = _create_project(client, title="Valid terminal manifest")
    operation_dir, manifest = _terminal_recovery_operation(
        ownership_context,
        project["id"],
        state,
    )
    manifest["entries"].insert(
        0,
        {"path": "artifacts/continuity_plan.json", "existed": True},
    )
    manifest["entries"][1]["path"] = "assets/.cache/output+draft.json"
    manifest["created_dirs"] = ["assets", "assets/.cache"]
    (operation_dir / "manifest.json").write_text(
        json.dumps(manifest),
        encoding="utf-8",
    )
    backup = operation_dir / "backups" / "artifacts" / "continuity_plan.json"
    backup.parent.mkdir(parents=True)
    backup.write_bytes(b"backup")

    response = client.get(f"/api/projects/{project['id']}")

    assert response.status_code == 200


@pytest.mark.parametrize("state", ["committed", "recovered"])
@pytest.mark.parametrize("unsafe_child", ["manifest_symlink", "backups_junction"])
def test_terminal_marker_with_linked_recovery_child_quarantines_all_project_routes(
    ownership_context, monkeypatch, unsafe_child, state
):
    client = _alice(ownership_context)
    project = _create_project(client, title="Linked recovery child")
    project_id = project["id"]
    operation_id = "b" * 32
    operation_dir = (
        ownership_context["app"].state.store.projects_root
        / ".recovery"
        / project_id
        / operation_id
    )
    operation_dir.mkdir(parents=True)
    (operation_dir / "marker.json").write_text(
        json.dumps(
            {
                "project_id": project_id,
                "operation_id": operation_id,
                "operation": "test",
                "state": state,
            }
        ),
        encoding="utf-8",
    )
    outside = ownership_context["tmp_path"] / f"outside-{unsafe_child}"
    if unsafe_child == "manifest_symlink":
        outside.write_text("{}", encoding="utf-8")
        manifest = operation_dir / "manifest.json"
        if not _link_file(manifest, outside):
            manifest.write_text("{}", encoding="utf-8")
            original_is_symlink = Path.is_symlink
            monkeypatch.setattr(
                Path,
                "is_symlink",
                lambda path: path == manifest or original_is_symlink(path),
            )
    else:
        (operation_dir / "manifest.json").write_text("{}", encoding="utf-8")
        outside.mkdir()
        _link_directory(operation_dir / "backups", outside)

    async def finite_stream(_project_id):
        yield "event: job\ndata: {}\n\n"

    monkeypatch.setattr(ownership_context["app"].state.events, "stream", finite_stream)
    responses = [
        client.get(f"/api/projects/{project_id}"),
        client.get(f"/api/projects/{project_id}/media/assets/images/missing.png"),
        client.get(f"/api/projects/{project_id}/events"),
        client.patch(
            f"/api/projects/{project_id}/continuity",
            json={"project_type": "single_video"},
        ),
    ]

    assert [response.status_code for response in responses] == [503] * 4
    assert [response.json() for response in responses] == [
        {"detail": "Project is unavailable pending recovery"}
    ] * 4


def test_import_assigns_fresh_id_owner_and_keeps_browser_local_media(ownership_context):
    from server.app.projects.models import ProjectRecord

    payload = _valid_import_payload()
    response = _alice(ownership_context).post("/api/projects/import", json=payload)

    assert response.status_code == 201, response.text
    body = response.json()
    project_id = body["project"]["id"]
    assert project_id != payload["legacy_project_id"]
    assert ownership_context["db"].get(ProjectRecord, project_id).owner_user_id == ALICE_ID
    assert body["series_bible"]["assets"][0]["reference_images"] == [
        "local://media/image-1.png"
    ]
    assert not (ownership_context["app"].state.store.project_dir(project_id) / "assets" / "images" / "image-1.png").exists()


def test_import_write_failure_rolls_back_record_and_removes_workspace(
    ownership_context, monkeypatch
):
    from server.app.projects.models import ProjectRecord

    store = ownership_context["app"].state.store
    original_write = store.write_artifact
    writes = 0

    def fail_mid_import(project_id, name, data):
        nonlocal writes
        writes += 1
        if writes == 2:
            raise OSError("write failed at C:\\private\\workspace with token=fake-secret")
        return original_write(project_id, name, data)

    monkeypatch.setattr(store, "write_artifact", fail_mid_import)

    response = _alice(ownership_context).post(
        "/api/projects/import",
        json=_valid_import_payload(),
    )

    assert response.status_code == 500
    assert response.json() == {"detail": "Project import failed"}
    assert list(ownership_context["db"].scalars(select(ProjectRecord))) == []
    assert list(ownership_context["tmp_path"].joinpath("projects").iterdir()) == []


def test_import_commit_failure_rolls_back_record_and_removes_workspace(
    ownership_context, monkeypatch
):
    from server.app.projects.models import ProjectRecord

    def fail_commit():
        raise RuntimeError("commit failed with password=fake-secret")

    monkeypatch.setattr(ownership_context["db"], "commit", fail_commit)

    response = _alice(ownership_context).post(
        "/api/projects/import",
        json=_valid_import_payload(),
    )

    assert response.status_code == 500
    assert response.json() == {"detail": "Project import failed"}
    assert list(ownership_context["db"].scalars(select(ProjectRecord))) == []
    assert list(ownership_context["tmp_path"].joinpath("projects").iterdir()) == []


def test_import_cleanup_failure_does_not_expose_cleanup_details(
    ownership_context, monkeypatch, caplog
):
    from server.app.projects.models import ProjectRecord

    store = ownership_context["app"].state.store

    def fail_write(project_id, name, data):
        store._ensure_project_dirs(project_id)
        raise OSError("write path C:\\private\\artifact token=fake-write-secret")

    def fail_cleanup(project_id):
        raise OSError("cleanup path C:\\private\\workspace password=fake-cleanup-secret")

    monkeypatch.setattr(store, "write_artifact", fail_write)
    monkeypatch.setattr(store, "delete_project_workspace", fail_cleanup)

    response = _alice(ownership_context).post(
        "/api/projects/import",
        json=_valid_import_payload(),
    )

    public_output = response.text + caplog.text
    assert response.status_code == 500
    assert response.json() == {"detail": "Project import failed"}
    assert "fake-write-secret" not in public_output
    assert "fake-cleanup-secret" not in public_output
    assert "C:\\private" not in public_output
    assert list(ownership_context["db"].scalars(select(ProjectRecord))) == []


def test_workspace_cleanup_rejects_noncanonical_project_ids(ownership_context):
    store = ownership_context["app"].state.store
    outside = ownership_context["tmp_path"] / "outside"
    outside.mkdir()

    with pytest.raises(ValueError, match="canonical server UUID"):
        store.delete_project_workspace("../outside")

    assert outside.is_dir()


def test_workspace_cleanup_rejects_linked_project_directory(
    ownership_context, monkeypatch
):
    project_id = "dddddddddddd4ddd8ddddddddddddddd"
    store = ownership_context["app"].state.store
    original_is_symlink = Path.is_symlink

    monkeypatch.setattr(
        Path,
        "is_symlink",
        lambda path: path.name == project_id or original_is_symlink(path),
    )

    with pytest.raises(ValueError, match="Project workspace path is invalid"):
        store.delete_project_workspace(project_id)


@pytest.mark.parametrize("link_kind", ["symlink", "junction"])
def test_mutation_journal_capture_rejects_linked_project_directory(
    ownership_context, monkeypatch, link_kind
):
    project_id = "eeeeeeeeeeee4eee8eeeeeeeeeeeeeee"
    store = ownership_context["app"].state.store
    store._ensure_project_dirs(project_id)
    if link_kind == "symlink":
        original = Path.is_symlink
        monkeypatch.setattr(
            Path,
            "is_symlink",
            lambda path: path.name == project_id or original(path),
        )
    else:
        original = getattr(Path, "is_junction", lambda path: False)
        monkeypatch.setattr(
            Path,
            "is_junction",
            lambda path: path.name == project_id or original(path),
            raising=False,
        )

    with pytest.raises(ValueError, match="Project workspace path is invalid"):
        store.begin_project_mutation(
            project_id,
            operation="test",
            changed_paths=["artifacts/state.json"],
        )


@pytest.mark.parametrize("link_kind", ["symlink", "junction"])
def test_mutation_journal_restore_fails_closed_for_linked_destination(
    ownership_context, monkeypatch, link_kind
):
    project_id = "ffffffffffff4fff8fffffffffffffff"
    store = ownership_context["app"].state.store
    store.write_artifact(project_id, "state.json", {"version": "before"})
    journal = store.begin_project_mutation(
        project_id,
        operation="test",
        changed_paths=["artifacts/state.json"],
    )
    store.write_artifact(project_id, "state.json", {"version": "after"})
    if link_kind == "symlink":
        original = Path.is_symlink
        monkeypatch.setattr(
            Path,
            "is_symlink",
            lambda path: path.name == project_id or original(path),
        )
    else:
        original = getattr(Path, "is_junction", lambda path: False)
        monkeypatch.setattr(
            Path,
            "is_junction",
            lambda path: path.name == project_id or original(path),
            raising=False,
        )

    with pytest.raises(ValueError, match="Project workspace path is invalid"):
        journal.restore()

    assert store.read_artifact(project_id, "state.json") == {"version": "after"}


@pytest.mark.parametrize("link_kind", ["symlink", "junction"])
def test_mutation_journal_restore_rejects_linked_backup_parent(
    ownership_context, monkeypatch, link_kind
):
    project_id = "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa"
    store = ownership_context["app"].state.store
    store.write_artifact(project_id, "state.json", {"version": "before"})
    journal = store.begin_project_mutation(
        project_id,
        operation="test",
        changed_paths=["artifacts/state.json"],
    )
    store.write_artifact(project_id, "state.json", {"version": "after"})
    if link_kind == "symlink":
        original = Path.is_symlink
        monkeypatch.setattr(
            Path,
            "is_symlink",
            lambda path: path.name == "backups" or original(path),
        )
    else:
        original = getattr(Path, "is_junction", lambda path: False)
        monkeypatch.setattr(
            Path,
            "is_junction",
            lambda path: path.name == "backups" or original(path),
            raising=False,
        )

    with pytest.raises(ValueError, match="Project recovery path is invalid"):
        journal.restore()

    assert store.read_artifact(project_id, "state.json") == {"version": "after"}


@pytest.mark.parametrize("link_kind", ["symlink", "junction"])
def test_mutation_journal_restore_ignores_preexisting_link_at_legacy_temp_name(
    ownership_context, link_kind
):
    project_id = "99999999999949998999999999999999"
    store = ownership_context["app"].state.store
    destination = store.write_artifact(project_id, "state.json", {"version": "before"})
    journal = store.begin_project_mutation(
        project_id,
        operation="test",
        changed_paths=["artifacts/state.json"],
    )
    store.write_artifact(project_id, "state.json", {"version": "after"})
    legacy_temporary = destination.with_name(
        f".{destination.name}.{journal.operation_id}.restore"
    )
    outside_root = ownership_context["tmp_path"] / f"outside-restore-{link_kind}"
    if link_kind == "symlink":
        outside_root.write_bytes(b"outside-sentinel")
        outside_target = outside_root
        if not _link_file(legacy_temporary, outside_target):
            pytest.skip("file symlinks are not available")
    else:
        outside_root.mkdir()
        outside_target = outside_root / "state.json"
        outside_target.write_bytes(b"outside-sentinel")
        _link_directory(legacy_temporary, outside_root)

    try:
        journal.restore()
    except Exception:
        pass

    assert outside_target.read_bytes() == b"outside-sentinel"
    assert store.read_artifact(project_id, "state.json") == {"version": "before"}


def test_imported_assets_survive_a_later_reference_upload(ownership_context):
    imported = _alice(ownership_context).post(
        "/api/projects/import",
        json=_valid_import_payload(),
    )
    project_id = imported.json()["project"]["id"]

    upload = _alice(ownership_context).post(
        f"/api/projects/{project_id}/assets/upload",
        data={"kind": "character", "label": "Uploaded"},
        files={"file": ("uploaded.png", b"png", "image/png")},
    )
    snapshot = _alice(ownership_context).get(f"/api/projects/{project_id}")

    assert upload.status_code == 200, upload.text
    assert snapshot.status_code == 200
    assert [asset["id"] for asset in snapshot.json()["series_bible"]["assets"]] == [
        "asset-local",
        upload.json()["asset"]["id"],
    ]


@pytest.mark.parametrize(
    "bad_reference",
    [
        "/etc/passwd",
        "C:\\Users\\someone\\secret.png",
        "../other-project/assets/image.png",
        "assets/images/server-file.png",
        "renders/final.mp4",
        "https://server.example/api/projects/p1/media/assets/images/a.png",
        "local://media//nested.png",
        "local://media/nested/image.png",
        "local://media/image.png?token=unexpected",
    ],
)
def test_import_rejects_server_absolute_and_traversal_media_before_writes(
    ownership_context, bad_reference
):
    payload = _valid_import_payload()
    payload["series_bible"]["assets"][0]["reference_images"] = [bad_reference]
    before = list(ownership_context["tmp_path"].joinpath("projects").iterdir())

    response = _alice(ownership_context).post("/api/projects/import", json=payload)

    assert response.status_code == 422
    assert list(ownership_context["tmp_path"].joinpath("projects").iterdir()) == before


def test_import_rejects_unexpected_ids_and_oversized_json_before_writes(ownership_context):
    payload = _valid_import_payload()
    payload["owner_user_id"] = BOB_ID
    rejected_id = _alice(ownership_context).post("/api/projects/import", json=payload)
    assert rejected_id.status_code == 422

    payload = _valid_import_payload()
    payload["series_bible"]["style_lock"] = "x" * (1024 * 1024 + 1)
    rejected_size = _alice(ownership_context).post("/api/projects/import", json=payload)
    assert rejected_size.status_code == 413
    assert list(ownership_context["tmp_path"].joinpath("projects").iterdir()) == []


def test_import_checks_origin_then_raw_size_before_artifact_schema(ownership_context):
    payload = _valid_import_payload()
    payload["series_bible"]["assets"][0]["id"] = "x" * (1024 * 1024 + 1)

    bad_origin = _alice(ownership_context).post(
        "/api/projects/import",
        headers={"Origin": "https://evil.example"},
        json=payload,
    )
    oversized = _alice(ownership_context).post("/api/projects/import", json=payload)

    assert bad_origin.status_code == 403
    assert bad_origin.json() == {"detail": "Invalid request origin"}
    assert oversized.status_code == 413
    assert list(ownership_context["tmp_path"].joinpath("projects").iterdir()) == []


@pytest.mark.parametrize("bad_id", ["../../outside", "C:\\outside", "/absolute", ".."])
def test_import_rejects_path_capable_artifact_ids_before_writes(
    ownership_context, bad_id
):
    payload = _valid_import_payload()
    payload["storyboard"]["shots"] = [
        {
            "id": bad_id,
            "scene_id": "scene-1",
            "index": 1,
            "beat": "",
            "prompt": "safe",
        }
    ]

    response = _alice(ownership_context).post("/api/projects/import", json=payload)

    assert response.status_code == 422
    assert list(ownership_context["tmp_path"].joinpath("projects").iterdir()) == []


@pytest.mark.parametrize(
    "encoded_path",
    [
        "api%2Fprojects%2Fp1%2Fmedia%2Fassets%2Fvideo%2Fa.mp4",
        "api%5Cprojects%5Cp1%5Cmedia%5Cassets%5Cvideo%5Ca.mp4",
    ],
)
def test_import_rejects_percent_encoded_server_media_urls(
    ownership_context, encoded_path
):
    payload = _valid_import_payload()
    payload["storyboard"]["shots"] = [
        {
            "id": "shot-1",
            "scene_id": "scene-1",
            "index": 1,
            "beat": "",
            "prompt": "safe",
            "output_url": (
                f"https://server.example/{encoded_path}"
            ),
        }
    ]

    response = _alice(ownership_context).post("/api/projects/import", json=payload)

    assert response.status_code == 422
    assert list(ownership_context["tmp_path"].joinpath("projects").iterdir()) == []


@pytest.mark.parametrize("method,path_suffix,kwargs", SURFACE_CASES)
def test_anonymous_project_routes_require_authentication(
    ownership_context, method, path_suffix, kwargs
):
    client = TestClient(
        ownership_context["app"],
        base_url=AUTH_ORIGIN,
        raise_server_exceptions=False,
        headers={"Origin": AUTH_ORIGIN},
    )

    response = client.request(method, f"/api/projects/not-owned{path_suffix}", **kwargs)

    assert response.status_code == 401


@pytest.mark.parametrize(
    "method,path,kwargs",
    [
        ("POST", "/api/projects", {"json": {"title": "Mine"}}),
        ("POST", "/api/projects/import", {"json": _valid_import_payload()}),
        ("POST", "/api/projects/short-drama", {"json": {}}),
        ("PATCH", "/api/projects/p1/continuity", {"json": {}}),
        ("POST", "/api/projects/p1/assets/upload", {}),
        ("PATCH", "/api/projects/p1/shots/s1", {"json": {}}),
        ("POST", "/api/projects/p1/prompt-optimize", {"json": {}}),
        ("POST", "/api/projects/p1/shots/s1/regenerate", {"json": {}}),
        ("POST", "/api/projects/p1/render", {"json": {}}),
    ],
)
def test_every_project_mutation_requires_csrf(ownership_context, method, path, kwargs):
    client = _alice(ownership_context)

    response = client.request(method, path, headers={CSRF_HEADER: "wrong"}, **kwargs)

    assert response.status_code == 403
    assert response.json() == {"detail": "Invalid CSRF token"}


def test_ownership_denial_precedes_filesystem_provider_and_event_access(
    ownership_context, monkeypatch
):
    project = _create_project(_bob(ownership_context), title="Bob")
    calls: list[str] = []
    store = ownership_context["app"].state.store
    monkeypatch.setattr(
        store,
        "project_dir",
        lambda *_: calls.append("filesystem") or pytest.fail("filesystem touched"),
    )
    monkeypatch.setattr(
        store,
        "read_artifact",
        lambda *_: calls.append("artifact") or pytest.fail("artifact touched"),
    )
    monkeypatch.setattr(
        "server.app.main.optimize_text_prompt",
        lambda **_: calls.append("provider") or pytest.fail("provider touched"),
    )
    monkeypatch.setattr(
        ownership_context["app"].state.events,
        "stream",
        lambda *_: calls.append("events") or pytest.fail("events touched"),
    )

    project_response = _alice(ownership_context).get(f"/api/projects/{project['id']}")
    media_response = _alice(ownership_context).get(
        f"/api/projects/{project['id']}/media/../../other/secret.mp4"
    )
    provider_response = _alice(ownership_context).post(
        f"/api/projects/{project['id']}/prompt-optimize",
        json={
            "target": "project",
            "target_id": project["id"],
            "source_text": "text",
            "text_key": "secret-provider-key",
        },
    )
    event_response = _alice(ownership_context).get(f"/api/projects/{project['id']}/events")

    assert [
        project_response.status_code,
        media_response.status_code,
        provider_response.status_code,
        event_response.status_code,
    ] == [404, 404, 404, 404]
    assert calls == []


def test_event_authorization_releases_database_dependency_before_streaming(
    ownership_context, monkeypatch
):
    project = _create_project(_alice(ownership_context), title="Events")
    active_dependencies = 0
    stream_observations: list[int] = []

    def scoped_db():
        nonlocal active_dependencies
        active_dependencies += 1
        try:
            yield ownership_context["db"]
        finally:
            active_dependencies -= 1

    async def assert_closed_before_stream(project_id):
        stream_observations.append(active_dependencies)
        yield "event: done\ndata: {}\n\n"

    def reject_read_lock(*args, **kwargs):
        pytest.fail("SSE must not acquire the finite-response read lock")

    ownership_context["app"].dependency_overrides[get_db] = scoped_db
    monkeypatch.setattr(
        ProjectRepository,
        "require_owned_for_read",
        reject_read_lock,
        raising=False,
    )
    monkeypatch.setattr(
        ownership_context["app"].state.events,
        "stream",
        assert_closed_before_stream,
    )

    response = _alice(ownership_context).get(f"/api/projects/{project['id']}/events")

    assert response.status_code == 200
    assert active_dependencies == 0
    assert stream_observations == [0]


def test_finite_project_snapshot_holds_read_lock_until_json_is_materialized(
    ownership_context, monkeypatch
):
    project = _create_project(_alice(ownership_context), title="Finite reader")
    store = ownership_context["app"].state.store
    events: list[str] = []

    def scoped_db():
        events.append("session_open")
        try:
            yield ownership_context["db"]
        finally:
            events.append("session_release")

    original_require_owned = ProjectRepository.require_owned
    original_available = store.assert_project_available
    original_project_dir = store.project_dir
    original_read_artifact = store.read_artifact

    def observed_read_lock(repository, project_id, owner_user_id):
        result = original_require_owned(repository, project_id, owner_user_id)
        events.append("read_lock")
        return result

    def observed_available(project_id):
        result = original_available(project_id)
        events.append("available")
        return result

    def observed_project_dir(project_id):
        events.append("project_dir")
        return original_project_dir(project_id)

    def observed_read_artifact(project_id, name):
        events.append(f"read:{name}")
        return original_read_artifact(project_id, name)

    ownership_context["app"].dependency_overrides[get_db] = scoped_db
    monkeypatch.setattr(
        ProjectRepository,
        "require_owned_for_read",
        observed_read_lock,
        raising=False,
    )
    monkeypatch.setattr(store, "assert_project_available", observed_available)
    monkeypatch.setattr(store, "project_dir", observed_project_dir)
    monkeypatch.setattr(store, "read_artifact", observed_read_artifact)

    response = _alice(ownership_context).get(f"/api/projects/{project['id']}")

    assert response.status_code == 200, response.text
    assert events[0:3] == ["session_open", "read_lock", "available"]
    assert events[-1] == "session_release"
    release_index = events.index("session_release")
    assert events.index("project_dir") < release_index
    assert all(
        index < release_index
        for index, event in enumerate(events)
        if event.startswith("read:")
    )


def test_finite_media_holds_read_lock_through_file_open_and_range_stream(
    ownership_context, monkeypatch
):
    from server.app import main as main_module
    from starlette import responses as starlette_responses

    project = _create_project(_alice(ownership_context), title="Finite media reader")
    store = ownership_context["app"].state.store
    media_path = (
        store.project_dir(project["id"])
        / "assets"
        / "video"
        / "reader-lock.mp4"
    )
    media_path.parent.mkdir(parents=True, exist_ok=True)
    media_path.write_bytes(b"0123456789")
    events: list[str] = []

    def scoped_db():
        events.append("session_open")
        try:
            yield ownership_context["db"]
        finally:
            events.append("session_release")

    original_require_owned = ProjectRepository.require_owned
    original_available = store.assert_project_available
    original_safe_media_file = main_module.safe_project_media_file
    original_open_file = starlette_responses.anyio.open_file
    original_handle_range = main_module.FileResponse._handle_single_range

    def observed_read_lock(repository, project_id, owner_user_id):
        result = original_require_owned(repository, project_id, owner_user_id)
        events.append("read_lock")
        return result

    def observed_available(project_id):
        result = original_available(project_id)
        events.append("available")
        return result

    def observed_safe_media_file(project_dir, relative_path):
        events.append("path_validated")
        return original_safe_media_file(project_dir, relative_path)

    async def observed_open_file(*args, **kwargs):
        events.append("file_opened")
        return await original_open_file(*args, **kwargs)

    async def observed_handle_range(response, send, start, end, file_size, header_only):
        events.append("stream_started")
        await original_handle_range(response, send, start, end, file_size, header_only)
        events.append("stream_finished")

    ownership_context["app"].dependency_overrides[get_db] = scoped_db
    monkeypatch.setattr(
        ProjectRepository,
        "require_owned_for_read",
        observed_read_lock,
        raising=False,
    )
    monkeypatch.setattr(store, "assert_project_available", observed_available)
    monkeypatch.setattr(main_module, "safe_project_media_file", observed_safe_media_file)
    monkeypatch.setattr(starlette_responses.anyio, "open_file", observed_open_file)
    monkeypatch.setattr(
        main_module.FileResponse,
        "_handle_single_range",
        observed_handle_range,
    )

    response = _alice(ownership_context).get(
        f"/api/projects/{project['id']}/media/assets/video/reader-lock.mp4",
        headers={"Range": "bytes=2-5"},
    )

    assert response.status_code == 206, response.text
    assert response.content == b"2345"
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-range"] == "bytes 2-5/10"
    assert events[0:3] == ["session_open", "read_lock", "available"]
    assert events[-1] == "session_release"
    assert events.index("available") < events.index("path_validated")
    assert events.index("path_validated") < events.index("file_opened")
    assert events.index("file_opened") < events.index("stream_finished")
    assert events.index("stream_finished") < events.index("session_release")


def test_workbench_store_does_not_create_or_open_sqlite_metadata(tmp_path):
    from server.app.storage import WorkbenchStore

    sqlite_path = tmp_path / "must-not-exist.sqlite3"
    store = WorkbenchStore(
        db_path=sqlite_path,
        projects_root=tmp_path / "projects",
    )
    store.write_artifact(LEGACY_ID, "artifact.json", {"safe": True})

    assert not sqlite_path.exists()
    assert not hasattr(store, "_connect")
    assert not hasattr(store, "_init_db")


@pytest.mark.parametrize("project_id", ["../outside", "/absolute", "not-a-uuid", "A" * 32])
def test_workbench_store_rejects_noncanonical_project_ids(tmp_path, project_id):
    from server.app.storage import WorkbenchStore

    store = WorkbenchStore(projects_root=tmp_path / "projects")

    with pytest.raises(ValueError, match="canonical server UUID"):
        store.project_dir(project_id)

    assert not (tmp_path / "outside").exists()


def _load_revision(filename: str):
    path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / filename
    spec = importlib.util.spec_from_file_location(filename.removesuffix(".py"), path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_migration_chain_has_nullable_phase_and_actionable_not_null_gate(monkeypatch):
    from server.app.projects.models import ProjectRecord

    revision_002 = _load_revision("002_owned_projects_nullable.py")
    revision_003 = _load_revision("003_owned_projects_not_null.py")
    assert revision_002.revision == "002"
    assert revision_002.down_revision == "001"
    assert revision_003.revision == "003"
    assert revision_003.down_revision == "002"
    assert ProjectRecord.__table__.c.owner_user_id.nullable is False

    class Result:
        def scalar_one(self):
            return 2

    class Bind:
        def execute(self, statement):
            return Result()

    monkeypatch.setattr(revision_003.op, "get_bind", lambda: Bind())
    with pytest.raises(RuntimeError, match="2 unowned projects.*assign-project"):
        revision_003.upgrade()

    class OfflineBind:
        def execute(self, statement):
            return None

    monkeypatch.setattr(revision_003.op, "get_bind", lambda: OfflineBind())
    with pytest.raises(RuntimeError, match="online.*assign-project"):
        revision_003.upgrade()


def test_alembic_metadata_registers_project_record():
    from server.app.db.base import Base
    from server.app.projects.models import ProjectRecord

    assert Base.metadata.tables["projects"] is ProjectRecord.__table__


def _create_legacy_sqlite(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        connection.execute(
            """
            create table projects (
                id text primary key,
                title text not null,
                mode text not null,
                project_type text not null,
                created_at text not null,
                updated_at text not null
            )
            """
        )
        connection.execute(
            "insert into projects values (?, ?, ?, ?, ?, ?)",
            (
                LEGACY_ID,
                "Legacy",
                "short_drama",
                "single_video",
                "2026-01-01T00:00:00+00:00",
                "2026-01-02T00:00:00+00:00",
            ),
        )


def test_legacy_migration_is_unowned_idempotent_and_reports_conflicts(
    ownership_context, tmp_path
):
    from server.app.projects.legacy_migration import migrate_legacy_projects
    from server.app.projects.models import ProjectRecord

    sqlite_path = tmp_path / "legacy.sqlite3"
    _create_legacy_sqlite(sqlite_path)
    first = migrate_legacy_projects(ownership_context["db"], sqlite_path)
    second = migrate_legacy_projects(ownership_context["db"], sqlite_path)

    record = ownership_context["db"].get(ProjectRecord, LEGACY_ID)
    assert record.owner_user_id is None
    assert first.imported_ids == (LEGACY_ID,)
    assert second.skipped_ids == (LEGACY_ID,)
    record.title = "Different"
    ownership_context["db"].commit()
    conflict = migrate_legacy_projects(ownership_context["db"], sqlite_path)
    assert conflict.conflict_ids == (LEGACY_ID,)
    assert record.title == "Different"


def test_legacy_migration_rejects_noncanonical_project_ids(ownership_context, tmp_path):
    from server.app.projects.legacy_migration import migrate_legacy_projects

    sqlite_path = tmp_path / "malicious-legacy.sqlite3"
    _create_legacy_sqlite(sqlite_path)
    with sqlite3.connect(sqlite_path) as connection:
        connection.execute("update projects set id = '../outside'")

    with pytest.raises(ValueError, match="project id"):
        migrate_legacy_projects(ownership_context["db"], sqlite_path)

    assert not ownership_context["tmp_path"].joinpath("outside").exists()


def test_assign_project_verifies_admin_normalizes_owner_and_audits(
    ownership_context, monkeypatch
):
    from server.app.projects.models import ProjectRecord
    from server.manage import run_manage

    db = ownership_context["db"]
    project = ProjectRecord(
        id=ASSIGNMENT_ID,
        owner_user_id=None,
        title="Legacy",
        mode="short_drama",
        project_type="single_video",
    )
    db.add(project)
    db.commit()
    monkeypatch.setattr("server.manage.input", lambda prompt: " ADMIN@Example.COM ")
    monkeypatch.setattr("server.manage.getpass", lambda prompt: PASSWORD)

    code = run_manage(
        [
            "assign-project",
            "--project-id",
            project.id,
            "--owner-email",
            " ALICE@Example.COM ",
        ],
        db_session=db,
        session_store=ownership_context["session_store"],
    )

    db.refresh(project)
    audit = db.scalar(
        select(AdminAuditLog).where(AdminAuditLog.action == "admin.assign_project")
    )
    assert code == 0
    assert project.owner_user_id == ALICE_ID
    assert audit is not None
    assert audit.admin_user_id == ADMIN_ID
    assert audit.object_type == "project"
    assert audit.object_id == project.id
    assert json.loads(audit.before_json) == {"owner_user_id": None}
    assert json.loads(audit.after_json) == {"owner_user_id": ALICE_ID}


def test_assign_project_rejects_unverified_or_non_admin_operator(
    ownership_context, monkeypatch
):
    from server.app.projects.models import ProjectRecord
    from server.manage import run_manage

    db = ownership_context["db"]
    project = ProjectRecord(
        id=REJECTED_ASSIGNMENT_ID,
        owner_user_id=None,
        title="Legacy",
        mode="short_drama",
        project_type="single_video",
    )
    db.add(project)
    db.commit()
    monkeypatch.setattr("server.manage.input", lambda prompt: "alice@example.com")
    monkeypatch.setattr("server.manage.getpass", lambda prompt: PASSWORD)

    code = run_manage(
        ["assign-project", "--project-id", project.id, "--owner-email", "bob@example.com"],
        db_session=db,
        session_store=ownership_context["session_store"],
    )

    db.refresh(project)
    assert code == 1
    assert project.owner_user_id is None
    assert db.scalar(
        select(AdminAuditLog).where(AdminAuditLog.action == "admin.assign_project")
    ) is None


def test_assign_project_refuses_to_transfer_an_owned_project(
    ownership_context, monkeypatch
):
    from server.app.projects.models import ProjectRecord
    from server.manage import run_manage

    db = ownership_context["db"]
    project = ProjectRecord(
        id="e" * 32,
        owner_user_id=ALICE_ID,
        title="Already owned",
        mode="short_drama",
        project_type="single_video",
    )
    db.add(project)
    db.commit()
    monkeypatch.setattr("server.manage.input", lambda prompt: "admin@example.com")
    monkeypatch.setattr("server.manage.getpass", lambda prompt: PASSWORD)

    code = run_manage(
        ["assign-project", "--project-id", project.id, "--owner-email", "bob@example.com"],
        db_session=db,
        session_store=ownership_context["session_store"],
    )

    db.refresh(project)
    assert code == 1
    assert project.owner_user_id == ALICE_ID
    assert db.scalar(
        select(AdminAuditLog).where(AdminAuditLog.action == "admin.assign_project")
    ) is None
