from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict


AssetKind = Literal["character", "scene", "prop"]
AssetSourceType = Literal["upload", "ai_generated", "video_frame"]
AssetStatus = Literal["ready", "missing", "stale", "deleted"]


class VideoFrameProvenance(BaseModel):
    model_config = ConfigDict(extra="forbid")

    shot_id: str
    video_version: int
    media_sha256: str
    sample_time_seconds: float


class MediaAssetResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    origin_project_id: str
    kind: AssetKind
    source_type: AssetSourceType
    label: str
    description: str
    prompt: str
    model: str | None
    generation_job_id: str | None
    provenance: VideoFrameProvenance | None = None
    media_url: str
    status: AssetStatus
    created_at: datetime


class MediaAssetListResponse(BaseModel):
    assets: list[MediaAssetResponse]
    next_cursor: str | None


class ImageGenerationAssetsResponse(BaseModel):
    job_id: str
    assets: list[MediaAssetResponse]
