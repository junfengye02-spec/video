from __future__ import annotations

import json
import logging
import os
import re
import shutil
import tempfile
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path
from pathlib import PurePosixPath
from typing import Any

from server.app.models import Project
from server.app.projects.schemas import canonical_project_id


logger = logging.getLogger("server.app.project_recovery")
_OPERATION_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_OPERATION_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
_CLEANUP_GUARD_PATTERN = re.compile(r"^([0-9a-f]{32})\.cleanup\.json$")
_RECOVERY_STATES = {"active", "restoring", "recovery_failed", "recovered", "committed"}
_HEALTHY_RECOVERY_STATES = {"committed", "recovered"}
_CLEANUP_STATES = {"cleanup_pending", "cleanup_failed"}
_WINDOWS_FORBIDDEN_PATH_CHARACTERS = frozenset('<>:"|?*')
_WINDOWS_RESERVED_PATH_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
}


class ProjectRecoveryRequired(RuntimeError):
    pass


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

    def begin_project_mutation(
        self,
        project_id: str,
        *,
        operation: str,
        changed_paths: list[str],
        new_workspace: bool = False,
    ) -> ProjectMutationJournal:
        return ProjectMutationJournal(
            self,
            project_id,
            operation=operation,
            changed_paths=changed_paths,
            new_workspace=new_workspace,
        )

    def assert_project_available(self, project_id: str) -> None:
        canonical_id = canonical_project_id(project_id)
        recovery_root = self.projects_root.resolve() / ".recovery"
        if not recovery_root.exists():
            return
        if _is_link_or_junction(recovery_root) or not recovery_root.is_dir():
            raise ProjectRecoveryRequired("Project recovery state is unavailable")
        project_recovery = recovery_root / canonical_id
        if not project_recovery.exists():
            return
        if _is_link_or_junction(project_recovery) or not project_recovery.is_dir():
            raise ProjectRecoveryRequired("Project recovery state is unavailable")
        for operation_dir in project_recovery.iterdir():
            guard_match = _CLEANUP_GUARD_PATTERN.fullmatch(operation_dir.name)
            if guard_match is not None:
                guard = _read_marker(operation_dir)
                if not _valid_cleanup_guard(
                    guard,
                    canonical_id,
                    guard_match.group(1),
                ):
                    raise ProjectRecoveryRequired(
                        "Project recovery state is unavailable"
                    )
                raise ProjectRecoveryRequired("Project recovery cleanup is required")
            if _is_link_or_junction(operation_dir) or not operation_dir.is_dir():
                raise ProjectRecoveryRequired("Project recovery state is unavailable")
            if not _valid_recovery_operation_tree(operation_dir):
                raise ProjectRecoveryRequired("Project recovery state is unavailable")
            marker = _read_marker(operation_dir / "marker.json")
            if not _valid_marker(marker, canonical_id, operation_dir.name):
                raise ProjectRecoveryRequired("Project recovery state is unavailable")
            if marker.get("state") in _HEALTHY_RECOVERY_STATES:
                if not _valid_terminal_manifest(operation_dir, marker):
                    raise ProjectRecoveryRequired(
                        "Project recovery state is unavailable"
                    )
            else:
                raise ProjectRecoveryRequired("Project recovery is required")

    def artifact_dir(self, project_id: str) -> Path:
        return self.project_dir(project_id) / "artifacts"

    def write_artifact(self, project_id: str, name: str, data: dict[str, Any]) -> Path:
        self._ensure_project_dirs(project_id)
        path = self.artifact_dir(project_id) / name
        _atomic_write_json(path, data)
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


class ProjectMutationJournal:
    def __init__(
        self,
        store: WorkbenchStore,
        project_id: str,
        *,
        operation: str,
        changed_paths: list[str],
        new_workspace: bool,
    ):
        if _OPERATION_PATTERN.fullmatch(operation) is None:
            raise ValueError("Project mutation operation is invalid")
        self._store = store
        self._project_id = canonical_project_id(project_id)
        self.operation_id = uuid.uuid4().hex
        self.operation = operation
        self._root, self._workspace = store._validated_workspace_path(project_id)
        self._new_workspace = new_workspace
        self._closed = False
        if new_workspace and self._workspace.exists():
            raise ValueError("New project workspace already exists")
        if not new_workspace and not self._workspace.is_dir():
            raise ValueError("Project workspace path is invalid")

        self._operation_dir = self._create_operation_dir()
        self._entries: list[dict[str, Any]] = []
        self._created_dirs: set[str] = set()
        self._write_marker("active")
        try:
            for changed_path in sorted(set(changed_paths)):
                self._capture_path(changed_path)
            _atomic_write_json(
                self._operation_dir / "manifest.json",
                {
                    "project_id": self._project_id,
                    "operation_id": self.operation_id,
                    "operation": self.operation,
                    "new_workspace": self._new_workspace,
                    "entries": self._entries,
                    "created_dirs": sorted(self._created_dirs),
                },
            )
        except Exception:
            try:
                self._cleanup()
            except Exception:
                logger.error(
                    "project recovery journal initialization cleanup failed project_id=%s operation_id=%s",
                    self._project_id,
                    self.operation_id,
                )
            raise

    def restore(self) -> None:
        if self._closed:
            return
        try:
            self._store._validated_workspace_path(self._project_id)
            self._write_marker("restoring")
            if self._new_workspace:
                self._store.delete_project_workspace(self._project_id)
            else:
                for entry in self._entries:
                    self._restore_entry(entry)
                for relative_dir in sorted(
                    self._created_dirs,
                    key=lambda value: len(PurePosixPath(value).parts),
                    reverse=True,
                ):
                    directory = self._project_path(relative_dir)
                    if directory.exists() and not any(directory.iterdir()):
                        directory.rmdir()
            self._write_marker("recovered")
        except Exception:
            try:
                self._write_marker("recovery_failed")
            except Exception:
                pass
            logger.error(
                "project recovery failed project_id=%s operation_id=%s state=recovery_failed",
                self._project_id,
                self.operation_id,
            )
            raise
        self._closed = True
        self._cleanup()

    def complete(self) -> None:
        if self._closed:
            return
        self._write_marker("committed")
        self._closed = True
        self._cleanup()

    def _create_operation_dir(self) -> Path:
        recovery_root = self._root / ".recovery"
        _ensure_controlled_directory(recovery_root, self._root)
        project_recovery = recovery_root / self._project_id
        _ensure_controlled_directory(project_recovery, recovery_root)
        operation_dir = project_recovery / self.operation_id
        operation_dir.mkdir()
        self._guard_path = project_recovery / f"{self.operation_id}.cleanup.json"
        self._write_cleanup_guard("cleanup_pending")
        return operation_dir

    def _capture_path(self, relative_path: str) -> None:
        normalized = _normalize_relative_path(relative_path)
        destination = self._project_path(normalized)
        parent = destination.parent
        while parent != self._workspace:
            if not parent.exists():
                self._created_dirs.add(parent.relative_to(self._workspace).as_posix())
            elif _is_link_or_junction(parent) or not parent.is_dir():
                raise ValueError("Project workspace path is invalid")
            parent = parent.parent

        existed = destination.exists()
        if destination.is_symlink() or _is_link_or_junction(destination):
            raise ValueError("Project workspace path is invalid")
        if existed and not destination.is_file():
            raise ValueError("Project mutation paths must be files")
        self._entries.append({"path": normalized, "existed": existed})
        if existed:
            backup = self._backup_path(normalized, create_parents=True)
            shutil.copy2(destination, backup)

    def _restore_entry(self, entry: dict[str, Any]) -> None:
        destination = self._project_path(str(entry["path"]))
        if entry["existed"]:
            backup = self._backup_path(str(entry["path"]))
            if not backup.is_file():
                raise ValueError("Project recovery backup is unavailable")
            destination.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary_name = tempfile.mkstemp(
                prefix=f".{destination.name}.",
                suffix=".restore",
                dir=destination.parent,
            )
            temporary = Path(temporary_name)
            try:
                with os.fdopen(descriptor, "wb") as temporary_handle:
                    with backup.open("rb") as backup_handle:
                        shutil.copyfileobj(backup_handle, temporary_handle)
                    temporary_handle.flush()
                    os.fsync(temporary_handle.fileno())
                if _is_link_or_junction(temporary) or not temporary.is_file():
                    raise ValueError("Project workspace path is invalid")
                os.replace(temporary, destination)
            finally:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass
        elif destination.exists():
            if _is_link_or_junction(destination) or not destination.is_file():
                raise ValueError("Project workspace path is invalid")
            destination.unlink()

    def _project_path(self, relative_path: str) -> Path:
        normalized = _normalize_relative_path(relative_path)
        candidate = self._workspace.joinpath(*PurePosixPath(normalized).parts)
        if self._workspace not in candidate.parents:
            raise ValueError("Project workspace path is invalid")
        parent = candidate.parent
        while parent != self._workspace:
            if parent.exists() and (_is_link_or_junction(parent) or not parent.is_dir()):
                raise ValueError("Project workspace path is invalid")
            parent = parent.parent
        if _is_link_or_junction(candidate):
            raise ValueError("Project workspace path is invalid")
        return candidate

    def _backup_path(self, relative_path: str, *, create_parents: bool = False) -> Path:
        self._validate_operation_dir()
        normalized = _normalize_relative_path(relative_path)
        backup = self._operation_dir / "backups" / Path(
            *PurePosixPath(normalized).parts
        )
        if self._operation_dir not in backup.parents:
            raise ValueError("Project recovery path is invalid")
        current = self._operation_dir
        for part in backup.relative_to(self._operation_dir).parts[:-1]:
            current = current / part
            if not current.exists() and create_parents:
                current.mkdir()
            if _is_link_or_junction(current) or not current.is_dir():
                raise ValueError("Project recovery path is invalid")
        if _is_link_or_junction(backup):
            raise ValueError("Project recovery path is invalid")
        return backup

    def _validate_operation_dir(self) -> None:
        recovery_root = self._root / ".recovery"
        project_recovery = recovery_root / self._project_id
        if (
            recovery_root.parent != self._root
            or _is_link_or_junction(recovery_root)
            or not recovery_root.is_dir()
            or project_recovery.parent != recovery_root
            or _is_link_or_junction(project_recovery)
            or not project_recovery.is_dir()
            or self._operation_dir.parent != project_recovery
            or _is_link_or_junction(self._operation_dir)
            or not self._operation_dir.is_dir()
        ):
            raise ValueError("Project recovery path is invalid")

    def _write_marker(self, state: str) -> None:
        self._validate_operation_dir()
        _atomic_write_json(
            self._operation_dir / "marker.json",
            {
                "project_id": self._project_id,
                "operation_id": self.operation_id,
                "operation": self.operation,
                "state": state,
            },
        )

    def _write_cleanup_guard(self, state: str) -> None:
        if state not in _CLEANUP_STATES:
            raise ValueError("Project recovery cleanup state is invalid")
        project_recovery = self._root / ".recovery" / self._project_id
        if (
            self._guard_path.parent != project_recovery
            or _is_link_or_junction(project_recovery)
            or not project_recovery.is_dir()
            or _is_link_or_junction(self._guard_path)
        ):
            raise ValueError("Project recovery path is invalid")
        _atomic_write_json(
            self._guard_path,
            {
                "project_id": self._project_id,
                "operation_id": self.operation_id,
                "operation": self.operation,
                "state": state,
            },
        )

    def _record_cleanup_failure(self) -> None:
        try:
            self._write_cleanup_guard("cleanup_failed")
        except Exception:
            pass
        logger.error(
            "project recovery cleanup failed project_id=%s operation_id=%s state=cleanup_failed",
            self._project_id,
            self.operation_id,
        )

    def _remove_cleanup_guard(self, project_recovery: Path) -> None:
        if (
            self._guard_path.parent != project_recovery
            or _is_link_or_junction(self._guard_path)
            or not self._guard_path.is_file()
        ):
            raise ValueError("Project recovery path is invalid")
        self._guard_path.unlink()

    def _cleanup(self) -> None:
        project_recovery = self._guard_path.parent
        recovery_root = project_recovery.parent
        try:
            self._validate_operation_dir()
            _remove_controlled_tree(self._operation_dir, project_recovery)
            self._remove_cleanup_guard(project_recovery)
        except Exception:
            self._record_cleanup_failure()
            raise
        try:
            project_recovery.rmdir()
        except OSError:
            return
        try:
            recovery_root.rmdir()
        except OSError:
            pass


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


def _normalize_relative_path(value: str) -> str:
    candidate = PurePosixPath(value.replace("\\", "/"))
    if candidate.is_absolute() or not candidate.parts:
        raise ValueError("Project mutation path is invalid")
    if any(part in {"", ".", ".."} for part in candidate.parts):
        raise ValueError("Project mutation path is invalid")
    return candidate.as_posix()


def _ensure_controlled_directory(path: Path, parent: Path) -> None:
    if path.parent != parent:
        raise ValueError("Project recovery path is invalid")
    path.mkdir(exist_ok=True)
    if _is_link_or_junction(path) or not path.is_dir():
        raise ValueError("Project recovery path is invalid")


def _remove_controlled_tree(path: Path, parent: Path) -> None:
    if path.parent != parent or _is_link_or_junction(path):
        raise ValueError("Project recovery path is invalid")
    _ensure_tree_has_no_links(path)
    shutil.rmtree(path)


def _atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _read_marker(path: Path) -> dict[str, Any]:
    if _is_link_or_junction(path) or not path.is_file():
        return {"state": "invalid"}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {"state": "invalid"}
    return value if isinstance(value, dict) else {"state": "invalid"}


def _valid_recovery_operation_tree(operation_dir: Path) -> bool:
    try:
        children = {child.name: child for child in operation_dir.iterdir()}
        if set(children) - {"marker.json", "manifest.json", "backups"}:
            return False
        for name in ("marker.json", "manifest.json"):
            child = children.get(name)
            if child is None or _is_link_or_junction(child) or not child.is_file():
                return False
        backups = children.get("backups")
        if backups is not None and (
            _is_link_or_junction(backups) or not backups.is_dir()
        ):
            return False
        _ensure_tree_has_no_links(operation_dir)
    except (OSError, ValueError):
        return False
    return True


def _valid_marker(marker: dict[str, Any], project_id: str, operation_id: str) -> bool:
    if set(marker) != {"project_id", "operation_id", "operation", "state"}:
        return False
    return (
        marker.get("project_id") == project_id
        and marker.get("operation_id") == operation_id
        and _OPERATION_ID_PATTERN.fullmatch(operation_id) is not None
        and isinstance(marker.get("operation"), str)
        and _OPERATION_PATTERN.fullmatch(marker["operation"]) is not None
        and marker.get("state") in _RECOVERY_STATES
    )


def _valid_cleanup_guard(
    guard: dict[str, Any],
    project_id: str,
    operation_id: str,
) -> bool:
    if set(guard) != {"project_id", "operation_id", "operation", "state"}:
        return False
    return (
        guard.get("project_id") == project_id
        and guard.get("operation_id") == operation_id
        and _OPERATION_ID_PATTERN.fullmatch(operation_id) is not None
        and isinstance(guard.get("operation"), str)
        and _OPERATION_PATTERN.fullmatch(guard["operation"]) is not None
        and guard.get("state") in _CLEANUP_STATES
    )


def _valid_terminal_manifest(operation_dir: Path, marker: dict[str, Any]) -> bool:
    manifest_path = operation_dir / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    if not isinstance(manifest, dict) or set(manifest) != {
        "project_id",
        "operation_id",
        "operation",
        "new_workspace",
        "entries",
        "created_dirs",
    }:
        return False
    if (
        manifest.get("project_id") != marker.get("project_id")
        or manifest.get("operation_id") != marker.get("operation_id")
        or manifest.get("operation_id") != operation_dir.name
        or manifest.get("operation") != marker.get("operation")
        or not isinstance(manifest.get("new_workspace"), bool)
        or not isinstance(manifest.get("entries"), list)
        or not isinstance(manifest.get("created_dirs"), list)
    ):
        return False

    files: list[tuple[PurePosixPath, bool]] = []
    for entry in manifest["entries"]:
        if (
            not isinstance(entry, dict)
            or set(entry) != {"path", "existed"}
            or not isinstance(entry.get("existed"), bool)
        ):
            return False
        path = _canonical_manifest_path(entry.get("path"))
        if path is None:
            return False
        files.append((path, entry["existed"]))

    directories: list[PurePosixPath] = []
    for value in manifest["created_dirs"]:
        path = _canonical_manifest_path(value)
        if path is None:
            return False
        directories.append(path)

    file_paths = [path for path, _existed in files]
    file_keys = [_manifest_path_comparison_key(path) for path in file_paths]
    directory_keys = [_manifest_path_comparison_key(path) for path in directories]
    if len(set(file_keys)) != len(file_keys) or len(set(directory_keys)) != len(
        directory_keys
    ):
        return False
    for index, file_key in enumerate(file_keys):
        for other_key in file_keys[index + 1 :]:
            if _is_comparison_key_ancestor(
                file_key, other_key
            ) or _is_comparison_key_ancestor(other_key, file_key):
                return False
        for directory_key in directory_keys:
            if file_key == directory_key or _is_comparison_key_ancestor(
                file_key, directory_key
            ):
                return False

    expected_files = {path for path, existed in files if existed}
    expected_directories = {
        PurePosixPath(*path.parts[:depth])
        for path in expected_files
        for depth in range(1, len(path.parts))
    }
    backups = operation_dir / "backups"
    if not expected_files:
        return not backups.exists() and not _is_link_or_junction(backups)
    if _is_link_or_junction(backups) or not backups.is_dir():
        return False

    actual_files: set[PurePosixPath] = set()
    actual_directories: set[PurePosixPath] = set()
    pending = [backups]
    try:
        while pending:
            directory = pending.pop()
            with os.scandir(directory) as entries:
                for entry in entries:
                    path = Path(entry.path)
                    if entry.is_symlink() or _is_link_or_junction(path):
                        return False
                    relative = PurePosixPath(*path.relative_to(backups).parts)
                    if entry.is_dir(follow_symlinks=False):
                        actual_directories.add(relative)
                        pending.append(path)
                    elif entry.is_file(follow_symlinks=False):
                        if path.stat(follow_symlinks=False).st_nlink != 1:
                            return False
                        actual_files.add(relative)
                    else:
                        return False
    except OSError:
        return False
    return (
        actual_files == expected_files
        and actual_directories == expected_directories
    )


def _canonical_manifest_path(value: Any) -> PurePosixPath | None:
    if (
        not isinstance(value, str)
        or not value
        or value.startswith(("/", "\\"))
        or "\\" in value
        or any(
            character in _WINDOWS_FORBIDDEN_PATH_CHARACTERS
            or unicodedata.category(character) == "Cc"
            for character in value
        )
    ):
        return None
    components = value.split("/")
    for component in components:
        device_name = component.split(".", 1)[0].rstrip(" .").upper()
        if (
            component in {"", ".", ".."}
            or component.endswith((".", " "))
            or device_name in _WINDOWS_RESERVED_PATH_NAMES
        ):
            return None
    try:
        normalized = _normalize_relative_path(value)
    except ValueError:
        return None
    if normalized != value:
        return None
    return PurePosixPath(normalized)


def _manifest_path_comparison_key(path: PurePosixPath) -> tuple[str, ...]:
    return tuple(component.casefold() for component in path.parts)


def _is_comparison_key_ancestor(
    parent: tuple[str, ...], child: tuple[str, ...]
) -> bool:
    return len(parent) < len(child) and child[: len(parent)] == parent


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
