from __future__ import annotations

import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from server.app.assets.legacy_recovery import (
    audit_legacy_assets,
    restore_legacy_assets,
)
from server.app.assets.models import MediaAsset, MediaAssetProjectLink
from server.app.auth.models import User
from server.app.billing.models import BillingSetting
from server.app.db.base import Base
from server.app.projects.models import ProjectRecord
from server.app.wallet.models import WalletAccount
from server.manage import run_manage


OWNER_ID = "1" * 32
OTHER_OWNER_ID = "2" * 32
OWNER_EMAIL = "owner@example.com"
CREATED_AT = "2026-01-01T00:00:00+00:00"
UPDATED_AT = "2026-01-02T00:00:00+00:00"


@pytest.fixture
def recovery_db():
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
                    id=OWNER_ID,
                    email=OWNER_EMAIL,
                    password_hash="hash",
                    role="user",
                    status="active",
                ),
                User(
                    id=OTHER_OWNER_ID,
                    email="other@example.com",
                    password_hash="hash",
                    role="user",
                    status="active",
                ),
                WalletAccount(
                    id="3" * 32,
                    user_id=OWNER_ID,
                    balance_units=0,
                    held_units=0,
                ),
                WalletAccount(
                    id="4" * 32,
                    user_id=OTHER_OWNER_ID,
                    balance_units=0,
                    held_units=0,
                ),
                BillingSetting(id=1, multiplier_bps=10_000, version=0),
            ]
        )
        db.commit()
        yield db
    engine.dispose()


def _legacy_sqlite(path: Path, projects: list[dict[str, str]]) -> None:
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
        connection.executemany(
            "INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)",
            [
                (
                    project["id"],
                    project.get("title", "Legacy"),
                    project.get("mode", "short_drama"),
                    project.get("project_type", "single_video"),
                    project.get("created_at", CREATED_AT),
                    project.get("updated_at", UPDATED_AT),
                )
                for project in projects
            ],
        )


def _project(project_id: str | None = None, **values: str) -> dict[str, str]:
    return {"id": project_id or uuid.uuid4().hex, **values}


def _workspace(
    projects_root: Path,
    project_id: str,
    *,
    asset_library: list[object] | None = None,
    series_assets: list[object] | None = None,
) -> Path:
    project_dir = projects_root / project_id
    artifacts = project_dir / "artifacts"
    artifacts.mkdir(parents=True)
    if asset_library is not None:
        (artifacts / "asset_library.json").write_text(
            json.dumps({"assets": asset_library}), encoding="utf-8"
        )
    if series_assets is not None:
        (artifacts / "series_bible.json").write_text(
            json.dumps({"title": "Legacy", "assets": series_assets}),
            encoding="utf-8",
        )
    return project_dir


def _upload_asset(
    *,
    asset_hex: str = "a" * 32,
    path: str | None = None,
    label: str = "Upload",
) -> dict[str, object]:
    return {
        "id": f"asset-{asset_hex}",
        "kind": "character",
        "label": label,
        "description": "Legacy upload",
        "prompt": "Keep this reference",
        "reference_images": [path or f"assets/images/character/asset-{asset_hex}.png"],
        "shot_ids": [],
        "version": 1,
    }


def _explicit_asset(
    *,
    asset_id: str,
    path: str,
    source_type: str,
    kind: str = "scene",
) -> dict[str, object]:
    return {
        "id": asset_id,
        "kind": kind,
        "label": asset_id,
        "description": "",
        "prompt": "",
        "source_type": source_type,
        "media_urls": [path],
    }


def _database_project(project: dict[str, str], owner_id: str) -> ProjectRecord:
    return ProjectRecord(
        id=project["id"],
        owner_user_id=owner_id,
        title=project.get("title", "Legacy"),
        mode=project.get("mode", "short_drama"),
        project_type=project.get("project_type", "single_video"),
        created_at=datetime.fromisoformat(project.get("created_at", CREATED_AT)),
        updated_at=datetime.fromisoformat(project.get("updated_at", UPDATED_AT)),
    )


def test_audit_empty_legacy_database_and_directory_are_stable(recovery_db, tmp_path):
    sqlite_path = tmp_path / "legacy.sqlite3"
    projects_root = tmp_path / "projects"
    projects_root.mkdir()
    _legacy_sqlite(sqlite_path, [])

    first = audit_legacy_assets(recovery_db, sqlite_path, projects_root)
    second = audit_legacy_assets(recovery_db, sqlite_path, projects_root)

    assert first == second
    assert first["schema_version"] == 1
    assert first["sqlite_projects"] == {"count": 0, "ids": []}
    assert first["database_projects"] == {
        "count_in_scope": 0,
        "ids_in_scope": [],
        "total_count": 0,
    }
    assert first["project_directories"]["count"] == 0
    assert first["project_import"]["pending_ids"] == []
    assert first["assets"]["deduplicated_resource_count"] == 0


def test_audit_reports_projects_conflicts_ready_missing_sources_and_directory_only(
    recovery_db, tmp_path
):
    pending = _project(title="Pending")
    conflict = _project(title="Expected")
    directory_only = uuid.uuid4().hex
    sqlite_path = tmp_path / "legacy.sqlite3"
    projects_root = tmp_path / "projects"
    projects_root.mkdir()
    _legacy_sqlite(sqlite_path, [pending, conflict])

    upload = _upload_asset()
    ai = _explicit_asset(
        asset_id="legacy-ai",
        path="assets/images/generated/output.png",
        source_type="ai_generated",
    )
    unknown = {
        "id": "legacy-unknown",
        "kind": "prop",
        "label": "Unknown",
        "reference_images": ["assets/images/props/unknown.png"],
    }
    project_dir = _workspace(
        projects_root,
        pending["id"],
        asset_library=[upload, ai, unknown],
        series_assets=[],
    )
    ready_path = project_dir / upload["reference_images"][0]
    ready_path.parent.mkdir(parents=True)
    ready_path.write_bytes(b"png")
    _workspace(projects_root, conflict["id"], asset_library=[])
    _workspace(projects_root, directory_only, series_assets=[])
    database_conflict = _database_project(conflict, OWNER_ID)
    database_conflict.title = "Different"
    recovery_db.add(database_conflict)
    recovery_db.commit()

    report = audit_legacy_assets(recovery_db, sqlite_path, projects_root)

    assert report["sqlite_projects"]["count"] == 2
    assert report["project_directories"]["count"] == 3
    assert report["project_directories"]["not_in_sqlite_ids"] == [directory_only]
    assert report["project_import"]["pending_ids"] == [pending["id"]]
    assert report["project_import"]["conflict_ids"] == [conflict["id"]]
    assert report["assets"]["ready_file_count"] == 1
    assert report["assets"]["missing_file_count"] == 2
    assert report["assets"]["source_counts"] == {
        "ai_generated": 1,
        "unknown": 1,
        "upload": 1,
    }


def test_asset_library_wins_and_series_bible_only_supplements_missing_resources(
    recovery_db, tmp_path
):
    project = _project()
    sqlite_path = tmp_path / "legacy.sqlite3"
    projects_root = tmp_path / "projects"
    projects_root.mkdir()
    _legacy_sqlite(sqlite_path, [project])
    primary = _upload_asset(label="Primary")
    duplicate = {**primary, "label": "Secondary duplicate"}
    supplemental = _explicit_asset(
        asset_id="supplemental",
        path="assets/images/scene/supplemental.png",
        source_type="upload",
    )
    _workspace(
        projects_root,
        project["id"],
        asset_library=[primary],
        series_assets=[duplicate, supplemental],
    )

    report = audit_legacy_assets(recovery_db, sqlite_path, projects_root)

    assert report["assets"]["asset_library_record_count"] == 1
    assert report["assets"]["series_bible_record_count"] == 2
    assert report["assets"]["deduplicated_resource_count"] == 2
    primary_item = next(
        item
        for item in report["assets"]["items"]
        if item["legacy_asset_id"] == primary["id"]
    )
    assert primary_item["label"] == "Primary"
    assert primary_item["artifact_source"] == "asset_library"


def test_restore_ready_and_missing_uploads_is_idempotent(recovery_db, tmp_path):
    project = _project()
    sqlite_path = tmp_path / "legacy.sqlite3"
    projects_root = tmp_path / "projects"
    projects_root.mkdir()
    _legacy_sqlite(sqlite_path, [project])
    ready = _upload_asset(asset_hex="a" * 32, label="Ready")
    missing = _upload_asset(asset_hex="b" * 32, label="Missing")
    project_dir = _workspace(
        projects_root,
        project["id"],
        asset_library=[ready, missing],
    )
    ready_path = project_dir / ready["reference_images"][0]
    ready_path.parent.mkdir(parents=True)
    ready_path.write_bytes(b"ready")

    first = restore_legacy_assets(
        recovery_db,
        sqlite_path,
        projects_root,
        owner_email=" OWNER@EXAMPLE.COM ",
    )
    second = restore_legacy_assets(
        recovery_db,
        sqlite_path,
        projects_root,
        owner_email=OWNER_EMAIL,
    )

    assets = list(recovery_db.scalars(select(MediaAsset).order_by(MediaAsset.label)))
    assert first["status"] == "restored"
    assert first["writes"] == {
        "assets_created": 2,
        "assets_updated": 0,
        "projects_claimed": 0,
        "projects_created": 1,
        "project_links_created": 2,
    }
    assert second["writes"] == {
        "assets_created": 0,
        "assets_updated": 0,
        "projects_claimed": 0,
        "projects_created": 0,
        "project_links_created": 0,
    }
    assert [(asset.label, asset.status) for asset in assets] == [
        ("Missing", "missing"),
        ("Ready", "ready"),
    ]
    assert all(asset.owner_user_id == OWNER_ID for asset in assets)
    assert recovery_db.scalar(select(func.count(MediaAssetProjectLink.asset_id))) == 2
    assert recovery_db.get(ProjectRecord, project["id"]).owner_user_id == OWNER_ID


def test_restore_dry_run_plans_without_database_or_file_writes(recovery_db, tmp_path):
    project = _project()
    sqlite_path = tmp_path / "legacy.sqlite3"
    projects_root = tmp_path / "projects"
    projects_root.mkdir()
    _legacy_sqlite(sqlite_path, [project])
    upload = _upload_asset()
    project_dir = _workspace(projects_root, project["id"], asset_library=[upload])
    files_before = sorted(
        path.relative_to(projects_root) for path in projects_root.rglob("*")
    )

    report = restore_legacy_assets(
        recovery_db,
        sqlite_path,
        projects_root,
        owner_email=OWNER_EMAIL,
        dry_run=True,
    )

    assert report["status"] == "dry_run"
    assert report["can_restore"] is True
    assert report["writes"] == {
        "assets_created": 0,
        "assets_updated": 0,
        "projects_claimed": 0,
        "projects_created": 0,
        "project_links_created": 0,
    }
    assert recovery_db.get(ProjectRecord, project["id"]) is None
    assert recovery_db.scalar(select(func.count(MediaAsset.id))) == 0
    assert (
        sorted(path.relative_to(projects_root) for path in projects_root.rglob("*"))
        == files_before
    )
    assert project_dir.is_dir()


def test_restore_refuses_project_owned_by_another_user_with_zero_writes(
    recovery_db, tmp_path
):
    project = _project()
    sqlite_path = tmp_path / "legacy.sqlite3"
    projects_root = tmp_path / "projects"
    projects_root.mkdir()
    _legacy_sqlite(sqlite_path, [project])
    _workspace(projects_root, project["id"], asset_library=[_upload_asset()])
    recovery_db.add(_database_project(project, OTHER_OWNER_ID))
    recovery_db.commit()

    report = restore_legacy_assets(
        recovery_db,
        sqlite_path,
        projects_root,
        owner_email=OWNER_EMAIL,
    )

    assert report["status"] == "blocked"
    assert report["can_restore"] is False
    assert report["assets"]["blocked"] == [
        {"code": "project_owner_conflict", "project_id": project["id"]}
    ]
    assert recovery_db.get(ProjectRecord, project["id"]).owner_user_id == OTHER_OWNER_ID
    assert recovery_db.scalar(select(func.count(MediaAsset.id))) == 0


def test_restore_same_owner_project_keeps_newer_metadata_and_backfills_assets(
    recovery_db, tmp_path
):
    project = _project(title="Legacy title")
    sqlite_path = tmp_path / "legacy.sqlite3"
    projects_root = tmp_path / "projects"
    projects_root.mkdir()
    _legacy_sqlite(sqlite_path, [project])
    _workspace(projects_root, project["id"], asset_library=[_upload_asset()])
    existing = _database_project(project, OWNER_ID)
    existing.title = "Current title"
    existing.updated_at = datetime(2026, 6, 1, tzinfo=timezone.utc)
    recovery_db.add(existing)
    recovery_db.commit()

    report = restore_legacy_assets(
        recovery_db,
        sqlite_path,
        projects_root,
        owner_email=OWNER_EMAIL,
    )

    recovery_db.refresh(existing)
    assert report["status"] == "restored"
    assert report["projects"]["existing_ids"] == [project["id"]]
    assert existing.title == "Current title"
    assert existing.updated_at == datetime(2026, 6, 1)
    assert recovery_db.scalar(select(func.count(MediaAsset.id))) == 1
    assert recovery_db.scalar(select(func.count(MediaAssetProjectLink.asset_id))) == 1


@pytest.mark.parametrize(
    ("raw_path", "reason"),
    [
        ("C:/outside/reference.png", "asset_path_absolute"),
        ("../outside/reference.png", "asset_path_traversal"),
        ("assets/images/../../outside.png", "asset_path_traversal"),
    ],
)
def test_audit_rejects_absolute_and_traversal_paths(
    recovery_db, tmp_path, raw_path, reason
):
    project = _project()
    sqlite_path = tmp_path / "legacy.sqlite3"
    projects_root = tmp_path / "projects"
    projects_root.mkdir()
    _legacy_sqlite(sqlite_path, [project])
    _workspace(
        projects_root,
        project["id"],
        asset_library=[
            _explicit_asset(asset_id="unsafe", path=raw_path, source_type="upload")
        ],
    )

    report = audit_legacy_assets(recovery_db, sqlite_path, projects_root)

    assert report["assets"]["deduplicated_resource_count"] == 0
    assert report["assets"]["rejected_resource_count"] == 1
    assert report["assets"]["rejected"][0]["reason"] == reason


def test_audit_rejects_symbolic_link_escape(recovery_db, tmp_path):
    project = _project()
    sqlite_path = tmp_path / "legacy.sqlite3"
    projects_root = tmp_path / "projects"
    projects_root.mkdir()
    _legacy_sqlite(sqlite_path, [project])
    asset = _explicit_asset(
        asset_id="linked",
        path="assets/images/scene/linked.png",
        source_type="upload",
    )
    project_dir = _workspace(projects_root, project["id"], asset_library=[asset])
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"outside")
    linked = project_dir / "assets" / "images" / "scene" / "linked.png"
    linked.parent.mkdir(parents=True)
    try:
        os.symlink(outside, linked)
    except OSError:
        if os.name != "nt":
            pytest.skip("symbolic links are not available on this host")
        import _winapi

        linked.parent.rmdir()
        outside_dir = tmp_path / "outside-directory"
        outside_dir.mkdir()
        (outside_dir / linked.name).write_bytes(b"outside")
        _winapi.CreateJunction(str(outside_dir), str(linked.parent))

    try:
        report = audit_legacy_assets(recovery_db, sqlite_path, projects_root)
    finally:
        if linked.parent.is_junction():
            linked.parent.rmdir()

    assert report["assets"]["deduplicated_resource_count"] == 0
    assert report["assets"]["rejected"][0]["reason"] == "asset_path_escape"


def test_unknown_source_is_reported_and_skipped_without_becoming_upload(
    recovery_db, tmp_path
):
    project = _project()
    sqlite_path = tmp_path / "legacy.sqlite3"
    projects_root = tmp_path / "projects"
    projects_root.mkdir()
    _legacy_sqlite(sqlite_path, [project])
    unknown = {
        "id": "mystery",
        "kind": "prop",
        "label": "Mystery",
        "reference_images": ["assets/images/prop/mystery.png"],
    }
    _workspace(projects_root, project["id"], series_assets=[unknown])

    report = restore_legacy_assets(
        recovery_db,
        sqlite_path,
        projects_root,
        owner_email=OWNER_EMAIL,
    )

    assert report["status"] == "restored"
    assert len(report["assets"]["skipped_unknown"]) == 1
    assert report["assets"]["skipped_unknown"][0]["source_type"] == "unknown"
    assert recovery_db.scalar(select(func.count(MediaAsset.id))) == 0


def test_legacy_ai_without_generation_job_restores_idempotently(recovery_db, tmp_path):
    project = _project()
    sqlite_path = tmp_path / "legacy.sqlite3"
    projects_root = tmp_path / "projects"
    projects_root.mkdir()
    _legacy_sqlite(sqlite_path, [project])
    legacy_ai = {
        "id": "legacy-ai",
        "kind": "scene",
        "label": "Generated frame",
        "prompt": "Generated with an old provider",
        "model": "old-image-model",
        "media_urls": ["assets/images/generated/legacy.png"],
    }
    _workspace(projects_root, project["id"], asset_library=[legacy_ai])

    dry_run = restore_legacy_assets(
        recovery_db,
        sqlite_path,
        projects_root,
        owner_email=OWNER_EMAIL,
        dry_run=True,
    )
    first = restore_legacy_assets(
        recovery_db,
        sqlite_path,
        projects_root,
        owner_email=OWNER_EMAIL,
    )
    second = restore_legacy_assets(
        recovery_db,
        sqlite_path,
        projects_root,
        owner_email=OWNER_EMAIL,
    )

    assert dry_run["status"] == "dry_run"
    assert dry_run["can_restore"] is True
    assert first["status"] == "restored"
    assert first["writes"] == {
        "assets_created": 1,
        "assets_updated": 0,
        "projects_claimed": 0,
        "projects_created": 1,
        "project_links_created": 1,
    }
    assert second["writes"] == {
        "assets_created": 0,
        "assets_updated": 0,
        "projects_claimed": 0,
        "projects_created": 0,
        "project_links_created": 0,
    }
    asset = recovery_db.scalar(select(MediaAsset))
    assert asset is not None
    assert asset.id == asset.recovery_key
    assert asset.owner_user_id == OWNER_ID
    assert asset.origin_project_id == project["id"]
    assert asset.source_type == "ai_generated"
    assert asset.label == "Generated frame"
    assert asset.prompt == "Generated with an old provider"
    assert asset.model == "old-image-model"
    assert asset.generation_job_id is None
    assert asset.output_index is None
    assert asset.status == "missing"
    link = recovery_db.get(MediaAssetProjectLink, (asset.id, project["id"]))
    assert link is not None
    assert link.storage_path == "assets/images/generated/legacy.png"


def test_manage_commands_emit_json_and_require_explicit_owner(
    recovery_db, tmp_path, capsys
):
    project = _project()
    sqlite_path = tmp_path / "legacy.sqlite3"
    projects_root = tmp_path / "projects"
    projects_root.mkdir()
    _legacy_sqlite(sqlite_path, [project])
    _workspace(projects_root, project["id"], asset_library=[])

    code = run_manage(
        [
            "audit-legacy-assets",
            "--sqlite-path",
            str(sqlite_path),
            "--projects-root",
            str(projects_root),
        ],
        db_session=recovery_db,
    )
    report = json.loads(capsys.readouterr().out)

    assert code == 0
    assert report["operation"] == "audit_legacy_assets"
    with pytest.raises(SystemExit) as exc_info:
        run_manage(
            [
                "restore-legacy-assets",
                "--sqlite-path",
                str(sqlite_path),
                "--projects-root",
                str(projects_root),
            ],
            db_session=recovery_db,
        )
    assert exc_info.value.code == 2
