from __future__ import annotations

import importlib
import json
import os
import uuid

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from server.app.auth.dependencies import CurrentUser, require_csrf, require_user
from server.app.auth.models import AdminAuditLog, User
from server.app.db.base import Base
from server.app.db.session import get_db
from server.app.main import create_app, get_newapi_client
from server.app.provider.newapi import NewApiCallError
from server.app.video_model_profiles import video_model_profile
from server.app.video_model_settings.models import VideoModelDurationSetting
from server.app.video_model_settings.service import (
    BOOTSTRAP_VIDEO_MODEL_DURATIONS,
    VideoModelDurationService,
    bootstrap_verified_duration_settings,
)


ADMIN = CurrentUser(
    id="duration-admin-0000000000000001",
    email="duration-admin@example.com",
    role="admin",
)
USER = CurrentUser(
    id="duration-user-00000000000000001",
    email="duration-user@example.com",
    role="user",
)


class FakeVideoCatalog:
    api_key = "must-never-leak"
    token_alias = "video-secret-alias"

    def __init__(self) -> None:
        self.fail = False
        self.models = ["omni_flash-10s", "provider-added-model"]

    def list_models(self, kind: str) -> list[str]:
        assert kind == "video"
        if self.fail:
            raise NewApiCallError("catalog secret must not leak")
        return list(self.models)

    def close(self) -> None:
        return None


@pytest.fixture
def duration_db():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as db:
        db.add_all(
            [
                User(
                    id=ADMIN.id,
                    email=ADMIN.email,
                    password_hash="hash",
                    role="admin",
                    status="active",
                ),
                User(
                    id=USER.id,
                    email=USER.email,
                    password_hash="hash",
                    role="user",
                    status="active",
                ),
            ]
        )
        bootstrap_verified_duration_settings(db)
        db.commit()
        yield db
    engine.dispose()


def _client(
    tmp_path,
    db: Session,
    catalog: FakeVideoCatalog,
    user: CurrentUser,
    *,
    csrf: bool = True,
) -> TestClient:
    app = create_app(
        db_path=tmp_path / f"workbench-{uuid.uuid4().hex}.db",
        projects_root=tmp_path / f"projects-{uuid.uuid4().hex}",
    )
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_newapi_client] = lambda: catalog
    app.dependency_overrides[require_user] = lambda: user
    if csrf:
        app.dependency_overrides[require_csrf] = lambda: user
    else:
        app.dependency_overrides[require_csrf] = lambda: (_ for _ in ()).throw(
            HTTPException(status_code=403, detail="Invalid CSRF token")
        )
    return TestClient(app, raise_server_exceptions=False)


def test_migration_and_metadata_define_portable_constraints():
    migration = importlib.import_module(
        "server.alembic.versions.019_video_model_duration_settings"
    )

    assert migration.revision == "019"
    assert migration.down_revision == "018"
    assert all(
        "video-model" not in model_id
        for _, model_id, _ in migration._BOOTSTRAP_SETTINGS
    )
    assert set(migration._BOOTSTRAP_SETTINGS) == set(BOOTSTRAP_VIDEO_MODEL_DURATIONS)
    constraint_names = {
        constraint.name
        for constraint in VideoModelDurationSetting.__table__.constraints
    }
    assert constraint_names >= {
        "uq_video_model_duration_settings_provider_model",
        "ck_video_model_duration_settings_positive_duration",
        "ck_video_model_duration_settings_version",
    }


def test_sqlite_enforces_unique_positive_and_version_constraints(duration_db):
    duplicate = VideoModelDurationSetting(
        id=uuid.uuid4().hex,
        provider="newapi",
        model_id="omni_flash-10s",
        call_duration_seconds=10,
        version=1,
    )
    duration_db.add(duplicate)
    with pytest.raises(IntegrityError):
        duration_db.flush()
    duration_db.rollback()

    invalid = VideoModelDurationSetting(
        id=uuid.uuid4().hex,
        provider="newapi",
        model_id="invalid-duration",
        call_duration_seconds=0,
        version=0,
    )
    duration_db.add(invalid)
    with pytest.raises(IntegrityError):
        duration_db.flush()
    duration_db.rollback()


def test_admin_catalog_is_union_of_live_models_and_historical_settings(
    tmp_path, duration_db
):
    catalog = FakeVideoCatalog()
    with _client(tmp_path, duration_db, catalog, ADMIN) as client:
        response = client.get("/api/admin/video-model-duration-settings")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["catalog_refresh_status"] == "ok"
    models = {item["model_id"]: item for item in body["models"]}
    assert models["provider-added-model"]["configuration_status"] == "unconfigured"
    assert models["provider-added-model"]["catalog_status"] == "available"
    assert models["sora_v2"]["configuration_status"] == "configured"
    assert models["sora_v2"]["catalog_status"] == "missing_from_catalog"
    serialized = response.text
    assert catalog.api_key not in serialized
    assert catalog.token_alias not in serialized


def test_admin_read_and_write_require_admin_and_csrf(tmp_path, duration_db):
    catalog = FakeVideoCatalog()
    with _client(tmp_path, duration_db, catalog, USER) as client:
        read = client.get("/api/admin/video-model-duration-settings")
        write = client.put(
            "/api/admin/video-model-duration-settings/provider-added-model",
            json={
                "call_duration_seconds": 10,
                "expected_version": 0,
                "reason": "verified",
            },
        )
    with _client(tmp_path, duration_db, catalog, ADMIN, csrf=False) as client:
        no_csrf = client.put(
            "/api/admin/video-model-duration-settings/provider-added-model",
            json={
                "call_duration_seconds": 10,
                "expected_version": 0,
                "reason": "verified",
            },
        )

    assert read.status_code == 403
    assert write.status_code == 403
    assert no_csrf.status_code == 403


def test_new_model_update_immediately_creates_fixed_profile_and_audit(
    tmp_path, duration_db
):
    catalog = FakeVideoCatalog()
    with _client(tmp_path, duration_db, catalog, ADMIN) as client:
        response = client.put(
            "/api/admin/video-model-duration-settings/provider-added-model",
            json={
                "call_duration_seconds": 10,
                "expected_version": 0,
                "reason": "Provider duration verified from production output",
            },
        )
        user_catalog = client.get(
            "/api/generation/models", params={"capability": "video"}
        )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["configuration_status"] == "configured"
    assert body["call_duration_seconds"] == 10
    assert body["version"] == 1
    assert user_catalog.status_code == 200, user_catalog.text
    effective = next(
        profile
        for profile in user_catalog.json()["profiles"]
        if profile["model_id"] == "provider-added-model"
    )
    assert effective["duration_mode"] == "fixed"
    assert effective["fixed_duration_seconds"] == 10
    assert effective["duration_configuration_status"] == "configured"
    profile = video_model_profile(
        "provider-added-model",
        "text_to_video",
        db=duration_db,
    )
    assert profile.duration_mode == "fixed"
    assert profile.fixed_duration_seconds == 10
    assert profile.duration_configuration_status == "configured"
    assert profile.contract_source == "admin_configuration"
    audit = duration_db.scalar(
        select(AdminAuditLog).where(
            AdminAuditLog.action == "video_model_duration.update"
        )
    )
    assert audit is not None
    assert audit.admin_user_id == ADMIN.id
    assert audit.before_json is None
    after = json.loads(audit.after_json)
    assert after["model_id"] == "provider-added-model"
    assert after["reason"] == "Provider duration verified from production output"
    assert after["profile_revision"] == profile.profile_revision


def test_update_changes_version_revision_and_rejects_stale_expected_version(
    tmp_path, duration_db
):
    catalog = FakeVideoCatalog()
    client = _client(tmp_path, duration_db, catalog, ADMIN)
    with client:
        created = client.put(
            "/api/admin/video-model-duration-settings/concurrent-model",
            json={
                "call_duration_seconds": 5,
                "expected_version": 0,
                "reason": "initial verification",
            },
        ).json()
        updated_response = client.put(
            "/api/admin/video-model-duration-settings/concurrent-model",
            json={
                "call_duration_seconds": 8,
                "expected_version": created["version"],
                "reason": "provider model upgraded",
            },
        )
        conflict = client.put(
            "/api/admin/video-model-duration-settings/concurrent-model",
            json={
                "call_duration_seconds": 99,
                "expected_version": created["version"],
                "reason": "stale browser tab",
            },
        )

    assert updated_response.status_code == 200, updated_response.text
    updated = updated_response.json()
    assert updated["version"] == 2
    assert updated["profile_revision"] != created["profile_revision"]
    assert conflict.status_code == 409
    assert conflict.json()["detail"] == {
        "code": "video_model_duration_version_conflict",
        "expected_version": 1,
        "current_version": 2,
    }
    persisted = VideoModelDurationService(duration_db).get(
        provider="newapi", model_id="concurrent-model"
    )
    assert persisted is not None
    assert persisted.call_duration_seconds == 8
    assert persisted.version == 2
    audits = duration_db.scalars(
        select(AdminAuditLog).where(
            AdminAuditLog.action == "video_model_duration.update",
        )
    ).all()
    assert len(audits) == 2
    update_audit = next(audit for audit in audits if audit.before_json is not None)
    second_before = json.loads(update_audit.before_json)
    second_after = json.loads(update_audit.after_json)
    assert second_before["call_duration_seconds"] == 5
    assert second_after["call_duration_seconds"] == 8


@pytest.mark.parametrize("invalid", [0, -1, "NaN", "Infinity", "-Infinity"])
def test_write_rejects_non_finite_zero_and_negative_durations(
    tmp_path, duration_db, invalid
):
    with _client(tmp_path, duration_db, FakeVideoCatalog(), ADMIN) as client:
        response = client.put(
            "/api/admin/video-model-duration-settings/invalid-model",
            json={
                "call_duration_seconds": invalid,
                "expected_version": 0,
                "reason": "invalid value",
            },
        )

    assert response.status_code == 422
    assert (
        VideoModelDurationService(duration_db).get(
            provider="newapi", model_id="invalid-model"
        )
        is None
    )


def test_catalog_failure_returns_persisted_settings_without_deleting_them(
    tmp_path, duration_db
):
    catalog = FakeVideoCatalog()
    catalog.fail = True
    before = len(VideoModelDurationService(duration_db).list(provider="newapi"))
    with _client(tmp_path, duration_db, catalog, ADMIN) as client:
        response = client.get("/api/admin/video-model-duration-settings")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["catalog_refresh_status"] == "failed"
    assert body["catalog_error_code"] == "provider_model_catalog_unavailable"
    assert len(body["models"]) == before
    assert all(
        item["catalog_status"] == "missing_from_catalog" for item in body["models"]
    )
    assert len(VideoModelDurationService(duration_db).list(provider="newapi")) == before


def test_admin_can_delete_only_a_catalog_missing_setting(tmp_path, duration_db):
    catalog = FakeVideoCatalog()
    with _client(tmp_path, duration_db, catalog, ADMIN) as client:
        missing = VideoModelDurationService(duration_db).get(
            provider="newapi", model_id="sora_v2"
        )
        assert missing is not None
        deleted = client.request(
            "DELETE",
            "/api/admin/video-model-duration-settings/sora_v2",
            json={
                "expected_version": missing.version,
                "reason": "provider removed the model directory",
            },
        )

        available = VideoModelDurationService(duration_db).get(
            provider="newapi", model_id="omni_flash-10s"
        )
        assert available is not None
        rejected = client.request(
            "DELETE",
            "/api/admin/video-model-duration-settings/omni_flash-10s",
            json={
                "expected_version": available.version,
                "reason": "must not delete a live model",
            },
        )

    assert deleted.status_code == 204, deleted.text
    assert rejected.status_code == 409
    assert rejected.json()["detail"]["code"] == "video_model_still_in_catalog"
    assert VideoModelDurationService(duration_db).get(
        provider="newapi", model_id="sora_v2"
    ) is None
    audit = duration_db.scalar(
        select(AdminAuditLog).where(
            AdminAuditLog.action == "video_model_duration.delete"
        )
    )
    assert audit is not None
    assert json.loads(audit.after_json)["reason"] == (
        "provider removed the model directory"
    )


def test_delete_requires_catalog_verification_and_matching_version(
    tmp_path, duration_db
):
    catalog = FakeVideoCatalog()
    missing = VideoModelDurationService(duration_db).get(
        provider="newapi", model_id="sora_v2"
    )
    assert missing is not None
    with _client(tmp_path, duration_db, catalog, ADMIN) as client:
        conflict = client.request(
            "DELETE",
            "/api/admin/video-model-duration-settings/sora_v2",
            json={"expected_version": missing.version + 1, "reason": "stale tab"},
        )
        catalog.fail = True
        unavailable = client.request(
            "DELETE",
            "/api/admin/video-model-duration-settings/sora_v2",
            json={"expected_version": missing.version, "reason": "catalog down"},
        )

    assert conflict.status_code == 409
    assert unavailable.status_code == 503
    assert unavailable.json()["detail"]["code"] == (
        "provider_model_catalog_unavailable"
    )
    assert VideoModelDurationService(duration_db).get(
        provider="newapi", model_id="sora_v2"
    ) is not None


POSTGRES_URL_ENV = "GENERATION_UNITS_ACCEPTANCE_DATABASE_URL"


@pytest.mark.skipif(
    not os.getenv(POSTGRES_URL_ENV),
    reason=f"set {POSTGRES_URL_ENV} to verify PostgreSQL constraints",
)
def test_postgres_constraints_and_optimistic_update_path():
    database_url = os.environ[POSTGRES_URL_ENV]
    assert "generation_units_acceptance" in database_url
    admin_engine = create_engine(database_url, isolation_level="AUTOCOMMIT")
    schema_name = f"video_model_duration_{uuid.uuid4().hex}"
    engine = None
    try:
        with admin_engine.begin() as connection:
            connection.exec_driver_sql(f'CREATE SCHEMA "{schema_name}"')
        engine = create_engine(
            database_url,
            connect_args={"options": f"-csearch_path={schema_name}"},
        )
        Base.metadata.create_all(engine)
        with Session(engine, expire_on_commit=False) as db:
            db.add(
                User(
                    id=ADMIN.id,
                    email=ADMIN.email,
                    password_hash="hash",
                    role="admin",
                    status="active",
                )
            )
            bootstrap_verified_duration_settings(db)
            service = VideoModelDurationService(db)
            setting = service.update(
                provider="newapi",
                model_id="postgres-model",
                call_duration_seconds=10,
                expected_version=0,
                updated_by=ADMIN.id,
                reason="postgres verification",
            )
            db.commit()
            assert setting.version == 1
            assert (
                service.effective_profile(
                    "postgres-model", "text_to_video"
                ).fixed_duration_seconds
                == 10
            )
    finally:
        if engine is not None:
            engine.dispose()
        with admin_engine.begin() as connection:
            connection.exec_driver_sql(f'DROP SCHEMA IF EXISTS "{schema_name}" CASCADE')
        admin_engine.dispose()
