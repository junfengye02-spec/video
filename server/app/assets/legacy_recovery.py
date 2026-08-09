from __future__ import annotations

import json
import mimetypes
import os
import re
import sqlite3
import stat
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath, PureWindowsPath
from urllib.parse import quote

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from server.app.assets.models import MediaAsset, MediaAssetProjectLink
from server.app.auth.models import User
from server.app.auth.security import normalize_email
from server.app.billing.models import GenerationJob
from server.app.projects.models import ProjectRecord
from server.app.projects.schemas import canonical_project_id


_REQUIRED_PROJECT_COLUMNS = {
    "id",
    "title",
    "mode",
    "project_type",
    "created_at",
    "updated_at",
}
_KINDS = {"character", "scene", "prop"}
_SOURCE_TYPES = {"upload", "ai_generated", "unknown"}
_UPLOAD_ID = re.compile(r"^asset-([0-9a-f]{32})$")
_GENERATED_PATH = re.compile(
    r"^assets/(?:images|video)/generated(?:/|$)", re.IGNORECASE
)
_GENERATED_TEXT = re.compile(
    r"\b(?:generated with|ai[- ]generated|i2v generated)\b", re.IGNORECASE
)
_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
_RECOVERY_NAMESPACE = uuid.UUID("f5e89d8b-ec56-46eb-94c6-550b794b42af")


class LegacyRecoveryError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code

    def as_dict(self) -> dict[str, str]:
        return {"code": self.code, "message": str(self)}


@dataclass(frozen=True, slots=True)
class LegacyProject:
    id: str
    title: str
    mode: str
    project_type: str
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class LegacyAssetCandidate:
    project_id: str
    legacy_asset_id: str
    artifact_source: str
    kind: str
    label: str
    description: str
    prompt: str
    model: str | None
    generation_job_id: str | None
    output_index: int | None
    source_type: str
    source_evidence: str
    storage_path: str
    content_type: str
    status: str
    recovery_key: str
    asset_id: str

    @property
    def uses_generation_job(self) -> bool:
        return (
            self.source_type == "ai_generated"
            and self.generation_job_id is not None
            and len(self.generation_job_id) == 32
            and self.output_index is not None
            and self.output_index >= 0
            and self.model is not None
        )

    @property
    def is_recovered_ai(self) -> bool:
        return self.source_type == "ai_generated" and not self.uses_generation_job

    def audit_dict(self) -> dict[str, object]:
        return {
            "artifact_source": self.artifact_source,
            "asset_id": self.asset_id,
            "kind": self.kind,
            "label": self.label,
            "legacy_asset_id": self.legacy_asset_id,
            "project_id": self.project_id,
            "recovery_key": self.recovery_key,
            "source_evidence": self.source_evidence,
            "source_type": self.source_type,
            "status": self.status,
            "storage_path": self.storage_path,
        }


@dataclass(frozen=True, slots=True)
class ProjectAssetScan:
    asset_library_record_count: int
    series_bible_record_count: int
    candidates: tuple[LegacyAssetCandidate, ...]
    rejected: tuple[dict[str, object], ...]


def audit_legacy_assets(
    db: Session,
    sqlite_path: str | Path,
    projects_root: str | Path,
) -> dict[str, object]:
    legacy_projects = _read_legacy_projects(sqlite_path)
    root = _projects_root(projects_root)
    directory_ids, invalid_directory_names = _project_directories(root)
    legacy_by_id = {project.id: project for project in legacy_projects}
    database_lookup_ids = sorted(set(legacy_by_id) | set(directory_ids))

    with db.no_autoflush:
        database_total_count = db.scalar(
            select(func.count()).select_from(ProjectRecord)
        )
        database_projects = (
            {
                project.id: project
                for project in db.scalars(
                    select(ProjectRecord).where(
                        ProjectRecord.id.in_(tuple(database_lookup_ids))
                    )
                ).all()
            }
            if database_lookup_ids
            else {}
        )

    pending_ids: list[str] = []
    existing_ids: list[str] = []
    conflict_ids: list[str] = []
    for project in legacy_projects:
        existing = database_projects.get(project.id)
        if existing is None:
            pending_ids.append(project.id)
        elif _same_project_metadata(existing, project):
            existing_ids.append(project.id)
        else:
            conflict_ids.append(project.id)

    all_project_ids = sorted(set(directory_ids) | set(legacy_by_id))
    aggregate = {
        "asset_library_record_count": 0,
        "series_bible_record_count": 0,
        "deduplicated_resource_count": 0,
        "ready_file_count": 0,
        "missing_file_count": 0,
        "rejected_resource_count": 0,
        "source_counts": {source: 0 for source in sorted(_SOURCE_TYPES)},
    }
    project_rows: list[dict[str, object]] = []
    asset_items: list[dict[str, object]] = []
    rejected_items: list[dict[str, object]] = []
    directory_id_set = set(directory_ids)
    for project_id in all_project_ids:
        scan = (
            _scan_project_assets(root, project_id)
            if project_id in directory_id_set
            else ProjectAssetScan(0, 0, (), ())
        )
        source_counts = {source: 0 for source in sorted(_SOURCE_TYPES)}
        ready_count = 0
        missing_count = 0
        for candidate in scan.candidates:
            source_counts[candidate.source_type] += 1
            if candidate.status == "ready":
                ready_count += 1
            else:
                missing_count += 1
            asset_items.append(candidate.audit_dict())
        for item in scan.rejected:
            rejected_source = item.get("source_type")
            if rejected_source in _SOURCE_TYPES:
                source_counts[str(rejected_source)] += 1
        rejected_items.extend(scan.rejected)

        aggregate["asset_library_record_count"] += scan.asset_library_record_count
        aggregate["series_bible_record_count"] += scan.series_bible_record_count
        aggregate["deduplicated_resource_count"] += len(scan.candidates)
        aggregate["ready_file_count"] += ready_count
        aggregate["missing_file_count"] += missing_count
        aggregate["rejected_resource_count"] += len(scan.rejected)
        for source, count in source_counts.items():
            aggregate["source_counts"][source] += count

        legacy = legacy_by_id.get(project_id)
        existing = database_projects.get(project_id)
        if legacy is None:
            import_state = "directory_only"
        elif existing is None:
            import_state = "pending_import"
        elif project_id in conflict_ids:
            import_state = "conflict"
        else:
            import_state = "existing"
        project_rows.append(
            {
                "asset_library_record_count": scan.asset_library_record_count,
                "database_exists": existing is not None,
                "directory_present": project_id in directory_id_set,
                "import_state": import_state,
                "missing_file_count": missing_count,
                "project_id": project_id,
                "ready_file_count": ready_count,
                "rejected_resource_count": len(scan.rejected),
                "resource_count": len(scan.candidates),
                "series_bible_record_count": scan.series_bible_record_count,
                "source_counts": source_counts,
                "sqlite_exists": legacy is not None,
            }
        )

    asset_items.sort(key=_asset_report_sort_key)
    rejected_items.sort(key=_rejected_report_sort_key)
    return {
        "assets": {
            **aggregate,
            "items": asset_items,
            "rejected": rejected_items,
        },
        "operation": "audit_legacy_assets",
        "database_projects": {
            "count_in_scope": len(database_projects),
            "ids_in_scope": sorted(database_projects),
            "total_count": int(database_total_count or 0),
        },
        "project_directories": {
            "count": len(directory_ids),
            "ids": list(directory_ids),
            "invalid_names": list(invalid_directory_names),
            "not_in_sqlite_ids": sorted(set(directory_ids) - set(legacy_by_id)),
        },
        "project_import": {
            "conflict_ids": conflict_ids,
            "existing_ids": existing_ids,
            "pending_ids": pending_ids,
        },
        "projects": project_rows,
        "schema_version": 1,
        "sqlite_projects": {
            "count": len(legacy_projects),
            "ids": [project.id for project in legacy_projects],
        },
    }


def restore_legacy_assets(
    db: Session,
    sqlite_path: str | Path,
    projects_root: str | Path,
    *,
    owner_email: str,
    project_id: str | None = None,
    dry_run: bool = False,
) -> dict[str, object]:
    normalized_email = normalize_email(owner_email)
    if not normalized_email:
        raise LegacyRecoveryError("invalid_owner_email", "Owner email is required")

    legacy_projects = _read_legacy_projects(sqlite_path)
    legacy_by_id = {project.id: project for project in legacy_projects}
    if project_id is not None:
        try:
            selected_id = canonical_project_id(project_id)
        except ValueError as exc:
            raise LegacyRecoveryError(
                "invalid_project_id", "Project ID is not a canonical server UUID"
            ) from exc
        if selected_id not in legacy_by_id:
            raise LegacyRecoveryError(
                "project_not_in_sqlite",
                "Project ID is not present in the legacy SQLite database",
            )
        selected_projects = [legacy_by_id[selected_id]]
    else:
        selected_projects = legacy_projects

    root = _projects_root(projects_root)
    directory_ids, _ = _project_directories(root)
    directory_id_set = set(directory_ids)
    scans = {
        project.id: (
            _scan_project_assets(root, project.id)
            if project.id in directory_id_set
            else ProjectAssetScan(0, 0, (), ())
        )
        for project in selected_projects
    }
    candidates = sorted(
        (candidate for scan in scans.values() for candidate in scan.candidates),
        key=lambda item: (item.project_id, item.storage_path, item.legacy_asset_id),
    )
    rejected = sorted(
        (item for scan in scans.values() for item in scan.rejected),
        key=_rejected_report_sort_key,
    )
    selected_ids = [project.id for project in selected_projects]

    try:
        owner_statement = select(User).where(User.email == normalized_email)
        if not dry_run:
            owner_statement = owner_statement.with_for_update()
        with db.no_autoflush:
            owner = db.scalar(owner_statement)
        if owner is None or owner.status != "active":
            raise LegacyRecoveryError(
                "owner_not_found", "Owner email must identify an active user"
            )

        project_statement = select(ProjectRecord).where(
            ProjectRecord.id.in_(tuple(selected_ids))
        )
        asset_statement = select(MediaAsset).where(
            MediaAsset.origin_project_id.in_(tuple(selected_ids))
        )
        link_statement = select(MediaAssetProjectLink).where(
            MediaAssetProjectLink.project_id.in_(tuple(selected_ids))
        )
        if not dry_run:
            project_statement = project_statement.with_for_update()
            asset_statement = asset_statement.with_for_update()
            link_statement = link_statement.with_for_update()
        with db.no_autoflush:
            existing_projects = (
                {project.id: project for project in db.scalars(project_statement).all()}
                if selected_ids
                else {}
            )
            existing_assets = (
                list(db.scalars(asset_statement).all()) if selected_ids else []
            )
            existing_links = (
                list(db.scalars(link_statement).all()) if selected_ids else []
            )

        blockers: list[dict[str, object]] = []
        planned_project_ids: list[str] = []
        existing_project_ids: list[str] = []
        claimed_project_ids: list[str] = []
        for legacy in selected_projects:
            existing = existing_projects.get(legacy.id)
            if existing is None:
                planned_project_ids.append(legacy.id)
                continue
            if existing.owner_user_id not in {None, owner.id}:
                blockers.append(
                    {
                        "code": "project_owner_conflict",
                        "project_id": legacy.id,
                    }
                )
                continue
            if existing.owner_user_id is None and not _same_project_metadata(
                existing, legacy
            ):
                blockers.append(
                    {
                        "code": "project_metadata_conflict",
                        "project_id": legacy.id,
                    }
                )
                continue
            existing_project_ids.append(legacy.id)
            if existing.owner_user_id is None:
                claimed_project_ids.append(legacy.id)

        existing_by_id = {asset.id: asset for asset in existing_assets}
        existing_links_by_key = {
            (link.asset_id, link.project_id): link for link in existing_links
        }
        existing_by_resource: dict[tuple[str, str], list[MediaAsset]] = {}
        existing_by_generation_output: dict[tuple[str, int], list[MediaAsset]] = {}
        existing_by_recovery_key: dict[str, list[MediaAsset]] = {}
        for asset in existing_assets:
            existing_by_resource.setdefault(
                (asset.origin_project_id, asset.storage_path), []
            ).append(asset)
            if asset.generation_job_id is not None and asset.output_index is not None:
                existing_by_generation_output.setdefault(
                    (asset.generation_job_id, asset.output_index), []
                ).append(asset)
            if asset.recovery_key is not None:
                existing_by_recovery_key.setdefault(asset.recovery_key, []).append(
                    asset
                )

        planned_candidates: list[LegacyAssetCandidate] = []
        existing_asset_ids: list[str] = []
        existing_link_asset_ids: list[str] = []
        planned_links: list[tuple[str, LegacyAssetCandidate]] = []
        status_updates: list[tuple[MediaAsset, str]] = []
        skipped_unknown = [
            candidate.audit_dict()
            for candidate in candidates
            if candidate.source_type == "unknown"
        ]
        for candidate in candidates:
            if candidate.source_type == "unknown":
                continue
            if candidate.uses_generation_job:
                ai_blocker = _validate_ai_candidate(db, candidate, owner.id)
                if ai_blocker is not None:
                    blockers.append(ai_blocker)
                    continue

            id_match = existing_by_id.get(candidate.asset_id)
            resource_matches = existing_by_resource.get(
                (candidate.project_id, candidate.storage_path), []
            )
            matches = list(resource_matches)
            if (
                candidate.generation_job_id is not None
                and candidate.output_index is not None
            ):
                for output_match in existing_by_generation_output.get(
                    (candidate.generation_job_id, candidate.output_index), []
                ):
                    if output_match not in matches:
                        matches.append(output_match)
            if candidate.is_recovered_ai:
                for recovery_match in existing_by_recovery_key.get(
                    candidate.recovery_key, []
                ):
                    if recovery_match not in matches:
                        matches.append(recovery_match)
            if id_match is not None and id_match not in matches:
                matches.append(id_match)
            if len(matches) > 1:
                blockers.append(
                    {
                        "asset_id": candidate.asset_id,
                        "code": "asset_resource_conflict",
                        "project_id": candidate.project_id,
                        "storage_path": candidate.storage_path,
                    }
                )
                continue
            if matches:
                existing_asset = matches[0]
                if not _compatible_existing_asset(existing_asset, candidate, owner.id):
                    blockers.append(
                        {
                            "asset_id": candidate.asset_id,
                            "code": "asset_resource_conflict",
                            "project_id": candidate.project_id,
                            "storage_path": candidate.storage_path,
                        }
                    )
                    continue
                existing_asset_ids.append(existing_asset.id)
                if existing_asset.status != candidate.status:
                    status_updates.append((existing_asset, candidate.status))
                existing_link = existing_links_by_key.get(
                    (existing_asset.id, candidate.project_id)
                )
                if existing_link is None:
                    planned_links.append((existing_asset.id, candidate))
                elif existing_link.storage_path != candidate.storage_path:
                    blockers.append(
                        {
                            "asset_id": existing_asset.id,
                            "code": "asset_project_link_conflict",
                            "project_id": candidate.project_id,
                            "storage_path": candidate.storage_path,
                        }
                    )
                else:
                    existing_link_asset_ids.append(existing_asset.id)
                continue
            planned_candidates.append(candidate)
            planned_links.append((candidate.asset_id, candidate))

        report: dict[str, object] = {
            "assets": {
                "blocked": sorted(blockers, key=_blocker_sort_key),
                "existing_ids": sorted(set(existing_asset_ids)),
                "existing_link_asset_ids": sorted(set(existing_link_asset_ids)),
                "planned_ids": [candidate.asset_id for candidate in planned_candidates],
                "planned_link_asset_ids": sorted(
                    {asset_id for asset_id, _ in planned_links}
                ),
                "rejected": rejected,
                "skipped_unknown": sorted(skipped_unknown, key=_asset_report_sort_key),
                "status_update_ids": sorted({asset.id for asset, _ in status_updates}),
            },
            "can_restore": not blockers,
            "dry_run": dry_run,
            "operation": "restore_legacy_assets",
            "owner_email": normalized_email,
            "projects": {
                "claimed_ids": claimed_project_ids,
                "existing_ids": existing_project_ids,
                "planned_ids": planned_project_ids,
                "selected_ids": selected_ids,
            },
            "schema_version": 1,
            "status": "dry_run" if dry_run else "blocked" if blockers else "restored",
            "writes": {
                "assets_created": 0,
                "assets_updated": 0,
                "projects_claimed": 0,
                "projects_created": 0,
                "project_links_created": 0,
            },
        }
        if dry_run:
            return report
        if blockers:
            db.rollback()
            return report

        for legacy in selected_projects:
            existing = existing_projects.get(legacy.id)
            if existing is None:
                db.add(
                    ProjectRecord(
                        id=legacy.id,
                        owner_user_id=owner.id,
                        title=legacy.title,
                        mode=legacy.mode,
                        project_type=legacy.project_type,
                        created_at=legacy.created_at,
                        updated_at=legacy.updated_at,
                    )
                )
            elif existing.owner_user_id is None:
                existing.owner_user_id = owner.id

        project_times = {
            project.id: project.created_at for project in selected_projects
        }
        for candidate in planned_candidates:
            db.add(
                MediaAsset(
                    id=candidate.asset_id,
                    owner_user_id=owner.id,
                    origin_project_id=candidate.project_id,
                    kind=candidate.kind,
                    source_type=candidate.source_type,
                    label=candidate.label,
                    description=candidate.description,
                    prompt=candidate.prompt,
                    model=candidate.model
                    if candidate.source_type == "ai_generated"
                    else None,
                    generation_job_id=(
                        candidate.generation_job_id
                        if candidate.uses_generation_job
                        else None
                    ),
                    output_index=(
                        candidate.output_index
                        if candidate.uses_generation_job
                        else None
                    ),
                    recovery_key=(
                        candidate.recovery_key if candidate.is_recovered_ai else None
                    ),
                    storage_path=candidate.storage_path,
                    content_type=candidate.content_type,
                    status=candidate.status,
                    created_at=project_times[candidate.project_id],
                    updated_at=project_times[candidate.project_id],
                )
            )
        for existing_asset, status_value in status_updates:
            existing_asset.status = status_value
        for asset_id, candidate in planned_links:
            db.add(
                MediaAssetProjectLink(
                    asset_id=asset_id,
                    project_id=candidate.project_id,
                    storage_path=candidate.storage_path,
                    created_at=project_times[candidate.project_id],
                    updated_at=project_times[candidate.project_id],
                )
            )
        db.flush()
        db.commit()
        report["writes"] = {
            "assets_created": len(planned_candidates),
            "assets_updated": len(status_updates),
            "projects_claimed": len(claimed_project_ids),
            "projects_created": len(planned_project_ids),
            "project_links_created": len(planned_links),
        }
        return report
    except LegacyRecoveryError:
        if not dry_run:
            db.rollback()
        raise
    except Exception:
        if not dry_run:
            db.rollback()
        raise


def _read_legacy_projects(sqlite_path: str | Path) -> list[LegacyProject]:
    path = Path(sqlite_path).expanduser().resolve()
    if not path.is_file():
        raise LegacyRecoveryError(
            "sqlite_not_found", "Legacy SQLite database does not exist"
        )
    uri = f"file:{quote(path.as_posix(), safe='/:')}?mode=ro"
    try:
        with sqlite3.connect(uri, uri=True) as legacy:
            legacy.row_factory = sqlite3.Row
            legacy.execute("PRAGMA query_only = ON")
            columns = {
                row["name"]
                for row in legacy.execute("PRAGMA table_info(projects)").fetchall()
            }
            if not _REQUIRED_PROJECT_COLUMNS.issubset(columns):
                raise LegacyRecoveryError(
                    "unsupported_sqlite_schema",
                    "Legacy SQLite projects table has an unsupported schema",
                )
            rows = legacy.execute(
                """
                SELECT id, title, mode, project_type, created_at, updated_at
                FROM projects
                ORDER BY id
                """
            ).fetchall()
    except sqlite3.Error as exc:
        raise LegacyRecoveryError(
            "sqlite_read_failed", "Legacy SQLite database could not be read"
        ) from exc
    return [_legacy_project(row) for row in rows]


def _legacy_project(row: sqlite3.Row) -> LegacyProject:
    project_id = _bounded_text(row["id"], "project id", 32)
    try:
        canonical_project_id(project_id)
    except ValueError as exc:
        raise LegacyRecoveryError(
            "invalid_legacy_project", "Legacy project ID is not a canonical server UUID"
        ) from exc
    title = _bounded_text(row["title"], "project title", 255)
    mode = _bounded_text(row["mode"], "project mode", 32)
    project_type = _bounded_text(row["project_type"], "project type", 32)
    if mode not in {"short_drama", "general_video"}:
        raise LegacyRecoveryError(
            "invalid_legacy_project",
            f"Legacy project {project_id} has an unsupported mode",
        )
    if project_type not in {"single_video", "mini_series", "long_series"}:
        raise LegacyRecoveryError(
            "invalid_legacy_project",
            f"Legacy project {project_id} has an unsupported project type",
        )
    return LegacyProject(
        id=project_id,
        title=title,
        mode=mode,
        project_type=project_type,
        created_at=_parse_datetime(row["created_at"], project_id),
        updated_at=_parse_datetime(row["updated_at"], project_id),
    )


def _projects_root(projects_root: str | Path) -> Path:
    root = Path(projects_root).expanduser()
    if not root.is_dir():
        raise LegacyRecoveryError(
            "projects_root_not_found", "Projects root does not exist"
        )
    if _is_link_or_junction(root):
        raise LegacyRecoveryError(
            "projects_root_is_link", "Projects root must not be a link or junction"
        )
    return root.resolve(strict=True)


def _project_directories(root: Path) -> tuple[tuple[str, ...], tuple[str, ...]]:
    project_ids: list[str] = []
    invalid_names: list[str] = []
    for entry in root.iterdir():
        if not entry.is_dir() and not _is_link_or_junction(entry):
            continue
        try:
            canonical_project_id(entry.name)
        except ValueError:
            invalid_names.append(entry.name)
        else:
            project_ids.append(entry.name)
    return tuple(sorted(project_ids)), tuple(sorted(invalid_names))


def _scan_project_assets(root: Path, project_id: str) -> ProjectAssetScan:
    lexical_project_dir = root / canonical_project_id(project_id)
    if _is_link_or_junction(lexical_project_dir):
        return ProjectAssetScan(
            0,
            0,
            (),
            (_rejection(project_id, "project_directory_link"),),
        )
    try:
        resolved_project_dir = lexical_project_dir.resolve(strict=True)
    except (FileNotFoundError, OSError):
        return ProjectAssetScan(
            0,
            0,
            (),
            (_rejection(project_id, "project_directory_invalid"),),
        )
    if not _is_within(root, resolved_project_dir) or not resolved_project_dir.is_dir():
        return ProjectAssetScan(
            0,
            0,
            (),
            (_rejection(project_id, "project_directory_escape"),),
        )

    primary, primary_errors = _artifact_assets(
        resolved_project_dir, "asset_library.json", "asset_library"
    )
    secondary, secondary_errors = _artifact_assets(
        resolved_project_dir, "series_bible.json", "series_bible"
    )
    rejected: list[dict[str, object]] = [*primary_errors, *secondary_errors]

    primary_ids = {
        raw.get("id")
        for raw in primary
        if isinstance(raw, dict) and isinstance(raw.get("id"), str)
    }
    selected: list[tuple[str, int, object]] = [
        ("asset_library", index, raw) for index, raw in enumerate(primary)
    ]
    selected.extend(
        ("series_bible", index, raw)
        for index, raw in enumerate(secondary)
        if not (
            isinstance(raw, dict)
            and isinstance(raw.get("id"), str)
            and raw.get("id") in primary_ids
        )
    )

    candidates: list[LegacyAssetCandidate] = []
    seen_paths: set[str] = set()
    for artifact_source, index, raw in selected:
        record_candidates, record_rejected = _asset_record_candidates(
            project_id=project_id,
            project_dir=resolved_project_dir,
            artifact_source=artifact_source,
            index=index,
            raw=raw,
        )
        rejected.extend(record_rejected)
        for candidate in record_candidates:
            if candidate.storage_path in seen_paths:
                continue
            seen_paths.add(candidate.storage_path)
            candidates.append(candidate)
    return ProjectAssetScan(
        asset_library_record_count=len(primary),
        series_bible_record_count=len(secondary),
        candidates=tuple(
            sorted(
                candidates,
                key=lambda item: (item.storage_path, item.legacy_asset_id),
            )
        ),
        rejected=tuple(sorted(rejected, key=_rejected_report_sort_key)),
    )


def _artifact_assets(
    project_dir: Path,
    filename: str,
    artifact_source: str,
) -> tuple[list[object], list[dict[str, object]]]:
    artifact = project_dir / "artifacts" / filename
    resolved = artifact.resolve(strict=False)
    if not _is_within(project_dir, resolved):
        return [], [
            _rejection(
                project_dir.name,
                "artifact_path_escape",
                artifact_source=artifact_source,
            )
        ]
    if not artifact.exists():
        return [], []
    try:
        artifact_stat = artifact.stat(follow_symlinks=False)
        if (
            not stat.S_ISREG(artifact_stat.st_mode)
            or artifact_stat.st_size > _MAX_ARTIFACT_BYTES
        ):
            raise ValueError
        payload = json.loads(artifact.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
        return [], [
            _rejection(
                project_dir.name,
                "artifact_invalid",
                artifact_source=artifact_source,
            )
        ]
    if not isinstance(payload, dict) or not isinstance(payload.get("assets", []), list):
        return [], [
            _rejection(
                project_dir.name,
                "artifact_assets_invalid",
                artifact_source=artifact_source,
            )
        ]
    return list(payload.get("assets", [])), []


def _asset_record_candidates(
    *,
    project_id: str,
    project_dir: Path,
    artifact_source: str,
    index: int,
    raw: object,
) -> tuple[list[LegacyAssetCandidate], list[dict[str, object]]]:
    if not isinstance(raw, dict):
        return [], [
            _rejection(
                project_id,
                "asset_record_invalid",
                artifact_source=artifact_source,
                index=index,
            )
        ]
    legacy_asset_id = raw.get("id")
    kind = raw.get("kind")
    label = raw.get("label")
    if (
        not isinstance(legacy_asset_id, str)
        or not legacy_asset_id
        or len(legacy_asset_id) > 255
    ):
        reason = "asset_id_invalid"
    elif kind not in _KINDS:
        reason = "asset_kind_invalid"
    elif not isinstance(label, str) or not label or len(label) > 255:
        reason = "asset_label_invalid"
    else:
        reason = None
    if reason is not None:
        return [], [
            _rejection(
                project_id,
                reason,
                artifact_source=artifact_source,
                index=index,
                legacy_asset_id=legacy_asset_id
                if isinstance(legacy_asset_id, str)
                else None,
            )
        ]

    media_urls = raw.get("media_urls")
    reference_images = raw.get("reference_images")
    paths = (
        media_urls if isinstance(media_urls, list) and media_urls else reference_images
    )
    if not isinstance(paths, list) or not paths:
        return [], [
            _rejection(
                project_id,
                "asset_resource_missing",
                artifact_source=artifact_source,
                index=index,
                legacy_asset_id=legacy_asset_id,
            )
        ]

    description = (
        raw.get("description") if isinstance(raw.get("description"), str) else ""
    )
    prompt = raw.get("prompt") if isinstance(raw.get("prompt"), str) else ""
    model = (
        raw.get("model")
        if isinstance(raw.get("model"), str) and raw.get("model")
        else None
    )
    generation_job_id = (
        raw.get("generation_job_id")
        if isinstance(raw.get("generation_job_id"), str)
        else None
    )
    output_index = (
        raw.get("output_index") if type(raw.get("output_index")) is int else None
    )

    candidates: list[LegacyAssetCandidate] = []
    rejected: list[dict[str, object]] = []
    for path_index, raw_path in enumerate(paths):
        if not isinstance(raw_path, str):
            rejected.append(
                _rejection(
                    project_id,
                    "asset_path_invalid",
                    artifact_source=artifact_source,
                    index=index,
                    legacy_asset_id=legacy_asset_id,
                    path_index=path_index,
                )
            )
            continue
        source_type, evidence = _classify_source(raw, raw_path, legacy_asset_id, kind)
        try:
            storage_path, file_status = _safe_resource_path(project_dir, raw_path)
        except LegacyRecoveryError as exc:
            rejected.append(
                _rejection(
                    project_id,
                    exc.code,
                    artifact_source=artifact_source,
                    index=index,
                    legacy_asset_id=legacy_asset_id,
                    path=raw_path,
                    path_index=path_index,
                    source_type=source_type,
                )
            )
            continue
        recovery_key = uuid.uuid5(
            _RECOVERY_NAMESPACE, f"{project_id}\0{storage_path}"
        ).hex
        content_type, _ = mimetypes.guess_type(storage_path)
        candidates.append(
            LegacyAssetCandidate(
                project_id=project_id,
                legacy_asset_id=legacy_asset_id,
                artifact_source=artifact_source,
                kind=kind,
                label=label,
                description=description,
                prompt=prompt,
                model=model,
                generation_job_id=generation_job_id,
                output_index=output_index,
                source_type=source_type,
                source_evidence=evidence,
                storage_path=storage_path,
                content_type=content_type or "application/octet-stream",
                status=file_status,
                recovery_key=recovery_key,
                asset_id=recovery_key,
            )
        )
    return candidates, rejected


def _safe_resource_path(project_dir: Path, raw_path: str) -> tuple[str, str]:
    if not raw_path or len(raw_path) > 4096 or "\x00" in raw_path:
        raise LegacyRecoveryError("asset_path_invalid", "Asset path is invalid")
    windows = PureWindowsPath(raw_path)
    posix = PurePosixPath(raw_path.replace("\\", "/"))
    if (
        windows.is_absolute()
        or windows.drive
        or posix.is_absolute()
        or any(":" in part for part in posix.parts)
    ):
        raise LegacyRecoveryError("asset_path_absolute", "Asset path must be relative")
    if any(part in {"", ".", ".."} for part in posix.parts):
        raise LegacyRecoveryError(
            "asset_path_traversal", "Asset path contains traversal"
        )
    storage_path = posix.as_posix()
    candidate = (project_dir / Path(*posix.parts)).resolve(strict=False)
    if not _is_within(project_dir, candidate):
        raise LegacyRecoveryError("asset_path_escape", "Asset path escapes the project")
    if candidate.exists():
        try:
            file_stat = candidate.stat()
        except OSError as exc:
            raise LegacyRecoveryError(
                "asset_path_invalid", "Asset path is invalid"
            ) from exc
        if not stat.S_ISREG(file_stat.st_mode):
            raise LegacyRecoveryError("asset_path_not_file", "Asset path is not a file")
        return storage_path, "ready"
    return storage_path, "missing"


def _classify_source(
    raw: dict[str, object], raw_path: str, legacy_asset_id: str, kind: str
) -> tuple[str, str]:
    explicit = raw.get("source_type")
    if explicit == "ai_generated":
        return "ai_generated", "explicit_source_type"
    has_generation_metadata = (
        isinstance(raw.get("generation_job_id"), str)
        or type(raw.get("output_index")) is int
        or bool(raw.get("model"))
        or bool(raw.get("provider"))
        or bool(raw.get("generator"))
    )
    if has_generation_metadata:
        return "ai_generated", "generation_metadata"
    if explicit == "upload":
        return "upload", "explicit_source_type"
    if explicit is not None:
        return "unknown", "unsupported_explicit_source_type"
    normalized_path = raw_path.replace("\\", "/")
    if _GENERATED_PATH.match(normalized_path):
        return "ai_generated", "generated_storage_path"
    prompt = raw.get("prompt") if isinstance(raw.get("prompt"), str) else ""
    description = (
        raw.get("description") if isinstance(raw.get("description"), str) else ""
    )
    if _GENERATED_TEXT.search(f"{prompt}\n{description}"):
        return "ai_generated", "generation_text"
    upload_match = _UPLOAD_ID.fullmatch(legacy_asset_id)
    if upload_match is not None:
        expected_prefix = f"assets/images/{kind}/asset-{upload_match.group(1)}."
        if normalized_path.lower().startswith(expected_prefix.lower()) or Path(
            normalized_path
        ).name.lower().startswith(f"asset-{upload_match.group(1)}."):
            return "upload", "upload_asset_path"
    return "unknown", "insufficient_provenance"


def _validate_ai_candidate(
    db: Session, candidate: LegacyAssetCandidate, owner_user_id: str
) -> dict[str, object] | None:
    job_id = candidate.generation_job_id
    if not candidate.uses_generation_job or job_id is None:
        return None
    with db.no_autoflush:
        job = db.get(GenerationJob, job_id)
    if (
        job is None
        or job.user_id != owner_user_id
        or job.project_id != candidate.project_id
        or job.status != "billed"
        or not job.result_visible
    ):
        return {
            "asset_id": candidate.asset_id,
            "code": "legacy_ai_generation_job_invalid",
            "project_id": candidate.project_id,
            "storage_path": candidate.storage_path,
        }
    return None


def _compatible_existing_asset(
    existing: MediaAsset,
    candidate: LegacyAssetCandidate,
    owner_user_id: str,
) -> bool:
    return (
        existing.owner_user_id == owner_user_id
        and existing.origin_project_id == candidate.project_id
        and existing.kind == candidate.kind
        and existing.source_type == candidate.source_type
        and existing.storage_path == candidate.storage_path
        and existing.status != "deleted"
        and (
            candidate.source_type != "ai_generated"
            or (
                candidate.is_recovered_ai
                and existing.recovery_key == candidate.recovery_key
                and existing.generation_job_id is None
                and existing.output_index is None
            )
            or (
                candidate.uses_generation_job
                and existing.recovery_key is None
                and existing.generation_job_id == candidate.generation_job_id
                and existing.output_index == candidate.output_index
            )
        )
    )


def _same_project_metadata(existing: ProjectRecord, legacy: LegacyProject) -> bool:
    return (
        existing.title == legacy.title
        and existing.mode == legacy.mode
        and existing.project_type == legacy.project_type
        and _as_utc(existing.created_at) == legacy.created_at
        and _as_utc(existing.updated_at) == legacy.updated_at
    )


def _bounded_text(value: object, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise LegacyRecoveryError(
            "invalid_legacy_project", f"Legacy {label} is invalid"
        )
    return value


def _parse_datetime(value: object, project_id: str) -> datetime:
    if not isinstance(value, str):
        raise LegacyRecoveryError(
            "invalid_legacy_project",
            f"Legacy project {project_id} has an invalid timestamp",
        )
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise LegacyRecoveryError(
            "invalid_legacy_project",
            f"Legacy project {project_id} has an invalid timestamp",
        ) from exc
    return _as_utc(parsed)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _is_within(root: Path, candidate: Path) -> bool:
    try:
        return os.path.commonpath((str(root), str(candidate))) == str(root)
    except ValueError:
        return False


def _is_link_or_junction(path: Path) -> bool:
    return path.is_symlink() or bool(getattr(path, "is_junction", lambda: False)())


def _rejection(
    project_id: str,
    reason: str,
    **values: object,
) -> dict[str, object]:
    result = {"project_id": project_id, "reason": reason}
    result.update({key: value for key, value in values.items() if value is not None})
    return result


def _asset_report_sort_key(item: dict[str, object]) -> tuple[str, str, str]:
    return (
        str(item.get("project_id", "")),
        str(item.get("storage_path", "")),
        str(item.get("legacy_asset_id", "")),
    )


def _rejected_report_sort_key(
    item: dict[str, object],
) -> tuple[str, str, str, int, int]:
    return (
        str(item.get("project_id", "")),
        str(item.get("artifact_source", "")),
        str(item.get("legacy_asset_id", "")),
        int(item.get("index", -1)),
        int(item.get("path_index", -1)),
    )


def _blocker_sort_key(item: dict[str, object]) -> tuple[str, str, str]:
    return (
        str(item.get("project_id", "")),
        str(item.get("storage_path", "")),
        str(item.get("code", "")),
    )
