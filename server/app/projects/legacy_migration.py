from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy.orm import Session

from server.app.projects.models import ProjectRecord
from server.app.projects.schemas import canonical_project_id


REQUIRED_COLUMNS = {
    "id",
    "title",
    "mode",
    "project_type",
    "created_at",
    "updated_at",
}


@dataclass(frozen=True, slots=True)
class LegacyMigrationResult:
    imported_ids: tuple[str, ...] = ()
    skipped_ids: tuple[str, ...] = ()
    conflict_ids: tuple[str, ...] = ()


def migrate_legacy_projects(db: Session, sqlite_path: str | Path) -> LegacyMigrationResult:
    path = Path(sqlite_path).expanduser()
    if not path.is_file():
        raise ValueError("Legacy SQLite database does not exist")

    with sqlite3.connect(path) as legacy:
        legacy.row_factory = sqlite3.Row
        columns = {
            row["name"]
            for row in legacy.execute("PRAGMA table_info(projects)").fetchall()
        }
        if not REQUIRED_COLUMNS.issubset(columns):
            raise ValueError("Legacy SQLite projects table has an unsupported schema")
        rows = legacy.execute(
            """
            SELECT id, title, mode, project_type, created_at, updated_at
            FROM projects
            ORDER BY id
            """
        ).fetchall()

    imported: list[str] = []
    skipped: list[str] = []
    conflicts: list[str] = []
    try:
        for row in rows:
            incoming = _record_from_row(row)
            existing = db.get(ProjectRecord, incoming.id)
            if existing is None:
                db.add(incoming)
                imported.append(incoming.id)
            elif _same_legacy_metadata(existing, incoming):
                skipped.append(incoming.id)
            else:
                conflicts.append(incoming.id)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return LegacyMigrationResult(
        imported_ids=tuple(imported),
        skipped_ids=tuple(skipped),
        conflict_ids=tuple(conflicts),
    )


def _record_from_row(row: sqlite3.Row) -> ProjectRecord:
    project_id = _bounded_text(row["id"], "project id", 32)
    try:
        canonical_project_id(project_id)
    except ValueError as exc:
        raise ValueError("Legacy project id is not a canonical server UUID") from exc
    title = _bounded_text(row["title"], "project title", 255)
    mode = _bounded_text(row["mode"], "project mode", 32)
    project_type = _bounded_text(row["project_type"], "project type", 32)
    if mode not in {"short_drama", "general_video"}:
        raise ValueError(f"Legacy project {project_id} has an unsupported mode")
    if project_type not in {"single_video", "mini_series", "long_series"}:
        raise ValueError(f"Legacy project {project_id} has an unsupported project type")
    return ProjectRecord(
        id=project_id,
        owner_user_id=None,
        title=title,
        mode=mode,
        project_type=project_type,
        created_at=_parse_datetime(row["created_at"], project_id),
        updated_at=_parse_datetime(row["updated_at"], project_id),
    )


def _bounded_text(value: object, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ValueError(f"Legacy {label} is invalid")
    return value


def _parse_datetime(value: object, project_id: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"Legacy project {project_id} has an invalid timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"Legacy project {project_id} has an invalid timestamp") from exc
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _same_legacy_metadata(existing: ProjectRecord, incoming: ProjectRecord) -> bool:
    return (
        existing.owner_user_id is None
        and existing.title == incoming.title
        and existing.mode == incoming.mode
        and existing.project_type == incoming.project_type
        and _as_utc(existing.created_at) == _as_utc(incoming.created_at)
        and _as_utc(existing.updated_at) == _as_utc(incoming.updated_at)
    )


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)
