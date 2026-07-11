from __future__ import annotations

import json
import os
import shutil
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

    def delete_project_workspace(self, project_id: str) -> None:
        root, workspace = self._validated_workspace_path(project_id)
        if workspace.exists():
            _remove_tree(workspace, root)

    def checkpoint_project_workspace(self, project_id: str) -> ProjectWorkspaceCheckpoint:
        return ProjectWorkspaceCheckpoint(self, project_id)

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

    def _validated_workspace_path(self, project_id: str) -> tuple[Path, Path]:
        canonical_id = canonical_project_id(project_id)
        root = self.projects_root.resolve()
        workspace = root / canonical_id
        if workspace.parent != root or _is_link_or_junction(workspace):
            raise ValueError("Project workspace path is invalid")
        return root, workspace


class ProjectWorkspaceCheckpoint:
    def __init__(self, store: WorkbenchStore, project_id: str):
        self._store = store
        self._project_id = canonical_project_id(project_id)
        self._root, self._workspace = store._validated_workspace_path(project_id)
        self._existed = self._workspace.exists()
        self._backup: Path | None = None
        self._closed = False
        if self._existed:
            _ensure_tree_has_no_links(self._workspace)
            self._backup = self._root / (
                f".openmontage-rollback-{self._project_id}-{uuid.uuid4().hex}"
            )
            try:
                shutil.copytree(self._workspace, self._backup, symlinks=True)
                _ensure_tree_has_no_links(self._backup)
            except Exception:
                if self._backup.exists() and not _is_link_or_junction(self._backup):
                    try:
                        _remove_tree(self._backup, self._root)
                    except Exception:
                        pass
                raise

    def restore(self) -> None:
        if self._closed:
            return
        if not self._existed:
            self._store.delete_project_workspace(self._project_id)
            self._closed = True
            return

        self._store._validated_workspace_path(self._project_id)
        if self._backup is None or not self._backup.is_dir():
            raise ValueError("Project workspace checkpoint is unavailable")
        _ensure_tree_has_no_links(self._backup)
        quarantine = self._root / (
            f".openmontage-failed-{self._project_id}-{uuid.uuid4().hex}"
        )
        self._workspace.replace(quarantine)
        try:
            self._backup.replace(self._workspace)
        except Exception:
            quarantine.replace(self._workspace)
            raise
        self._backup = None
        self._closed = True
        try:
            _remove_tree(quarantine, self._root)
        except Exception:
            pass

    def discard(self) -> None:
        if self._closed:
            return
        backup = self._backup
        self._backup = None
        self._closed = True
        if backup is not None and backup.exists():
            _remove_tree(backup, self._root)


def _is_link_or_junction(path: Path) -> bool:
    is_junction = getattr(path, "is_junction", lambda: False)
    return path.is_symlink() or is_junction()


def _ensure_tree_has_no_links(root: Path) -> None:
    if _is_link_or_junction(root):
        raise ValueError("Project workspace path is invalid")
    pending = [root]
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                path = Path(entry.path)
                if entry.is_symlink() or _is_link_or_junction(path):
                    raise ValueError("Project workspace path is invalid")
                if entry.is_dir(follow_symlinks=False):
                    pending.append(path)


def _remove_tree(path: Path, root: Path) -> None:
    if path.parent != root or _is_link_or_junction(path):
        raise ValueError("Project workspace path is invalid")
    _ensure_tree_has_no_links(path)
    shutil.rmtree(path)


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()
