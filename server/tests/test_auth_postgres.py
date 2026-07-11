from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

os.environ.setdefault("AUTH_HMAC_SECRET", "x" * 32)

from server.app.projects.models import ProjectRecord
from server.manage import run_manage
from server.tests.test_project_ownership import (
    ALICE_ID,
    ownership_context,
)


UNOWNED_IDS = (
    "d0000000000040008000000000000001",
    "d0000000000040008000000000000002",
)


ROOT_DIR = Path(__file__).resolve().parents[2]


def test_list_unowned_projects_prints_every_remaining_id(
    ownership_context, capsys
):
    db = ownership_context["db"]
    db.add_all(
        [
            ProjectRecord(
                id=UNOWNED_IDS[0],
                owner_user_id=None,
                title="Legacy one",
                mode="short_drama",
                project_type="single_video",
            ),
            ProjectRecord(
                id=UNOWNED_IDS[1],
                owner_user_id=None,
                title="Legacy two",
                mode="short_drama",
                project_type="single_video",
            ),
            ProjectRecord(
                id="d0000000000040008000000000000003",
                owner_user_id=ALICE_ID,
                title="Owned",
                mode="short_drama",
                project_type="single_video",
            ),
        ]
    )
    db.commit()

    try:
        code = run_manage(
            ["list-unowned-projects"],
            db_session=db,
            session_store=ownership_context["session_store"],
        )
    except SystemExit:
        pytest.fail("list-unowned-projects command is unavailable")

    assert code == 0
    assert capsys.readouterr().out.splitlines() == list(UNOWNED_IDS)


def test_deployment_and_billing_handoff_contract_is_documented():
    readme = (ROOT_DIR / "README.md").read_text(encoding="utf-8")

    required_text = (
        "docker compose -f deploy/docker-compose.infrastructure.yml up -d",
        "python -m server.manage create-admin",
        "python -m server.manage migrate-legacy-projects --sqlite-path workbench.sqlite3",
        "python -m server.manage list-unowned-projects",
        "python -m alembic upgrade 002",
        "python -m alembic upgrade 003",
        "python -m alembic downgrade 002",
        "HTTPS",
        "Origin",
        "HttpOnly",
        "SameSite=Lax",
        "revoke_all",
        "001-009",
        "010-019",
    )
    for text_value in required_text:
        assert text_value in readme

    handoff = readme.split("## Billing handoff", 1)[1].split("\n## ", 1)[0]
    imports = [line for line in handoff.splitlines() if line.startswith("from server.app")]
    assert imports == [
        "from server.app.auth.dependencies import CurrentUser, require_admin, require_csrf, require_user",
        "from server.app.auth.provisioning import UserProvisioner",
        "from server.app.db.session import get_db",
    ]


def test_env_example_does_not_contain_checked_in_credentials():
    lines = (ROOT_DIR / ".env.example").read_text(encoding="utf-8").splitlines()
    assignments = {
        name: value.strip()
        for line in lines
        if line and not line.startswith("#") and "=" in line
        for name, value in [line.split("=", 1)]
    }

    assert assignments["DATABASE_URL"] == ""
    assert assignments["AUTH_HMAC_SECRET"] == ""
    assert assignments["SMTP_PASSWORD"] == ""
    assert all(
        value == ""
        for name, value in assignments.items()
        if name.startswith("NEWAPI_") and "KEY" in name
    )
    assert assignments["REDIS_PREFIX"] == "openmontage:"


def test_readme_key_examples_use_empty_assignments():
    lines = (ROOT_DIR / "README.md").read_text(encoding="utf-8").splitlines()
    key_examples = [
        line.split("#", 1)[0].strip()
        for line in lines
        if "_KEY=" in line and not line.lstrip().startswith("#")
    ]

    assert key_examples
    assert all(example.endswith("_KEY=") for example in key_examples)


def _run(command: list[str], *, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=Path(__file__).resolve().parents[2],
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )


def _legacy_sqlite(path: Path) -> None:
    with sqlite3.connect(path) as connection:
        connection.execute(
            """
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                mode TEXT NOT NULL,
                project_type TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            INSERT INTO projects
                (id, title, mode, project_type, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                UNOWNED_IDS[0],
                "Disposable legacy project",
                "short_drama",
                "single_video",
                "2026-01-01T00:00:00+00:00",
                "2026-01-01T00:00:00+00:00",
            ),
        )


def test_postgres_16_migration_blocks_unowned_projects(tmp_path):
    database_url = os.getenv("OPENMONTAGE_TEST_POSTGRES_URL")
    if not database_url:
        pytest.skip("OPENMONTAGE_TEST_POSTGRES_URL is not configured")

    engine = create_engine(database_url)
    with engine.connect() as connection:
        version = connection.scalar(text("SHOW server_version"))
        database_name = connection.scalar(text("SELECT current_database()"))
        assert str(version).split(".", 1)[0] == "16"
        assert "test" in str(database_name).lower()
        connection.execute(text("DROP SCHEMA public CASCADE"))
        connection.execute(text("CREATE SCHEMA public"))
        connection.commit()

    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    env.setdefault("AUTH_HMAC_SECRET", "x" * 32)
    env.setdefault("REDIS_URL", "redis://127.0.0.1:6379/15")
    env.setdefault("REDIS_PREFIX", "openmontage-task8-test:")
    legacy_path = tmp_path / "legacy.sqlite3"
    _legacy_sqlite(legacy_path)

    phase_one = _run([sys.executable, "-m", "alembic", "upgrade", "002"], env=env)
    assert phase_one.returncode == 0, phase_one.stderr
    migrated = _run(
        [
            sys.executable,
            "-m",
            "server.manage",
            "migrate-legacy-projects",
            "--sqlite-path",
            str(legacy_path),
        ],
        env=env,
    )
    assert migrated.returncode == 0, migrated.stderr
    assert f"Imported project ID: {UNOWNED_IDS[0]}" in migrated.stdout

    listed = _run(
        [sys.executable, "-m", "server.manage", "list-unowned-projects"], env=env
    )
    assert listed.returncode == 0, listed.stderr
    assert listed.stdout.splitlines() == [UNOWNED_IDS[0]]

    blocked = _run([sys.executable, "-m", "alembic", "upgrade", "003"], env=env)
    assert blocked.returncode != 0
    assert "1 unowned projects remain" in blocked.stderr

    with engine.begin() as connection:
        connection.execute(
            text("DELETE FROM projects WHERE id = :project_id"),
            {"project_id": UNOWNED_IDS[0]},
        )

    phase_two = _run([sys.executable, "-m", "alembic", "upgrade", "003"], env=env)
    assert phase_two.returncode == 0, phase_two.stderr
    current = _run([sys.executable, "-m", "alembic", "current"], env=env)
    assert current.returncode == 0, current.stderr
    assert "003 (head)" in current.stdout
    check = _run([sys.executable, "-m", "alembic", "check"], env=env)
    assert check.returncode == 0, check.stderr
    assert "No new upgrade operations detected" in check.stdout

    engine.dispose()
