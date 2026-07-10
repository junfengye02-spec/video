from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from server.app.models import Project
from server.app.projects.schemas import canonical_project_id


class WorkbenchStore:
    def __init__(self, projects_root: Path, db_path: Path | None = None):
        self.projects_root = Path(projects_root)
        self.projects_root.mkdir(parents=True, exist_ok=True)

    def create_project(self, title: str, mode: str, project_type: str = "single_video") -> Project:
        now = _utc_now()
        project = Project(
            id=uuid.uuid4().hex,
            title=title,
            mode=mode,
            project_type=project_type,
            created_at=now,
            updated_at=now,
        )
        self._ensure_project_dirs(project.id)
        return project

    def project_dir(self, project_id: str) -> Path:
        return self.projects_root / canonical_project_id(project_id)

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

    def read_asset_library(self, project_id: str) -> list[dict[str, Any]]:
        artifact = self.read_artifact(project_id, "asset_library.json")
        if not artifact:
            return []
        assets = artifact.get("assets", [])
        return assets if isinstance(assets, list) else []

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
