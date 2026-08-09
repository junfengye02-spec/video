from __future__ import annotations

import base64
import binascii
import re
import uuid
from datetime import timezone
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import and_, exists, or_, select
from sqlalchemy.orm import Session

from server.app.assets.models import MediaAsset, MediaAssetProjectLink
from server.app.assets.schemas import MediaAssetResponse
from server.app.billing.models import GenerationJob
from server.app.media_files import (
    media_content_type,
    media_download_url,
    relative_project_path,
    safe_project_media_file,
)
from server.app.projects.models import ProjectRecord
from server.app.storage import WorkbenchStore


_ASSET_ID = re.compile(r"^[0-9a-f]{32}$")


class MediaAssetRepository:
    def __init__(self, db: Session, media_store: WorkbenchStore):
        self.db = db
        self.media_store = media_store

    def create_upload(
        self,
        *,
        asset_id: str,
        owner_user_id: str,
        origin_project_id: str,
        kind: str,
        label: str,
        description: str,
        prompt: str,
        storage_path: str | Path,
    ) -> MediaAsset:
        relative, content_type = self._validated_storage(
            origin_project_id, storage_path
        )
        asset = MediaAsset(
            id=asset_id,
            owner_user_id=owner_user_id,
            origin_project_id=origin_project_id,
            kind=kind,
            source_type="upload",
            label=label,
            description=description,
            prompt=prompt,
            storage_path=relative,
            content_type=content_type,
            status="ready",
        )
        self.db.add(asset)
        self.db.flush()
        self.ensure_project_link(
            asset_id=asset.id,
            project_id=origin_project_id,
            storage_path=relative,
        )
        return asset

    def create_generated(
        self,
        *,
        owner_user_id: str,
        origin_project_id: str,
        kind: str,
        label: str,
        description: str,
        prompt: str,
        model: str,
        generation_job_id: str,
        storage_paths: list[str] | tuple[str, ...],
    ) -> list[MediaAsset]:
        assets: list[MediaAsset] = []
        for output_index, storage_path in enumerate(storage_paths):
            relative, content_type = self._validated_storage(
                origin_project_id, storage_path
            )
            asset = MediaAsset(
                id=uuid.uuid4().hex,
                owner_user_id=owner_user_id,
                origin_project_id=origin_project_id,
                kind=kind,
                source_type="ai_generated",
                label=label,
                description=description,
                prompt=prompt,
                model=model,
                generation_job_id=generation_job_id,
                output_index=output_index,
                storage_path=relative,
                content_type=content_type,
                status="ready",
            )
            self.db.add(asset)
            assets.append(asset)
        self.db.flush()
        for asset in assets:
            self.ensure_project_link(
                asset_id=asset.id,
                project_id=origin_project_id,
                storage_path=asset.storage_path,
            )
        return assets

    def create_video_frame(
        self,
        *,
        owner_user_id: str,
        origin_project_id: str,
        shot_id: str,
        video_version: int,
        media_sha256: str,
        sample_time_seconds: float,
        storage_path: str | Path,
    ) -> MediaAsset:
        if (
            not shot_id
            or video_version < 1
            or len(media_sha256) != 64
            or any(character not in "0123456789abcdef" for character in media_sha256)
            or sample_time_seconds < 0
        ):
            raise ValueError("Video frame provenance is invalid")
        relative, content_type = self._validated_storage(
            origin_project_id, storage_path
        )
        existing = self.db.scalar(
            select(MediaAsset).where(
                MediaAsset.owner_user_id == owner_user_id,
                MediaAsset.origin_project_id == origin_project_id,
                MediaAsset.source_type == "video_frame",
                MediaAsset.source_shot_id == shot_id,
                MediaAsset.source_video_version == video_version,
                MediaAsset.source_media_sha256 == media_sha256,
            )
        )
        if existing is not None:
            if existing.storage_path != relative:
                raise ValueError("Video frame source is already bound to another file")
            existing.status = "ready"
            self.ensure_project_link(
                asset_id=existing.id,
                project_id=origin_project_id,
                storage_path=relative,
            )
            return existing

        asset = MediaAsset(
            id=uuid.uuid4().hex,
            owner_user_id=owner_user_id,
            origin_project_id=origin_project_id,
            kind="scene",
            source_type="video_frame",
            label=f"{shot_id} tail frame",
            description="Locally extracted tail frame for shot continuity.",
            prompt="",
            storage_path=relative,
            content_type=content_type,
            status="ready",
            source_shot_id=shot_id,
            source_video_version=video_version,
            source_media_sha256=media_sha256,
            sample_time_seconds=sample_time_seconds,
        )
        self.db.add(asset)
        self.db.flush()
        self.ensure_project_link(
            asset_id=asset.id,
            project_id=origin_project_id,
            storage_path=relative,
        )
        return asset

    def mark_video_frames_stale(
        self,
        *,
        origin_project_id: str,
        shot_id: str,
        current_video_version: int,
        current_media_sha256: str,
    ) -> int:
        frames = list(
            self.db.scalars(
                select(MediaAsset).where(
                    MediaAsset.origin_project_id == origin_project_id,
                    MediaAsset.source_type == "video_frame",
                    MediaAsset.source_shot_id == shot_id,
                    MediaAsset.status != "deleted",
                )
            )
        )
        changed = 0
        for frame in frames:
            is_current = (
                frame.source_video_version == current_video_version
                and frame.source_media_sha256 == current_media_sha256
            )
            if not is_current and frame.status != "stale":
                frame.status = "stale"
                changed += 1
        self.db.flush()
        return changed

    def mark_all_video_frames_stale(
        self,
        *,
        origin_project_id: str,
        shot_id: str,
    ) -> int:
        frames = list(
            self.db.scalars(
                select(MediaAsset).where(
                    MediaAsset.origin_project_id == origin_project_id,
                    MediaAsset.source_type == "video_frame",
                    MediaAsset.source_shot_id == shot_id,
                    MediaAsset.status.notin_({"stale", "deleted"}),
                )
            )
        )
        for frame in frames:
            frame.status = "stale"
        self.db.flush()
        return len(frames)

    def ensure_project_link(
        self,
        *,
        asset_id: str,
        project_id: str,
        storage_path: str,
    ) -> MediaAssetProjectLink:
        link = self.db.get(MediaAssetProjectLink, (asset_id, project_id))
        if link is None:
            link = MediaAssetProjectLink(
                asset_id=asset_id,
                project_id=project_id,
                storage_path=storage_path,
            )
            self.db.add(link)
        elif link.storage_path != storage_path:
            link.storage_path = storage_path
        self.db.flush()
        return link

    def rehome_linked_assets_before_project_delete(
        self,
        *,
        project_id: str,
        owner_user_id: str,
    ) -> None:
        assets = list(
            self.db.scalars(
                select(MediaAsset).where(
                    MediaAsset.origin_project_id == project_id,
                    MediaAsset.owner_user_id == owner_user_id,
                )
            )
        )
        for asset in assets:
            replacement = self.db.scalar(
                select(MediaAssetProjectLink)
                .join(
                    ProjectRecord,
                    ProjectRecord.id == MediaAssetProjectLink.project_id,
                )
                .where(
                    MediaAssetProjectLink.asset_id == asset.id,
                    MediaAssetProjectLink.project_id != project_id,
                    ProjectRecord.owner_user_id == owner_user_id,
                )
                .order_by(
                    MediaAssetProjectLink.created_at.asc(),
                    MediaAssetProjectLink.project_id.asc(),
                )
                .limit(1)
            )
            if replacement is None:
                continue
            asset.origin_project_id = replacement.project_id
            asset.storage_path = replacement.storage_path
        self.db.flush()

    def get_owned(self, asset_id: str, owner_user_id: str) -> MediaAsset | None:
        if _ASSET_ID.fullmatch(asset_id) is None:
            return None
        return self.db.scalar(
            select(MediaAsset).where(
                MediaAsset.id == asset_id,
                MediaAsset.owner_user_id == owner_user_id,
                MediaAsset.status != "deleted",
                _visible_asset_condition(),
            )
        )

    def get_generation_assets(
        self,
        *,
        generation_job_id: str,
        owner_user_id: str,
        origin_project_id: str,
    ) -> list[MediaAsset]:
        return list(
            self.db.scalars(
                select(MediaAsset)
                .where(
                    MediaAsset.generation_job_id == generation_job_id,
                    MediaAsset.owner_user_id == owner_user_id,
                    MediaAsset.origin_project_id == origin_project_id,
                    MediaAsset.status != "deleted",
                    _visible_asset_condition(),
                )
                .order_by(MediaAsset.output_index.asc(), MediaAsset.id.asc())
            )
        )

    def list_owned(
        self,
        *,
        owner_user_id: str,
        origin_project_id: str | None,
        kind: str | None,
        source_type: str | None,
        cursor: str | None,
        limit: int,
    ) -> tuple[list[MediaAsset], str | None]:
        conditions = [
            MediaAsset.owner_user_id == owner_user_id,
            MediaAsset.status != "deleted",
            _visible_asset_condition(),
        ]
        if origin_project_id is not None:
            conditions.append(
                exists().where(
                    MediaAssetProjectLink.asset_id == MediaAsset.id,
                    MediaAssetProjectLink.project_id == origin_project_id,
                )
            )
        if kind is not None:
            conditions.append(MediaAsset.kind == kind)
        if source_type is not None:
            conditions.append(MediaAsset.source_type == source_type)
        if cursor is not None:
            cursor_id = _decode_cursor(cursor)
            cursor_asset = self.db.scalar(
                select(MediaAsset).where(
                    MediaAsset.id == cursor_id,
                    MediaAsset.owner_user_id == owner_user_id,
                )
            )
            if cursor_asset is None:
                raise HTTPException(status_code=400, detail="Invalid asset cursor")
            conditions.append(
                or_(
                    MediaAsset.created_at < cursor_asset.created_at,
                    and_(
                        MediaAsset.created_at == cursor_asset.created_at,
                        MediaAsset.id < cursor_asset.id,
                    ),
                )
            )
        rows = list(
            self.db.scalars(
                select(MediaAsset)
                .where(*conditions)
                .order_by(MediaAsset.created_at.desc(), MediaAsset.id.desc())
                .limit(limit + 1)
            )
        )
        has_more = len(rows) > limit
        assets = rows[:limit]
        next_cursor = _encode_cursor(assets[-1].id) if has_more and assets else None
        return assets, next_cursor

    def serialize(self, asset: MediaAsset) -> MediaAssetResponse:
        project = self.db.scalar(
            select(ProjectRecord).where(
                ProjectRecord.id == asset.origin_project_id,
                ProjectRecord.owner_user_id == asset.owner_user_id,
            )
        )
        if project is None:
            raise RuntimeError("Media asset origin ownership is invalid")
        if asset.source_type == "ai_generated" and asset.recovery_key is None:
            visible_job = self.db.scalar(
                select(GenerationJob.id).where(
                    GenerationJob.id == asset.generation_job_id,
                    GenerationJob.user_id == asset.owner_user_id,
                    GenerationJob.project_id == asset.origin_project_id,
                    GenerationJob.status == "billed",
                    GenerationJob.result_visible.is_(True),
                )
            )
            if visible_job is None:
                raise RuntimeError("Media asset generation job is not visible")
        project_dir = self.media_store.project_dir(asset.origin_project_id)
        path = safe_project_media_file(project_dir, asset.storage_path)
        status = asset.status if path.is_file() else "missing"
        created_at = asset.created_at
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        else:
            created_at = created_at.astimezone(timezone.utc)
        return MediaAssetResponse(
            id=asset.id,
            origin_project_id=asset.origin_project_id,
            kind=asset.kind,
            source_type=asset.source_type,
            label=asset.label,
            description=asset.description,
            prompt=asset.prompt,
            model=asset.model,
            generation_job_id=asset.generation_job_id,
            provenance=(
                {
                    "shot_id": asset.source_shot_id,
                    "video_version": asset.source_video_version,
                    "media_sha256": asset.source_media_sha256,
                    "sample_time_seconds": asset.sample_time_seconds,
                }
                if asset.source_type == "video_frame"
                else None
            ),
            media_url=media_download_url(asset.origin_project_id, asset.storage_path),
            status=status,
            created_at=created_at,
        )

    def _validated_storage(
        self, origin_project_id: str, storage_path: str | Path
    ) -> tuple[str, str]:
        project_dir = self.media_store.project_dir(origin_project_id)
        relative = relative_project_path(project_dir, storage_path)
        path = safe_project_media_file(project_dir, relative)
        if not path.is_file():
            raise ValueError("Media asset file does not exist")
        return relative, media_content_type(path)


def compatible_asset_record(
    asset: MediaAsset,
    *,
    project_id: str,
    storage_path: str,
) -> dict[str, object]:
    record: dict[str, object] = {
        "id": asset.id,
        "kind": asset.kind,
        "label": asset.label,
        "description": asset.description,
        "prompt": asset.prompt,
        "reference_images": [storage_path],
        "media_urls": [media_download_url(project_id, storage_path)],
        "shot_ids": [],
        "version": 1,
        "origin_project_id": project_id,
        "source_type": asset.source_type,
        "model": asset.model,
        "generation_job_id": asset.generation_job_id,
        "media_url": media_download_url(project_id, storage_path),
        "status": asset.status,
    }
    if asset.source_type == "video_frame":
        record["provenance"] = {
            "shot_id": asset.source_shot_id,
            "video_version": asset.source_video_version,
            "media_sha256": asset.source_media_sha256,
            "sample_time_seconds": asset.sample_time_seconds,
        }
    return record


def _visible_asset_condition():
    return or_(
        MediaAsset.source_type == "upload",
        MediaAsset.source_type == "video_frame",
        and_(
            MediaAsset.source_type == "ai_generated",
            MediaAsset.recovery_key.is_not(None),
        ),
        and_(
            MediaAsset.source_type == "ai_generated",
            MediaAsset.recovery_key.is_(None),
            exists().where(
                GenerationJob.id == MediaAsset.generation_job_id,
                GenerationJob.user_id == MediaAsset.owner_user_id,
                GenerationJob.project_id == MediaAsset.origin_project_id,
                GenerationJob.status == "billed",
                GenerationJob.result_visible.is_(True),
            ),
        ),
    )


def _encode_cursor(asset_id: str) -> str:
    return (
        base64.urlsafe_b64encode(asset_id.encode("ascii")).decode("ascii").rstrip("=")
    )


def _decode_cursor(cursor: str) -> str:
    if not cursor or len(cursor) > 128:
        raise HTTPException(status_code=400, detail="Invalid asset cursor")
    try:
        padding = "=" * (-len(cursor) % 4)
        asset_id = base64.b64decode(
            cursor + padding,
            altchars=b"-_",
            validate=True,
        ).decode("ascii")
    except (binascii.Error, UnicodeDecodeError):
        raise HTTPException(status_code=400, detail="Invalid asset cursor") from None
    if _ASSET_ID.fullmatch(asset_id) is None:
        raise HTTPException(status_code=400, detail="Invalid asset cursor")
    return asset_id
