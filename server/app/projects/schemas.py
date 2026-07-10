from __future__ import annotations

import json
import re
import uuid
from pathlib import PurePosixPath, PureWindowsPath
from typing import Annotated, Any, Literal
from urllib.parse import unquote, urlparse

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from server.app.models import (
    CameraMovement,
    ContinuityPlan,
    ProjectType,
    ShotLanguage,
    ShotRevision,
    ShotSize,
)


MAX_IMPORT_ARTIFACT_BYTES = 1024 * 1024
LOCAL_MEDIA_PREFIX = "local://media/"
LOCAL_MEDIA_PATTERN = re.compile(r"local://media/[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
OpaqueArtifactId = Annotated[
    str,
    StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"),
]


class ProjectCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=255)
    project_type: ProjectType = "single_video"


class ProjectResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    mode: Literal["short_drama", "general_video"]
    project_type: ProjectType
    created_at: Any
    updated_at: Any


class ProjectListResponse(BaseModel):
    projects: list[ProjectResponse]


class ImportedCharacter(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: OpaqueArtifactId
    name: str = Field(min_length=1, max_length=255)
    role: str = Field(default="", max_length=2000)
    visual_lock: str = Field(default="", max_length=10000)
    voice: str | None = Field(default=None, max_length=2000)
    reference_images: list[str] = Field(default_factory=list, max_length=64)
    locked: bool = True

    @field_validator("reference_images")
    @classmethod
    def validate_reference_images(cls, values: list[str]) -> list[str]:
        return [_validate_browser_local_media(value) for value in values]


class ImportedAsset(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: OpaqueArtifactId
    kind: Literal["character", "scene", "prop"]
    label: str = Field(min_length=1, max_length=255)
    description: str = Field(default="", max_length=10000)
    prompt: str = Field(default="", max_length=10000)
    reference_images: list[str] = Field(default_factory=list, max_length=64)
    shot_ids: list[OpaqueArtifactId] = Field(default_factory=list, max_length=1000)
    version: int = Field(default=1, ge=1)

    @field_validator("reference_images")
    @classmethod
    def validate_reference_images(cls, values: list[str]) -> list[str]:
        return [_validate_browser_local_media(value) for value in values]


class ImportedSeriesBible(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=255)
    mode: Literal["short_drama", "general_video"] = "short_drama"
    style_lock: str = ""
    characters: list[ImportedCharacter] = Field(default_factory=list, max_length=500)
    assets: list[ImportedAsset] = Field(default_factory=list, max_length=2000)


class ImportedShot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: OpaqueArtifactId
    scene_id: OpaqueArtifactId
    index: int = Field(ge=0, le=100000)
    beat: str = Field(default="", max_length=10000)
    prompt: str = Field(default="", max_length=10000)
    characters: list[OpaqueArtifactId] = Field(default_factory=list, max_length=500)
    location: str | None = Field(default=None, max_length=2000)
    props: list[str] = Field(default_factory=list, max_length=500)
    shot_intent: str | None = Field(default=None, max_length=10000)
    shot_language: ShotLanguage | None = None
    status: Literal["draft", "ready", "generating", "complete", "failed"] = "draft"
    consistency_score: int = Field(default=100, ge=0, le=100)
    output_url: str | None = Field(default=None, max_length=4000)
    output_path: str | None = Field(default=None, max_length=4000)
    asset_ids: list[OpaqueArtifactId] = Field(default_factory=list, max_length=2000)
    version: int = Field(default=1, ge=1)
    history: list[ShotRevision] = Field(default_factory=list, max_length=1000)

    @field_validator("output_path")
    @classmethod
    def validate_output_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _validate_browser_local_media(value)

    @field_validator("output_url")
    @classmethod
    def validate_output_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if value.startswith(LOCAL_MEDIA_PREFIX):
            return _validate_browser_local_media(value)
        parsed = urlparse(value)
        if parsed.scheme != "https" or not parsed.netloc:
            raise ValueError("output_url must be an HTTPS URL or browser-local media reference")
        normalized_path = parsed.path
        for _ in range(10):
            decoded_path = unquote(normalized_path)
            if decoded_path == normalized_path:
                break
            normalized_path = decoded_path
        normalized_path = normalized_path.replace("\\", "/")
        if "/api/projects/" in normalized_path and "/media/" in normalized_path:
            raise ValueError("server project media references cannot be imported")
        return value


class ImportedStoryboard(BaseModel):
    model_config = ConfigDict(extra="forbid")

    shots: list[ImportedShot] = Field(default_factory=list, max_length=10000)


class ProjectImportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    legacy_project_id: str | None = Field(default=None, max_length=255)
    title: str = Field(min_length=1, max_length=255)
    project_type: ProjectType = "single_video"
    series_bible: ImportedSeriesBible
    storyboard: ImportedStoryboard
    continuity_plan: ContinuityPlan

    def artifact_payloads(self) -> dict[str, dict[str, Any]]:
        return {
            "series_bible.json": self.series_bible.model_dump(mode="json"),
            "episode_storyboard.json": self.storyboard.model_dump(mode="json"),
            "continuity_plan.json": self.continuity_plan.model_dump(mode="json"),
        }

    def artifact_size_bytes(self) -> int:
        return sum(
            len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            for value in self.artifact_payloads().values()
        )


def _validate_browser_local_media(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme == "local":
        if LOCAL_MEDIA_PATTERN.fullmatch(value) is None:
            raise ValueError("browser-local media reference is malformed")
        return value

    windows_path = PureWindowsPath(value)
    posix_path = PurePosixPath(value)
    if windows_path.is_absolute() or posix_path.is_absolute():
        raise ValueError("absolute media paths cannot be imported")
    if any(part in {".", ".."} for part in (*windows_path.parts, *posix_path.parts)):
        raise ValueError("traversal media paths cannot be imported")
    raise ValueError("server project media references cannot be imported")


def canonical_project_id(value: str) -> str:
    try:
        parsed = uuid.UUID(value)
    except (AttributeError, ValueError) as exc:
        raise ValueError("Project ID must be a canonical server UUID") from exc
    if value != parsed.hex or parsed.version != 4:
        raise ValueError("Project ID must be a canonical server UUID")
    return value
