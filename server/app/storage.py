from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from server.app.models import Project


class WorkbenchStore:
    def __init__(self, db_path: Path, projects_root: Path):
        self.db_path = Path(db_path)
        self.projects_root = Path(projects_root)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.projects_root.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def create_project(self, title: str, mode: str) -> Project:
        now = _utc_now()
        project = Project(
            id=uuid.uuid4().hex,
            title=title,
            mode=mode,
            created_at=now,
            updated_at=now,
        )
        self._ensure_project_dirs(project.id)
        with self._connect() as conn:
            conn.execute(
                """
                insert into projects (id, title, mode, created_at, updated_at)
                values (?, ?, ?, ?, ?)
                """,
                (project.id, project.title, project.mode, project.created_at, project.updated_at),
            )
        return project

    def get_project(self, project_id: str) -> Project | None:
        with self._connect() as conn:
            row = conn.execute(
                "select id, title, mode, created_at, updated_at from projects where id = ?",
                (project_id,),
            ).fetchone()
        if row is None:
            return None
        return Project(
            id=row["id"],
            title=row["title"],
            mode=row["mode"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def project_dir(self, project_id: str) -> Path:
        return self.projects_root / project_id

    def artifact_dir(self, project_id: str) -> Path:
        return self.project_dir(project_id) / "artifacts"

    def write_artifact(self, project_id: str, name: str, data: dict[str, Any]) -> Path:
        self._ensure_project_dirs(project_id)
        path = self.artifact_dir(project_id) / name
        path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return path

    def read_artifact(self, project_id: str, name: str) -> dict[str, Any] | None:
        path = self.artifact_dir(project_id) / name
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def write_asset_library(self, project_id: str, assets: list[dict[str, Any]]) -> Path:
        return self.write_artifact(project_id, "asset_library.json", {"assets": assets})

    def read_asset_library(self, project_id: str) -> dict[str, Any] | None:
        return self.read_artifact(project_id, "asset_library.json")

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                create table if not exists projects (
                    id text primary key,
                    title text not null,
                    mode text not null,
                    created_at text not null,
                    updated_at text not null
                )
                """
            )

    def _ensure_project_dirs(self, project_id: str) -> None:
        base = self.project_dir(project_id)
        for relative in (
            "artifacts",
            "assets/images",
            "assets/video",
            "assets/audio",
            "renders",
        ):
            (base / relative).mkdir(parents=True, exist_ok=True)


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()
