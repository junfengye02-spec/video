from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import stat
import tempfile
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from pathlib import PurePosixPath
from typing import Any, Callable

from server.app.billing.service import StagedArtifact
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
_HIDDEN_VIDEO_LOCATOR = re.compile(
    r"^workbench-hidden-video:([0-9a-f]{32}):([0-9a-f]{32})$"
)
_HIDDEN_SYNC_LOCATOR = re.compile(
    r"^workbench-hidden-sync:([0-9a-f]{32}):([0-9a-f]{32})$"
)
_PROVIDER_REFERENCE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$")
_SHOT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


@dataclass(frozen=True, slots=True)
class HiddenVideoArtifact:
    locator: str
    sha256: str
    source_reference: str
    capability: str
    project_id: str
    operation: str
    hidden: bool
    path: Path


@dataclass(frozen=True, slots=True)
class VideoGenerationIntent:
    project_id: str
    job_id: str
    shot_id: str
    shot_version: int


class HiddenVideoDestination:
    def __init__(
        self,
        store: "WorkbenchStore",
        project_id: str,
        operation: str,
        *,
        artifact_id: str | None = None,
    ):
        if (
            type(operation) is not str
            or not operation
            or len(operation) > 191
            or any(ord(character) < 32 for character in operation)
        ):
            raise ValueError("Video operation is invalid")
        self._store = store
        self.project_id = canonical_project_id(project_id)
        self.operation = operation
        self._directory = store._hidden_video_dir(self.project_id)
        self._artifact_id = artifact_id or uuid.uuid4().hex
        if _OPERATION_ID_PATTERN.fullmatch(self._artifact_id) is None:
            raise ValueError("Hidden video artifact identifier is invalid")
        self._staging_directory = self._directory / f".{self._artifact_id}.partial"
        self._artifact_directory = self._directory / self._artifact_id
        if self._artifact_directory.exists() or _is_link_or_junction(
            self._artifact_directory
        ):
            raise ValueError("Hidden video artifact already exists")
        try:
            self._staging_directory.mkdir()
        except FileExistsError:
            raise ValueError("Hidden video artifact already exists") from None
        if _is_link_or_junction(self._staging_directory):
            raise ValueError("Hidden video staging directory is invalid")
        self.temporary_path = self._staging_directory / "video.mp4"
        self._metadata_path = self._staging_directory / "metadata.json"
        self._committed = False
        with self.temporary_path.open("xb"):
            pass

    def __enter__(self) -> "HiddenVideoDestination":
        return self

    def commit(self, *, sha256: str, source_reference: str) -> HiddenVideoArtifact:
        if self._committed:
            raise ValueError("Hidden video destination is already committed")
        if (
            type(sha256) is not str
            or len(sha256) != 64
            or any(character not in "0123456789abcdef" for character in sha256)
        ):
            raise ValueError("Video hash is invalid")
        if (
            type(source_reference) is not str
            or _PROVIDER_REFERENCE.fullmatch(source_reference) is None
        ):
            raise ValueError("Video source reference is invalid")
        _require_regular_unlinked_file(self.temporary_path, "staged video")
        actual_sha256 = _sha256_file(self.temporary_path)
        if actual_sha256 != sha256:
            raise ValueError("Video hash does not match staged content")

        locator = f"workbench-hidden-video:{self.project_id}:{self._artifact_id}"
        final_path = self._artifact_directory / "video.mp4"
        metadata = {
            "version": 1,
            "locator": locator,
            "project_id": self.project_id,
            "operation": self.operation,
            "source_reference": source_reference,
            "capability": "video",
            "hidden": True,
            "sha256": actual_sha256,
            "filename": "video.mp4",
        }
        _write_json_durable(self._metadata_path, metadata)
        _require_regular_unlinked_file(
            self._metadata_path, "hidden video metadata"
        )
        _fsync_directory(self._staging_directory)
        _publish_directory_without_replacement(
            self._staging_directory, self._artifact_directory
        )
        _fsync_directory(self._directory)
        self._committed = True
        return HiddenVideoArtifact(
            locator=locator,
            sha256=actual_sha256,
            source_reference=source_reference,
            capability="video",
            project_id=self.project_id,
            operation=self.operation,
            hidden=True,
            path=final_path,
        )

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        try:
            if self._staging_directory.exists():
                if (
                    self._staging_directory.parent != self._directory
                    or _is_link_or_junction(self._staging_directory)
                    or not self._staging_directory.is_dir()
                ):
                    raise ValueError("Hidden video staging directory is invalid")
                shutil.rmtree(self._staging_directory)
        except (OSError, ValueError):
            logger.warning("Could not remove hidden video partial", exc_info=True)


class ProjectRecoveryRequired(RuntimeError):
    pass


class WorkbenchStore:
    def __init__(self, projects_root: Path, db_path: Path | None = None):
        self.projects_root = Path(projects_root)
        self.projects_root.mkdir(parents=True, exist_ok=True)
        self._recover_interrupted_mutations()

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

    def _recover_interrupted_mutations(self) -> None:
        root = self.projects_root.resolve()
        recovery_root = root / ".recovery"
        if not recovery_root.exists():
            return
        if _is_link_or_junction(recovery_root) or not recovery_root.is_dir():
            logger.error("project recovery root is invalid")
            return
        for project_recovery in list(recovery_root.iterdir()):
            try:
                project_id = canonical_project_id(project_recovery.name)
            except ValueError:
                logger.error("project recovery directory is invalid")
                continue
            if (
                project_id != project_recovery.name
                or _is_link_or_junction(project_recovery)
                or not project_recovery.is_dir()
            ):
                logger.error("project recovery directory is invalid project_id=%s", project_id)
                continue
            operation_dirs = [
                path
                for path in project_recovery.iterdir()
                if path.is_dir() and not _is_link_or_junction(path)
            ]
            for operation_dir in operation_dirs:
                try:
                    journal, state = ProjectMutationJournal._load_recovery(
                        self, project_id, operation_dir
                    )
                    if state in {"active", "restoring"}:
                        journal.restore()
                    elif state in _HEALTHY_RECOVERY_STATES:
                        journal._cleanup()
                except Exception:
                    logger.error(
                        "project startup recovery failed project_id=%s operation_id=%s",
                        project_id,
                        operation_dir.name,
                    )
            try:
                project_recovery.rmdir()
            except OSError:
                pass
        try:
            recovery_root.rmdir()
        except OSError:
            pass

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

    def hidden_video_destination(
        self,
        project_id: str,
        operation: str,
        *,
        artifact_id: str | None = None,
    ) -> HiddenVideoDestination:
        return HiddenVideoDestination(
            self, project_id, operation, artifact_id=artifact_id
        )

    def deterministic_video_artifact(
        self, project_id: str, job_id: str
    ) -> StagedArtifact | None:
        canonical_id = canonical_project_id(project_id)
        if _OPERATION_ID_PATTERN.fullmatch(job_id) is None:
            raise ValueError("Video billing job identifier is invalid")
        locator = f"workbench-hidden-video:{canonical_id}:{job_id}"
        try:
            root = self._hidden_video_dir(canonical_id, create=False)
        except ValueError:
            return None
        directory = root / job_id
        if not directory.exists():
            return None
        return self.inspect_staged_artifact(locator)

    def inspect_staged_artifact(self, locator: str) -> StagedArtifact:
        sync_match = _HIDDEN_SYNC_LOCATOR.fullmatch(locator) if type(locator) is str else None
        if sync_match is not None:
            return self._inspect_hidden_sync_artifact(locator, *sync_match.groups())
        match = _HIDDEN_VIDEO_LOCATOR.fullmatch(locator) if type(locator) is str else None
        if match is None:
            raise ValueError("Hidden video locator is invalid")
        project_id, artifact_id = match.groups()
        directory = self._hidden_video_dir(project_id, create=False)
        artifact_directory = directory / artifact_id
        if (
            artifact_directory.parent != directory
            or _is_link_or_junction(artifact_directory)
            or not artifact_directory.is_dir()
        ):
            raise ValueError("Hidden video artifact directory is invalid")
        try:
            children = {path.name: path for path in artifact_directory.iterdir()}
        except OSError:
            raise ValueError("Hidden video artifact directory is invalid") from None
        if set(children) != {"metadata.json", "video.mp4"}:
            raise ValueError("Hidden video artifact directory is invalid")
        metadata_path = children["metadata.json"]
        video_path = children["video.mp4"]
        _require_regular_unlinked_file(metadata_path, "hidden video metadata")
        _require_regular_unlinked_file(video_path, "hidden video")
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise ValueError("Hidden video metadata is invalid") from None
        expected = {
            "version": 1,
            "locator": locator,
            "project_id": project_id,
            "operation": metadata.get("operation"),
            "source_reference": metadata.get("source_reference"),
            "capability": "video",
            "hidden": True,
            "sha256": metadata.get("sha256"),
            "filename": video_path.name,
        }
        if metadata != expected:
            raise ValueError("Hidden video metadata is invalid")
        source_reference = metadata["source_reference"]
        operation = metadata["operation"]
        digest = metadata["sha256"]
        if (
            type(source_reference) is not str
            or _PROVIDER_REFERENCE.fullmatch(source_reference) is None
            or type(operation) is not str
            or not operation
            or len(operation) > 191
            or any(ord(character) < 32 for character in operation)
            or type(digest) is not str
            or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)
            or _sha256_file(video_path) != digest
        ):
            raise ValueError("Hidden video artifact is invalid")
        return StagedArtifact(
            locator=locator,
            sha256=digest,
            source_reference=source_reference,
            capability="video",
        )

    def stage_sync_result(
        self,
        *,
        project_id: str,
        job_id: str,
        operation: str,
        capability: str,
        source_reference: str,
        content: bytes,
    ) -> StagedArtifact:
        canonical_id = canonical_project_id(project_id)
        if _OPERATION_ID_PATTERN.fullmatch(job_id) is None:
            raise ValueError("Billing job identifier is invalid")
        if capability not in {"text", "image"}:
            raise ValueError("Synchronous capability is invalid")
        if _PROVIDER_REFERENCE.fullmatch(source_reference) is None:
            raise ValueError("Provider reference is invalid")
        if type(content) is not bytes or not content:
            raise ValueError("Synchronous result is empty")
        if type(operation) is not str or not operation or len(operation) > 191:
            raise ValueError("Synchronous operation is invalid")

        root = self._hidden_sync_dir(canonical_id)
        directory = root / job_id
        locator = f"workbench-hidden-sync:{canonical_id}:{job_id}"
        digest = hashlib.sha256(content).hexdigest()
        if directory.exists():
            artifact = self._inspect_hidden_sync_artifact(
                locator, canonical_id, job_id
            )
            if (
                artifact.source_reference != source_reference
                or artifact.capability != capability
                or artifact.sha256 != digest
            ):
                raise ValueError("Synchronous result conflicts with staged artifact")
            return artifact
        directory.mkdir()
        if _is_link_or_junction(directory):
            raise ValueError("Synchronous result directory is invalid")
        try:
            _atomic_write_bytes(directory / "response.bin", content)
            _write_json_durable(
                directory / "metadata.json",
                {
                    "version": 1,
                    "locator": locator,
                    "project_id": canonical_id,
                    "job_id": job_id,
                    "operation": operation,
                    "source_reference": source_reference,
                    "capability": capability,
                    "hidden": True,
                    "sha256": digest,
                    "filename": "response.bin",
                },
            )
            _fsync_directory(directory)
            _fsync_directory(root)
        except BaseException:
            shutil.rmtree(directory, ignore_errors=True)
            raise
        return StagedArtifact(locator, digest, source_reference, capability)

    def write_generated_image(
        self,
        *,
        project_id: str,
        job_id: str,
        index: int,
        suffix: str,
        content: bytes,
    ) -> str:
        canonical_id = canonical_project_id(project_id)
        if _OPERATION_ID_PATTERN.fullmatch(job_id) is None or type(index) is not int or index < 0:
            raise ValueError("Generated image identity is invalid")
        if suffix not in {".png", ".jpg", ".webp"} or not content:
            raise ValueError("Generated image is invalid")
        relative = f"assets/images/generated/{job_id}-{index}{suffix}"
        _atomic_write_bytes(self.project_dir(canonical_id) / relative, content)
        return relative

    def publish_staged_video(
        self,
        locator: str,
        destination: Path,
        *,
        progress_callback: Callable[[], None] | None = None,
        commit_guard: Callable[[], None] | None = None,
    ) -> None:
        artifact = self.inspect_staged_artifact(locator)
        match = _HIDDEN_VIDEO_LOCATOR.fullmatch(locator)
        if match is None or artifact.capability != "video":
            raise ValueError("Staged video locator is invalid")
        project_id, artifact_id = match.groups()
        source = self._hidden_video_dir(project_id, create=False) / artifact_id / "video.mp4"
        _require_regular_unlinked_file(source, "staged video")
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(
            f".{destination.name}.{uuid.uuid4().hex}.publish"
        )
        try:
            with source.open("rb") as reader, temporary.open("xb") as writer:
                while chunk := reader.read(1024 * 1024):
                    writer.write(chunk)
                    if progress_callback is not None:
                        progress_callback()
                writer.flush()
                os.fsync(writer.fileno())
            if progress_callback is not None:
                progress_callback()
            if commit_guard is not None:
                commit_guard()
            os.replace(temporary, destination)
            _fsync_directory(destination.parent)
        finally:
            temporary.unlink(missing_ok=True)

    def record_video_generation_intent(
        self,
        *,
        project_id: str,
        job_id: str,
        shot_id: str,
        shot_version: int,
    ) -> VideoGenerationIntent:
        canonical_id = canonical_project_id(project_id)
        if _OPERATION_ID_PATTERN.fullmatch(job_id) is None:
            raise ValueError("Video billing job identifier is invalid")
        if _SHOT_ID_PATTERN.fullmatch(shot_id) is None:
            raise ValueError("Video shot identifier is invalid")
        if type(shot_version) is not int or shot_version < 1:
            raise ValueError("Video shot version is invalid")
        root = self._video_intent_dir(canonical_id)
        path = root / f"{job_id}.json"
        payload = {
            "project_id": canonical_id,
            "job_id": job_id,
            "shot_id": shot_id,
            "shot_version": shot_version,
        }
        if path.exists():
            existing = self.read_video_generation_intent(canonical_id, job_id)
            if existing != VideoGenerationIntent(
                canonical_id, job_id, shot_id, shot_version
            ):
                raise ValueError("Video generation intent conflicts with existing binding")
            return existing
        _write_json_durable(path, payload)
        _fsync_directory(root)
        return VideoGenerationIntent(canonical_id, job_id, shot_id, shot_version)

    def read_video_generation_intent(
        self, project_id: str, job_id: str
    ) -> VideoGenerationIntent:
        canonical_id = canonical_project_id(project_id)
        if _OPERATION_ID_PATTERN.fullmatch(job_id) is None:
            raise ValueError("Video billing job identifier is invalid")
        path = self._video_intent_dir(canonical_id, create=False) / f"{job_id}.json"
        _require_regular_unlinked_file(path, "video generation intent")
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise ValueError("Video generation intent is invalid") from None
        expected = {
            "project_id": canonical_id,
            "job_id": job_id,
            "shot_id": payload.get("shot_id"),
            "shot_version": payload.get("shot_version"),
        }
        if (
            payload != expected
            or _SHOT_ID_PATTERN.fullmatch(payload.get("shot_id") or "") is None
            or type(payload.get("shot_version")) is not int
            or payload["shot_version"] < 1
        ):
            raise ValueError("Video generation intent is invalid")
        return VideoGenerationIntent(
            canonical_id,
            job_id,
            payload["shot_id"],
            payload["shot_version"],
        )

    def delete_video_generation_intent(self, project_id: str, job_id: str) -> None:
        canonical_id = canonical_project_id(project_id)
        if _OPERATION_ID_PATTERN.fullmatch(job_id) is None:
            raise ValueError("Video billing job identifier is invalid")
        try:
            root = self._video_intent_dir(canonical_id, create=False)
        except ValueError:
            return
        path = root / f"{job_id}.json"
        if path.exists():
            _require_regular_unlinked_file(path, "video generation intent")
            path.unlink()
            _fsync_directory(root)

    def _video_intent_dir(self, project_id: str, *, create: bool = True) -> Path:
        root = self._hidden_sync_dir(project_id, create=create) / "video-intents"
        if create:
            root.mkdir(exist_ok=True)
        if _is_link_or_junction(root) or not root.is_dir():
            raise ValueError("Video generation intent directory is invalid")
        return root

    def _hidden_sync_dir(self, project_id: str, *, create: bool = True) -> Path:
        workspace = self.project_dir(project_id)
        root = workspace / ".billing-results"
        if create:
            workspace.mkdir(parents=True, exist_ok=True)
            root.mkdir(exist_ok=True)
        elif not workspace.is_dir() or not root.is_dir():
            raise ValueError("Synchronous result directory is unavailable")
        if _is_link_or_junction(workspace) or _is_link_or_junction(root):
            raise ValueError("Synchronous result directory is invalid")
        return root

    def _inspect_hidden_sync_artifact(
        self, locator: str, project_id: str, job_id: str
    ) -> StagedArtifact:
        directory = self._hidden_sync_dir(project_id, create=False) / job_id
        if _is_link_or_junction(directory) or not directory.is_dir():
            raise ValueError("Synchronous result directory is invalid")
        metadata_path = directory / "metadata.json"
        result_path = directory / "response.bin"
        _require_regular_unlinked_file(metadata_path, "synchronous result metadata")
        _require_regular_unlinked_file(result_path, "synchronous result")
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise ValueError("Synchronous result metadata is invalid") from None
        expected = {
            "version": 1,
            "locator": locator,
            "project_id": project_id,
            "job_id": job_id,
            "operation": metadata.get("operation"),
            "source_reference": metadata.get("source_reference"),
            "capability": metadata.get("capability"),
            "hidden": True,
            "sha256": metadata.get("sha256"),
            "filename": "response.bin",
        }
        if metadata != expected:
            raise ValueError("Synchronous result metadata is invalid")
        digest = hashlib.sha256(result_path.read_bytes()).hexdigest()
        if (
            metadata["capability"] not in {"text", "image"}
            or _PROVIDER_REFERENCE.fullmatch(metadata["source_reference"] or "") is None
            or metadata["sha256"] != digest
        ):
            raise ValueError("Synchronous result is invalid")
        return StagedArtifact(
            locator, digest, metadata["source_reference"], metadata["capability"]
        )

    def exists(self, locator: str, *, sha256: str | None = None) -> bool:
        try:
            artifact = self.inspect_staged_artifact(locator)
        except (OSError, ValueError):
            return False
        return sha256 is None or artifact.sha256 == sha256

    def _hidden_video_dir(self, project_id: str, *, create: bool = True) -> Path:
        canonical_id = canonical_project_id(project_id)
        if _is_link_or_junction(self.projects_root):
            raise ValueError("Projects root cannot be a link")
        root = self.projects_root.resolve()
        workspace = root / canonical_id
        directories = (
            workspace,
            workspace / "assets",
            workspace / "assets" / "video",
            workspace / "assets" / "video" / ".hidden",
        )
        for directory in directories:
            if directory.exists():
                if _is_link_or_junction(directory) or not directory.is_dir():
                    raise ValueError("Hidden video directory is invalid")
            elif create:
                directory.mkdir()
            else:
                raise ValueError("Hidden video directory is unavailable")
        return directories[-1]

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

    @classmethod
    def _load_recovery(
        cls,
        store: WorkbenchStore,
        project_id: str,
        operation_dir: Path,
    ) -> tuple["ProjectMutationJournal", str]:
        canonical_id = canonical_project_id(project_id)
        if (
            operation_dir.parent
            != store.projects_root.resolve() / ".recovery" / canonical_id
            or _is_link_or_junction(operation_dir)
            or not operation_dir.is_dir()
            or not _valid_recovery_operation_tree(operation_dir)
        ):
            raise ValueError("Project recovery path is invalid")
        marker = _read_marker(operation_dir / "marker.json")
        if (
            not _valid_marker(marker, canonical_id, operation_dir.name)
            or not _valid_terminal_manifest(operation_dir, marker)
        ):
            raise ValueError("Project recovery state is invalid")
        guard_path = operation_dir.parent / f"{operation_dir.name}.cleanup.json"
        guard = _read_marker(guard_path)
        if not _valid_cleanup_guard(guard, canonical_id, operation_dir.name):
            raise ValueError("Project recovery cleanup state is invalid")
        try:
            manifest = json.loads(
                (operation_dir / "manifest.json").read_text(encoding="utf-8")
            )
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise ValueError("Project recovery state is invalid") from None

        journal = cls.__new__(cls)
        journal._store = store
        journal._project_id = canonical_id
        journal.operation_id = operation_dir.name
        journal.operation = marker["operation"]
        journal._root, journal._workspace = store._validated_workspace_path(
            canonical_id
        )
        journal._new_workspace = manifest["new_workspace"]
        journal._closed = False
        journal._operation_dir = operation_dir
        journal._guard_path = guard_path
        journal._entries = manifest["entries"]
        journal._created_dirs = set(manifest["created_dirs"])
        return journal, marker["state"]

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
        if existed:
            destination_stat = destination.stat(follow_symlinks=False)
            if not stat.S_ISREG(destination_stat.st_mode) or destination_stat.st_nlink != 1:
                raise ValueError("Project workspace path is invalid")
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


def _require_regular_unlinked_file(path: Path, label: str) -> None:
    if _is_link_or_junction(path):
        raise ValueError(f"{label} cannot be a link")
    try:
        details = path.stat(follow_symlinks=False)
    except OSError:
        raise ValueError(f"{label} is unavailable") from None
    if not stat.S_ISREG(details.st_mode):
        raise ValueError(f"{label} must be a regular file")
    if details.st_nlink != 1:
        raise ValueError(f"{label} cannot be a hard link")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_json_durable(path: Path, data: dict[str, Any]) -> None:
    encoded = json.dumps(data, sort_keys=True, separators=(",", ":")).encode("utf-8")
    with path.open("xb") as output:
        output.write(encoded)
        output.flush()
        os.fsync(output.fileno())


def _publish_directory_without_replacement(
    source: Path, destination: Path
) -> None:
    if destination.exists() or _is_link_or_junction(destination):
        raise ValueError("Hidden video artifact already exists")
    try:
        os.rename(source, destination)
    except OSError as exc:
        if destination.exists() or _is_link_or_junction(destination):
            raise ValueError("Hidden video artifact already exists") from None
        raise OSError("Hidden video artifact could not be published") from exc


def _fsync_directory(directory: Path) -> None:
    try:
        descriptor = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


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


def _atomic_write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
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
