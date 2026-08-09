from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from server.app.auth import models as auth_models  # noqa: F401
from server.app.billing import models as billing_models  # noqa: F401
from server.app.db.base import Base
from server.app.generation_units import models as generation_unit_models  # noqa: F401
from server.app.generation_units.release_gate import (
    GENERATION_UNITS_CONTRACT_VERSION,
    GenerationUnitsReleaseGateError,
    generation_units_release_status,
    require_generation_units_release,
)
from server.app.projects import models as project_models  # noqa: F401
from server.app.tasks import models as task_models  # noqa: F401
from server.app.video_model_settings import models as video_model_models  # noqa: F401


REPO_ROOT = Path(__file__).resolve().parents[2]
POSTGRES_URL_ENV = "GENERATION_UNITS_ACCEPTANCE_DATABASE_URL"


def _run_alembic(database_url: str, *arguments: str) -> None:
    environment = os.environ.copy()
    environment.update(
        DATABASE_URL=database_url,
        ENVIRONMENT="test",
        AUTH_HMAC_SECRET="x" * 32,
    )
    result = subprocess.run(
        [sys.executable, "-m", "alembic", *arguments],
        cwd=REPO_ROOT,
        env=environment,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, (result.stdout[-4000:], result.stderr[-4000:])


def _seed_pre_020_generation_unit(database_url: str) -> None:
    engine = create_engine(database_url)
    now = datetime.now(timezone.utc)
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO users "
                    "(id, email, password_hash, role, status, created_at, updated_at) "
                    "VALUES (:id, :email, 'hash', 'user', 'active', :now, :now)"
                ),
                {"id": "m" * 32, "email": "migration@example.invalid", "now": now},
            )
            connection.execute(
                text(
                    "INSERT INTO projects "
                    "(id, owner_user_id, title, mode, project_type, created_at, updated_at) "
                    "VALUES (:id, :owner, 'Migration fixture', 'general_video', "
                    "'single_video', :now, :now)"
                ),
                {"id": "p" * 32, "owner": "m" * 32, "now": now},
            )
            connection.execute(
                text(
                    "INSERT INTO video_generation_units ("
                    "project_id, id, revision, plan_id, status, active, "
                    "source_shot_ids_json, source_shot_versions_json, "
                    "source_beat_ids_json, prompt_segments_json, provider, model_id, "
                    "operation, profile_revision, profile_json, "
                    "requested_duration_seconds, source_duration_seconds, "
                    "timeline_duration_seconds, execution_key, diagnostics_json, "
                    "created_at, updated_at) VALUES ("
                    ":project_id, 'unit-old', 1, :plan_id, 'complete', true, "
                    ":shot_ids, :shot_versions, :beat_ids, :segments, 'newapi', "
                    "'omni_flash-10s', 'text_to_video', 'duration-v1', :profile, "
                    "10, 10.005, 10.005, :execution_key, :diagnostics, :now, :now)"
                ),
                {
                    "project_id": "p" * 32,
                    "plan_id": "a" * 64,
                    "shot_ids": "[\"s1\"]",
                    "shot_versions": "{\"s1\":1}",
                    "beat_ids": "[\"b1\"]",
                    "segments": "[]",
                    "profile": "{}",
                    "execution_key": "b" * 64,
                    "diagnostics": "{}",
                    "now": now,
                },
            )
    finally:
        engine.dispose()


def _assert_019_and_020_contracts(database_url: str) -> None:
    engine = create_engine(database_url)
    try:
        database = inspect(engine)
        duration_constraints = {
            constraint.get("name")
            for constraint in database.get_check_constraints(
                "video_model_duration_settings"
            )
        }
        assert duration_constraints >= {
            "ck_video_model_duration_settings_positive_duration",
            "ck_video_model_duration_settings_version",
        }
        unique_constraints = {
            constraint.get("name")
            for constraint in database.get_unique_constraints(
                "video_model_duration_settings"
            )
        }
        assert "uq_video_model_duration_settings_provider_model" in unique_constraints
        unit_columns = {
            column["name"] for column in database.get_columns("video_generation_units")
        }
        assert "source_segment_ids_json" in unit_columns
        with engine.connect() as connection:
            assert connection.execute(
                text("SELECT version_num FROM alembic_version")
            ).scalar_one() == "020"
            bootstrapped = connection.execute(
                text(
                    "SELECT model_id, call_duration_seconds, version "
                    "FROM video_model_duration_settings ORDER BY model_id"
                )
            ).all()
            assert ("omni_flash-10s", 10.0, 1) in bootstrapped
            assert all("test" not in model_id for model_id, _duration, _version in bootstrapped)
            backfill = connection.execute(
                text(
                    "SELECT source_segment_ids_json, source_duration_seconds, "
                    "timeline_duration_seconds FROM video_generation_units "
                    "WHERE id = 'unit-old'"
                )
            ).one()
            assert backfill[0] in ([], "[]")
            assert backfill[1] == pytest.approx(10.005)
            assert backfill[2] == pytest.approx(10.005)
        invalid_values = (
            ("invalid-duration", "invalid-duration", 0, 1),
            ("invalid-version", "invalid-version", 1, 0),
            ("duplicate-model", "omni_flash-10s", 10, 1),
        )
        for setting_id, model_id, duration, version in invalid_values:
            with pytest.raises(IntegrityError):
                with engine.begin() as connection:
                    connection.execute(
                        text(
                            "INSERT INTO video_model_duration_settings "
                            "(id, provider, model_id, call_duration_seconds, version, "
                            "created_at, updated_at) VALUES "
                            "(:id, 'newapi', :model_id, :duration, :version, :now, :now)"
                        ),
                        {
                            "id": setting_id,
                            "model_id": model_id,
                            "duration": duration,
                            "version": version,
                            "now": datetime.now(timezone.utc),
                        },
                    )
    finally:
        engine.dispose()


def test_sqlite_full_history_and_018_to_020_incremental_upgrade(tmp_path):
    full_path = tmp_path / "full-history.sqlite3"
    full_url = f"sqlite+pysqlite:///{full_path.as_posix()}"
    _run_alembic(full_url, "upgrade", "head")
    full_engine = create_engine(full_url)
    try:
        database = inspect(full_engine)
        project_columns = {
            column["name"]: column for column in database.get_columns("projects")
        }
        assert project_columns["owner_user_id"]["nullable"] is False
        with full_engine.connect() as connection:
            trigger_names = set(
                connection.execute(
                    text(
                        "SELECT name FROM sqlite_master "
                        "WHERE type = 'trigger' AND name LIKE "
                        "'wallet_entries_reject_%'"
                    )
                ).scalars()
            )
        assert trigger_names == {
            "wallet_entries_reject_update",
            "wallet_entries_reject_delete",
        }
    finally:
        full_engine.dispose()

    incremental_path = tmp_path / "incremental.sqlite3"
    incremental_url = f"sqlite+pysqlite:///{incremental_path.as_posix()}"
    _run_alembic(incremental_url, "upgrade", "019")
    incremental_engine = create_engine(incremental_url)
    try:
        assert "source_segment_ids_json" not in {
            column["name"]
            for column in inspect(incremental_engine).get_columns(
                "video_generation_units"
            )
        }
    finally:
        incremental_engine.dispose()
    _seed_pre_020_generation_unit(incremental_url)
    _run_alembic(incremental_url, "upgrade", "020")
    _assert_019_and_020_contracts(incremental_url)

@pytest.mark.skipif(
    not os.environ.get(POSTGRES_URL_ENV),
    reason=f"set {POSTGRES_URL_ENV} to an explicitly isolated PostgreSQL database",
)
def test_postgres_full_history_and_018_to_020_incremental_upgrade():
    database_url = os.environ[POSTGRES_URL_ENV]
    assert "generation_units_acceptance" in database_url
    _run_alembic(database_url, "downgrade", "base")
    _run_alembic(database_url, "upgrade", "018")
    _run_alembic(database_url, "upgrade", "019")
    _seed_pre_020_generation_unit(database_url)
    _run_alembic(database_url, "upgrade", "020")
    _assert_019_and_020_contracts(database_url)


def test_release_gate_requires_contract_revision_and_schema(tmp_path):
    engine = create_engine(f"sqlite+pysqlite:///{(tmp_path / 'gate.db').as_posix()}")
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE alembic_version (version_num VARCHAR(32))"))
        connection.execute(text("INSERT INTO alembic_version VALUES ('019')"))
    try:
        with Session(engine) as db:
            with pytest.raises(GenerationUnitsReleaseGateError) as incompatible:
                require_generation_units_release(
                    db,
                    enabled=True,
                    environment="development",
                    client_contract_version=1,
                )
            assert incompatible.value.code == "generation_units_contract_incompatible"

            with pytest.raises(GenerationUnitsReleaseGateError) as half_migrated:
                require_generation_units_release(
                    db,
                    enabled=True,
                    environment="development",
                    client_contract_version=GENERATION_UNITS_CONTRACT_VERSION,
                )
            assert half_migrated.value.code == "generation_units_schema_not_ready"
            assert half_migrated.value.details["database_revision"] == "019"

            db.execute(text("UPDATE alembic_version SET version_num = '020'"))
            db.commit()
            status = generation_units_release_status(db)
            assert status.ready is True
            require_generation_units_release(
                db,
                enabled=True,
                environment="development",
                client_contract_version=GENERATION_UNITS_CONTRACT_VERSION,
            )
    finally:
        engine.dispose()
