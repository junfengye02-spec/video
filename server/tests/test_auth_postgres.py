from __future__ import annotations

import os
import re
import secrets
import sqlite3
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event, Lock
from time import monotonic, sleep

import fakeredis
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

os.environ.setdefault("AUTH_HMAC_SECRET", "x" * 32)

from server.app.auth.models import User
from server.app.auth.sessions import SessionStore
from server.app.core.config import AppSettings, get_settings
from server.app.db.session import get_db
from server.app.main import _project_mutation, create_app
from server.app.projects.models import ProjectRecord
from server.app.projects.repository import ProjectRepository
from server.app.redis import get_redis
from server.app.storage import ProjectMutationJournal, WorkbenchStore
from server.manage import run_manage
from server.tests.test_project_ownership import (
    ALICE_ID,
    AUTH_ORIGIN,
    CSRF_HEADER,
    ownership_context,
)


UNOWNED_IDS = (
    "d0000000000040008000000000000001",
    "d0000000000040008000000000000002",
)


ROOT_DIR = Path(__file__).resolve().parents[2]
DESTRUCTIVE_POSTGRES_ACK = "I_UNDERSTAND_THIS_CREATES_AND_DROPS_A_TEST_SCHEMA"
_SCHEMA_NAME_PATTERN = re.compile(r"openmontage_task8_[0-9a-f]{32}")


class _RecordingPostgresConnection:
    def __init__(
        self,
        *,
        version: str = "16.13",
        database_name: str = "openmontage_guard_test",
        schema_exists: bool = False,
    ) -> None:
        self.version = version
        self.database_name = database_name
        self.schema_exists = schema_exists
        self.statements: list[str] = []
        self.parameters: list[dict[str, object] | None] = []
        self.dialect = postgresql.dialect()

    def scalar(self, statement, parameters=None):
        sql = str(statement)
        self.statements.append(sql)
        self.parameters.append(parameters)
        if "server_version" in sql:
            return self.version
        if "current_database" in sql:
            return self.database_name
        if "pg_namespace" in sql:
            return self.schema_exists
        raise AssertionError(f"Unexpected scalar query: {sql}")

    def execute(self, statement):
        self.statements.append(str(statement))


def _new_disposable_schema_name() -> str:
    return f"openmontage_task8_{secrets.token_hex(16)}"


def _validate_schema_name(schema_name: str) -> None:
    if _SCHEMA_NAME_PATTERN.fullmatch(schema_name) is None:
        raise ValueError("Unsafe disposable PostgreSQL schema name")


def _quoted_schema_name(connection, schema_name: str) -> str:
    _validate_schema_name(schema_name)
    return connection.dialect.identifier_preparer.quote_identifier(schema_name)


def _create_owned_test_schema(
    connection,
    *,
    acknowledgement: str | None,
    schema_name: str,
) -> None:
    if acknowledgement != DESTRUCTIVE_POSTGRES_ACK:
        raise RuntimeError(
            "Destructive PostgreSQL test acknowledgement is missing or invalid"
        )
    _validate_schema_name(schema_name)
    version = connection.scalar(text("SHOW server_version"))
    database_name = connection.scalar(text("SELECT current_database()"))
    if str(version).split(".", 1)[0] != "16":
        raise RuntimeError("Destructive PostgreSQL test requires PostgreSQL 16")
    if "test" not in str(database_name).lower():
        raise RuntimeError("Destructive PostgreSQL target database must contain 'test'")
    schema_exists = connection.scalar(
        text(
            """
            SELECT EXISTS (
                SELECT 1 FROM pg_namespace WHERE nspname = :schema_name
            )
            """
        ),
        {"schema_name": schema_name},
    )
    if schema_exists:
        raise RuntimeError("Disposable PostgreSQL schema already exists")
    connection.execute(
        text(f"CREATE SCHEMA {_quoted_schema_name(connection, schema_name)}")
    )


def _drop_owned_test_schema(connection, schema_name: str) -> None:
    connection.execute(
        text(f"DROP SCHEMA {_quoted_schema_name(connection, schema_name)} CASCADE")
    )


def _database_url_for_schema(database_url: str, schema_name: str) -> str:
    _validate_schema_name(schema_name)
    url = make_url(database_url)
    existing_options = url.query.get("options", "")
    scoped_options = f"{existing_options} -csearch_path={schema_name}".strip()
    return url.update_query_dict(
        {"options": scoped_options}
    ).render_as_string(hide_password=False)


def _wait_for_postgres_for_update_lock_wait(
    connection,
    *,
    blocked_backend_pid: int,
    blocking_backend_pid: int,
    timeout_seconds: float = 5,
    poll_interval_seconds: float = 0.01,
) -> dict[str, object]:
    deadline = monotonic() + timeout_seconds
    last_observation = None
    while True:
        row = connection.execute(
            text(
                """
                SELECT
                    pid,
                    state,
                    wait_event_type,
                    wait_event,
                    query,
                    pg_blocking_pids(pid) AS blocking_pids,
                    :blocking_backend_pid = ANY(pg_blocking_pids(pid))
                        AS blocked_by_expected
                FROM pg_stat_activity
                WHERE pid = :blocked_backend_pid
                """
            ),
            {
                "blocked_backend_pid": blocked_backend_pid,
                "blocking_backend_pid": blocking_backend_pid,
            },
        ).mappings().one_or_none()
        last_observation = dict(row) if row is not None else None
        if (
            last_observation is not None
            and last_observation["pid"] == blocked_backend_pid
            and last_observation["state"] == "active"
            and last_observation["wait_event_type"] == "Lock"
            and "FOR UPDATE" in str(last_observation["query"]).upper()
            and blocking_backend_pid in last_observation["blocking_pids"]
        ):
            return last_observation
        if monotonic() >= deadline:
            raise AssertionError(
                "PostgreSQL backend did not enter the expected FOR UPDATE "
                f"lock wait; last observation: {last_observation!r}"
            )
        sleep(poll_interval_seconds)


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


def test_postgres_schema_create_requires_explicit_destructive_acknowledgement():
    connection = _RecordingPostgresConnection()
    schema_name = "openmontage_task8_0123456789abcdef0123456789abcdef"

    with pytest.raises(RuntimeError, match="acknowledgement"):
        _create_owned_test_schema(
            connection,
            acknowledgement=None,
            schema_name=schema_name,
        )

    assert connection.statements == []


@pytest.mark.parametrize(
    ("connection", "message"),
    [
        (_RecordingPostgresConnection(version="15.8"), "PostgreSQL 16"),
        (
            _RecordingPostgresConnection(database_name="openmontage_production"),
            "must contain 'test'",
        ),
    ],
)
def test_postgres_schema_create_retains_version_and_database_guards(
    connection, message
):
    schema_name = "openmontage_task8_0123456789abcdef0123456789abcdef"

    with pytest.raises(RuntimeError, match=message):
        _create_owned_test_schema(
            connection,
            acknowledgement=DESTRUCTIVE_POSTGRES_ACK,
            schema_name=schema_name,
        )

    assert not any("CREATE SCHEMA" in statement for statement in connection.statements)


def test_postgres_schema_create_refuses_an_existing_exact_schema():
    connection = _RecordingPostgresConnection(schema_exists=True)
    schema_name = "openmontage_task8_0123456789abcdef0123456789abcdef"

    with pytest.raises(RuntimeError, match="already exists"):
        _create_owned_test_schema(
            connection,
            acknowledgement=DESTRUCTIVE_POSTGRES_ACK,
            schema_name=schema_name,
        )

    assert not any("CREATE SCHEMA" in statement for statement in connection.statements)


@pytest.mark.parametrize("schema_name", ["public", "unsafe; DROP SCHEMA public"])
def test_postgres_schema_helpers_reject_unsafe_identifiers(schema_name):
    connection = _RecordingPostgresConnection()

    with pytest.raises(ValueError, match="Unsafe"):
        _drop_owned_test_schema(connection, schema_name)

    assert connection.statements == []


def test_generated_schema_identifier_is_random_safe_and_force_quoted():
    first = _new_disposable_schema_name()
    second = _new_disposable_schema_name()
    connection = _RecordingPostgresConnection()

    _create_owned_test_schema(
        connection,
        acknowledgement=DESTRUCTIVE_POSTGRES_ACK,
        schema_name=first,
    )

    assert first != second
    assert re.fullmatch(r"openmontage_task8_[0-9a-f]{32}", first)
    assert connection.statements[-1] == f'CREATE SCHEMA "{first}"'


def test_schema_cleanup_targets_only_the_exact_owned_schema():
    connection = _RecordingPostgresConnection()
    schema_name = "openmontage_task8_0123456789abcdef0123456789abcdef"

    _drop_owned_test_schema(connection, schema_name)

    assert connection.statements == [f'DROP SCHEMA "{schema_name}" CASCADE']
    assert all("public" not in statement for statement in connection.statements)


def test_postgres_lock_wait_polling_requires_exact_active_for_update_blocker():
    observations = [
        {
            "pid": 4321,
            "state": "active",
            "wait_event_type": None,
            "wait_event": None,
            "query": "SELECT projects.id FROM projects FOR UPDATE",
            "blocking_pids": [],
        },
        {
            "pid": 4321,
            "state": "active",
            "wait_event_type": "Lock",
            "wait_event": "transactionid",
            "query": "SELECT projects.id FROM projects FOR UPDATE",
            "blocking_pids": [1234],
        },
    ]

    class Result:
        def __init__(self, observation):
            self.observation = observation

        def mappings(self):
            return self

        def one_or_none(self):
            return self.observation

    class Connection:
        def __init__(self):
            self.calls = 0

        def execute(self, statement, parameters):
            assert parameters == {
                "blocked_backend_pid": 4321,
                "blocking_backend_pid": 1234,
            }
            observation = observations[min(self.calls, len(observations) - 1)]
            self.calls += 1
            return Result(observation)

    connection = Connection()

    observation = _wait_for_postgres_for_update_lock_wait(
        connection,
        blocked_backend_pid=4321,
        blocking_backend_pid=1234,
        timeout_seconds=0.1,
        poll_interval_seconds=0,
    )

    assert observation == observations[1]
    assert connection.calls == 2


def test_schema_database_url_scopes_every_connection_to_the_owned_schema():
    schema_name = "openmontage_task8_0123456789abcdef0123456789abcdef"

    scoped = make_url(
        _database_url_for_schema(
            "postgresql+psycopg://user:password@127.0.0.1/openmontage_test",
            schema_name,
        )
    )

    assert scoped.query["options"] == f"-csearch_path={schema_name}"
    assert scoped.password == "password"


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

    schema_name = _new_disposable_schema_name()
    admin_engine = create_engine(database_url)
    schema_engine = None
    schema_created = False
    try:
        with admin_engine.begin() as connection:
            _create_owned_test_schema(
                connection,
                acknowledgement=os.getenv("OPENMONTAGE_DESTRUCTIVE_TEST_ACK"),
                schema_name=schema_name,
            )
        schema_created = True
        scoped_database_url = _database_url_for_schema(database_url, schema_name)
        schema_engine = create_engine(scoped_database_url)

        env = os.environ.copy()
        env["DATABASE_URL"] = scoped_database_url
        env.setdefault("AUTH_HMAC_SECRET", "x" * 32)
        env.setdefault("REDIS_URL", "redis://127.0.0.1:6379/15")
        env.setdefault("REDIS_PREFIX", "openmontage-task8-test:")
        legacy_path = tmp_path / "legacy.sqlite3"
        _legacy_sqlite(legacy_path)

        phase_one = _run(
            [sys.executable, "-m", "alembic", "upgrade", "002"], env=env
        )
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
            [sys.executable, "-m", "server.manage", "list-unowned-projects"],
            env=env,
        )
        assert listed.returncode == 0, listed.stderr
        assert listed.stdout.splitlines() == [UNOWNED_IDS[0]]

        blocked = _run(
            [sys.executable, "-m", "alembic", "upgrade", "003"], env=env
        )
        assert blocked.returncode != 0
        assert "1 unowned projects remain" in blocked.stderr

        with schema_engine.begin() as connection:
            connection.execute(
                text("DELETE FROM projects WHERE id = :project_id"),
                {"project_id": UNOWNED_IDS[0]},
            )

        phase_two = _run(
            [sys.executable, "-m", "alembic", "upgrade", "003"], env=env
        )
        assert phase_two.returncode == 0, phase_two.stderr
        current = _run([sys.executable, "-m", "alembic", "current"], env=env)
        assert current.returncode == 0, current.stderr
        assert "003 (head)" in current.stdout
        check = _run([sys.executable, "-m", "alembic", "check"], env=env)
        assert check.returncode == 0, check.stderr
        assert "No new upgrade operations detected" in check.stdout
    finally:
        if schema_engine is not None:
            schema_engine.dispose()
        if schema_created:
            with admin_engine.begin() as connection:
                _drop_owned_test_schema(connection, schema_name)
        admin_engine.dispose()


def test_postgres_project_lock_keeps_failed_restore_before_later_commit(
    tmp_path, monkeypatch
):
    database_url = os.getenv("OPENMONTAGE_TEST_POSTGRES_URL")
    if not database_url:
        pytest.skip("OPENMONTAGE_TEST_POSTGRES_URL is not configured")

    schema_name = _new_disposable_schema_name()
    admin_engine = create_engine(database_url)
    schema_engine = None
    schema_created = False
    executor = ThreadPoolExecutor(max_workers=1)
    try:
        with admin_engine.begin() as connection:
            _create_owned_test_schema(
                connection,
                acknowledgement=os.getenv("OPENMONTAGE_DESTRUCTIVE_TEST_ACK"),
                schema_name=schema_name,
            )
        schema_created = True
        scoped_database_url = _database_url_for_schema(database_url, schema_name)
        schema_engine = create_engine(scoped_database_url)

        env = os.environ.copy()
        env["DATABASE_URL"] = scoped_database_url
        env.setdefault("AUTH_HMAC_SECRET", "x" * 32)
        migrated = _run(
            [sys.executable, "-m", "alembic", "upgrade", "head"], env=env
        )
        assert migrated.returncode == 0, migrated.stderr

        owner_id = "a" * 32
        project_id = "11111111111141118111111111111111"
        with Session(schema_engine) as seed_db:
            seed_db.add(
                User(
                    id=owner_id,
                    email="postgres-concurrency@example.com",
                    password_hash="unused",
                    role="user",
                    status="active",
                )
            )
            seed_db.add(
                ProjectRecord(
                    id=project_id,
                    owner_user_id=owner_id,
                    title="PostgreSQL concurrency",
                    mode="short_drama",
                    project_type="single_video",
                )
            )
            seed_db.commit()

        store = WorkbenchStore(projects_root=tmp_path / "postgres-projects")
        store.write_artifact(project_id, "state.json", {"value": "initial"})
        b_attempting = Event()
        b_acquired = Event()
        b_committed = Event()
        schedule: list[str] = []
        schedule_lock = Lock()
        restore_observations: list[tuple[str, bool, bool]] = []

        def record(step: str) -> None:
            with schedule_lock:
                schedule.append(step)

        original_restore = ProjectMutationJournal.restore

        def observed_restore(journal: ProjectMutationJournal) -> None:
            record("a_restore_started")
            restore_observations.append(
                ("before", b_acquired.is_set(), b_committed.is_set())
            )
            original_restore(journal)
            restore_observations.append(
                ("after", b_acquired.is_set(), b_committed.is_set())
            )
            record("a_restore_finished")
            assert restore_observations == [
                ("before", False, False),
                ("after", False, False),
            ]

        monkeypatch.setattr(ProjectMutationJournal, "restore", observed_restore)

        def mutate_b() -> None:
            with Session(schema_engine) as db_b:
                record("b_attempting")
                b_attempting.set()
                ProjectRepository(db_b).require_owned_for_update(project_id, owner_id)
                record("b_acquired")
                b_acquired.set()
                with _project_mutation(
                    db=db_b,
                    workbench=store,
                    project_id=project_id,
                    operation="postgres_b",
                    changed_paths=["artifacts/state.json"],
                    failure_detail="B mutation failed",
                ):
                    record("b_journal_started")
                    store.write_artifact(project_id, "state.json", {"value": "B"})
                    record("b_written")
                record("b_committed")
                b_committed.set()

        with Session(schema_engine) as db_a:
            original_a_rollback = db_a.rollback

            def observed_a_rollback() -> None:
                record("a_rollback_started")
                original_a_rollback()

            monkeypatch.setattr(db_a, "rollback", observed_a_rollback)
            ProjectRepository(db_a).require_owned_for_update(project_id, owner_id)
            record("a_locked")
            with pytest.raises(HTTPException, match="A mutation failed"):
                with _project_mutation(
                    db=db_a,
                    workbench=store,
                    project_id=project_id,
                    operation="postgres_a",
                    changed_paths=["artifacts/state.json"],
                    failure_detail="A mutation failed",
                ):
                    record("a_journal_started")
                    store.write_artifact(project_id, "state.json", {"value": "A"})
                    record("a_written")
                    b_future = executor.submit(mutate_b)
                    assert b_attempting.wait(timeout=5)
                    acquired_while_a_held_lock = b_acquired.wait(timeout=0.25)
                    committed_while_a_held_lock = b_committed.is_set()
                    raise RuntimeError("force A restore")

            b_future.result(timeout=5)

        assert store.read_artifact(project_id, "state.json") == {"value": "B"}
        assert acquired_while_a_held_lock is False
        assert committed_while_a_held_lock is False
        assert restore_observations == [
            ("before", False, False),
            ("after", False, False),
        ]
        assert schedule == [
            "a_locked",
            "a_journal_started",
            "a_written",
            "b_attempting",
            "a_restore_started",
            "a_restore_finished",
            "a_rollback_started",
            "b_acquired",
            "b_journal_started",
            "b_written",
            "b_committed",
        ]
        assert not (store.projects_root / ".recovery").exists()
        store.assert_project_available(project_id)
        with Session(schema_engine) as verify_db:
            project = ProjectRepository(verify_db).require_owned(project_id, owner_id)
            assert project.title == "PostgreSQL concurrency"
    finally:
        executor.shutdown(wait=True)
        if schema_engine is not None:
            schema_engine.dispose()
        if schema_created:
            with admin_engine.begin() as connection:
                _drop_owned_test_schema(connection, schema_name)
        admin_engine.dispose()


def test_postgres_route_parses_before_attempting_project_write_lock(
    tmp_path, monkeypatch
):
    database_url = os.getenv("OPENMONTAGE_TEST_POSTGRES_URL")
    if not database_url:
        pytest.skip("OPENMONTAGE_TEST_POSTGRES_URL is not configured")

    from server.app import main as main_module

    schema_name = _new_disposable_schema_name()
    admin_engine = create_engine(database_url)
    schema_engine = None
    schema_created = False
    client = None
    executor = ThreadPoolExecutor(max_workers=2)
    release_parse = Event()
    parse_started = Event()
    b_committed = Event()
    schedule: list[str] = []
    schedule_lock = Lock()

    def record(step: str) -> None:
        with schedule_lock:
            schedule.append(step)

    try:
        with admin_engine.begin() as connection:
            _create_owned_test_schema(
                connection,
                acknowledgement=os.getenv("OPENMONTAGE_DESTRUCTIVE_TEST_ACK"),
                schema_name=schema_name,
            )
        schema_created = True
        scoped_database_url = _database_url_for_schema(database_url, schema_name)
        schema_engine = create_engine(scoped_database_url)

        env = os.environ.copy()
        env["DATABASE_URL"] = scoped_database_url
        env.setdefault("AUTH_HMAC_SECRET", "x" * 32)
        migrated = _run(
            [sys.executable, "-m", "alembic", "upgrade", "head"], env=env
        )
        assert migrated.returncode == 0, migrated.stderr

        project_id = "22222222222242228222222222222222"
        with Session(schema_engine) as seed_db:
            seed_db.add(
                User(
                    id=ALICE_ID,
                    email="postgres-lock-timing@example.com",
                    password_hash="unused",
                    role="user",
                    status="active",
                )
            )
            seed_db.add(
                ProjectRecord(
                    id=project_id,
                    owner_user_id=ALICE_ID,
                    title="PostgreSQL lock timing",
                    mode="short_drama",
                    project_type="single_video",
                )
            )
            seed_db.commit()

        settings = AppSettings(
            _env_file=None,
            environment="test",
            database_url=scoped_database_url,
            redis_url="redis://unused/0",
            redis_prefix="postgres-lock-timing:",
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
            db_path=tmp_path / "postgres-lock-timing.sqlite3",
            projects_root=tmp_path / "postgres-lock-timing-projects",
        )
        app.state.store.write_artifact(
            project_id,
            "continuity_plan.json",
            {"project_type": "single_video"},
        )

        def request_db():
            with Session(schema_engine, expire_on_commit=False) as db:
                db.info["lock_timing_actor"] = "a"
                yield db

        app.dependency_overrides[get_db] = request_db
        app.dependency_overrides[get_redis] = lambda: redis
        app.dependency_overrides[get_settings] = lambda: settings
        client = TestClient(app, base_url=AUTH_ORIGIN, raise_server_exceptions=False)
        session_id, session = session_store.create(ALICE_ID)
        client.cookies.set(settings.session_cookie_name, session_id)
        client.headers.update(
            {"Origin": AUTH_ORIGIN, CSRF_HEADER: session.csrf_token}
        )

        original_require_owned = ProjectRepository.require_owned
        original_require_owned_for_update = ProjectRepository.require_owned_for_update
        original_parse_json_request = main_module.parse_json_request
        original_available = app.state.store.assert_project_available
        original_begin_mutation = app.state.store.begin_project_mutation
        availability_calls = 0

        def observed_require_owned(repository, owned_project_id, owner_user_id):
            result = original_require_owned(
                repository,
                owned_project_id,
                owner_user_id,
            )
            if repository.db.info.get("lock_timing_actor") == "a":
                record("a_authorized")
            return result

        def observed_require_owned_for_update(
            repository,
            owned_project_id,
            owner_user_id,
        ):
            actor = repository.db.info.get("lock_timing_actor")
            record(f"{actor}_lock_attempt")
            result = original_require_owned_for_update(
                repository,
                owned_project_id,
                owner_user_id,
            )
            record(f"{actor}_lock_acquired")
            return result

        def observed_available(available_project_id):
            nonlocal availability_calls
            result = original_available(available_project_id)
            availability_calls += 1
            record(
                "a_available_preparse"
                if availability_calls == 1
                else "a_available_postlock"
            )
            return result

        async def controlled_parse(request, model, **kwargs):
            record("a_parse_started")
            parse_started.set()
            assert release_parse.wait(timeout=10), "test did not release PostgreSQL parse"
            result = await original_parse_json_request(request, model, **kwargs)
            record("a_parse_finished")
            return result

        def observed_begin_mutation(*args, **kwargs):
            record("a_journal_started")
            return original_begin_mutation(*args, **kwargs)

        monkeypatch.setattr(ProjectRepository, "require_owned", observed_require_owned)
        monkeypatch.setattr(
            ProjectRepository,
            "require_owned_for_update",
            observed_require_owned_for_update,
        )
        monkeypatch.setattr(main_module, "parse_json_request", controlled_parse)
        monkeypatch.setattr(
            app.state.store,
            "assert_project_available",
            observed_available,
        )
        monkeypatch.setattr(
            app.state.store,
            "begin_project_mutation",
            observed_begin_mutation,
        )

        def mutate_b() -> None:
            with Session(schema_engine) as db_b:
                db_b.info["lock_timing_actor"] = "b"
                ProjectRepository(db_b).require_owned_for_update(project_id, ALICE_ID)
                db_b.commit()
                record("b_committed")
                b_committed.set()

        response_future = executor.submit(
            client.patch,
            f"/api/projects/{project_id}/continuity",
            json={"project_type": "single_video"},
        )
        assert parse_started.wait(timeout=5), "PostgreSQL controlled parser did not start"
        b_future = executor.submit(mutate_b)
        b_committed_before_parse_release = b_committed.wait(timeout=5)
        release_parse.set()
        response = response_future.result(timeout=15)
        b_future.result(timeout=15)

        assert response.status_code == 200, response.text
        assert b_committed_before_parse_release is True
        assert schedule == [
            "a_authorized",
            "a_available_preparse",
            "a_parse_started",
            "b_lock_attempt",
            "b_lock_acquired",
            "b_committed",
            "a_parse_finished",
            "a_lock_attempt",
            "a_lock_acquired",
            "a_available_postlock",
            "a_journal_started",
        ]
    finally:
        release_parse.set()
        executor.shutdown(wait=True)
        if client is not None:
            client.close()
        if schema_engine is not None:
            schema_engine.dispose()
        if schema_created:
            with admin_engine.begin() as connection:
                _drop_owned_test_schema(connection, schema_name)
        admin_engine.dispose()


def test_postgres_shared_reader_blocks_writer_until_snapshot_is_materialized(
    tmp_path,
):
    database_url = os.getenv("OPENMONTAGE_TEST_POSTGRES_URL")
    if not database_url:
        pytest.skip("OPENMONTAGE_TEST_POSTGRES_URL is not configured")

    schema_name = _new_disposable_schema_name()
    admin_engine = create_engine(database_url)
    schema_engine = None
    schema_created = False
    executor = ThreadPoolExecutor(max_workers=1)
    schedule: list[str] = []
    schedule_lock = Lock()
    b_pid_ready = Event()
    b_backend_pid: list[int] = []
    b_acquired = Event()

    def record(step: str) -> None:
        with schedule_lock:
            schedule.append(step)

    try:
        with admin_engine.begin() as connection:
            _create_owned_test_schema(
                connection,
                acknowledgement=os.getenv("OPENMONTAGE_DESTRUCTIVE_TEST_ACK"),
                schema_name=schema_name,
            )
        schema_created = True
        scoped_database_url = _database_url_for_schema(database_url, schema_name)
        schema_engine = create_engine(scoped_database_url)

        env = os.environ.copy()
        env["DATABASE_URL"] = scoped_database_url
        env.setdefault("AUTH_HMAC_SECRET", "x" * 32)
        migrated = _run(
            [sys.executable, "-m", "alembic", "upgrade", "head"], env=env
        )
        assert migrated.returncode == 0, migrated.stderr

        owner_id = "r" * 32
        project_id = "33333333333343338333333333333333"
        with Session(schema_engine) as seed_db:
            seed_db.add(
                User(
                    id=owner_id,
                    email="postgres-shared-reader@example.com",
                    password_hash="unused",
                    role="user",
                    status="active",
                )
            )
            seed_db.add(
                ProjectRecord(
                    id=project_id,
                    owner_user_id=owner_id,
                    title="PostgreSQL shared reader",
                    mode="short_drama",
                    project_type="single_video",
                )
            )
            seed_db.commit()

        store = WorkbenchStore(projects_root=tmp_path / "postgres-reader-projects")
        store.write_artifact(project_id, "first.json", {"version": "A"})
        store.write_artifact(project_id, "second.json", {"version": "A"})

        def mutate_b() -> None:
            with Session(schema_engine) as db_b:
                backend_pid = db_b.scalar(text("SELECT pg_backend_pid()"))
                assert isinstance(backend_pid, int)
                b_backend_pid.append(backend_pid)
                record("b_pid_exposed")
                b_pid_ready.set()
                record("b_lock_attempt")
                ProjectRepository(db_b).require_owned_for_update(project_id, owner_id)
                record("b_lock_acquired")
                b_acquired.set()
                with _project_mutation(
                    db=db_b,
                    workbench=store,
                    project_id=project_id,
                    operation="postgres_reader_b",
                    changed_paths=[
                        "artifacts/first.json",
                        "artifacts/second.json",
                    ],
                    failure_detail="B reader regression mutation failed",
                ):
                    record("b_journal_started")
                    store.write_artifact(project_id, "first.json", {"version": "B"})
                    record("b_first_written")
                    store.write_artifact(project_id, "second.json", {"version": "B"})
                    record("b_second_written")
                record("b_committed")

        with Session(schema_engine) as db_a:
            a_backend_pid = db_a.scalar(text("SELECT pg_backend_pid()"))
            assert isinstance(a_backend_pid, int)
            ProjectRepository(db_a).require_owned_for_read(project_id, owner_id)
            record("a_read_lock_acquired")
            store.assert_project_available(project_id)
            record("a_available")
            first = store.read_artifact(project_id, "first.json")
            record("a_first_read")

            b_future = executor.submit(mutate_b)
            assert b_pid_ready.wait(timeout=5), "writer B did not expose its backend PID"
            with admin_engine.connect() as observer_connection:
                lock_wait_observation = _wait_for_postgres_for_update_lock_wait(
                    observer_connection,
                    blocked_backend_pid=b_backend_pid[0],
                    blocking_backend_pid=a_backend_pid,
                    timeout_seconds=5,
                )
            record("b_lock_wait_observed")
            assert not b_acquired.is_set()
            journal_absent_while_reader_held = not (
                store.projects_root / ".recovery"
            ).exists()

            second = store.read_artifact(project_id, "second.json")
            record("a_second_read")
            with schedule_lock:
                db_a.rollback()
                schedule.append("a_released")

            b_future.result(timeout=15)

        snapshot_versions = (first["version"], second["version"])
        assert lock_wait_observation["pid"] == b_backend_pid[0]
        assert lock_wait_observation["state"] == "active"
        assert lock_wait_observation["wait_event_type"] == "Lock"
        assert "FOR UPDATE" in lock_wait_observation["query"].upper()
        assert a_backend_pid in lock_wait_observation["blocking_pids"]
        assert lock_wait_observation["blocked_by_expected"] is True
        assert journal_absent_while_reader_held is True
        assert snapshot_versions in {("A", "A"), ("B", "B")}
        assert snapshot_versions == ("A", "A")
        assert store.read_artifact(project_id, "first.json") == {"version": "B"}
        assert store.read_artifact(project_id, "second.json") == {"version": "B"}
        assert schedule == [
            "a_read_lock_acquired",
            "a_available",
            "a_first_read",
            "b_pid_exposed",
            "b_lock_attempt",
            "b_lock_wait_observed",
            "a_second_read",
            "a_released",
            "b_lock_acquired",
            "b_journal_started",
            "b_first_written",
            "b_second_written",
            "b_committed",
        ]
        assert not (store.projects_root / ".recovery").exists()
    finally:
        executor.shutdown(wait=True)
        if schema_engine is not None:
            schema_engine.dispose()
        if schema_created:
            with admin_engine.begin() as connection:
                _drop_owned_test_schema(connection, schema_name)
        admin_engine.dispose()
