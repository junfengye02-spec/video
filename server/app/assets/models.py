from __future__ import annotations

from sqlalchemy import (
    CheckConstraint,
    ForeignKey,
    Float,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from server.app.db.base import Base, TimestampMixin


class MediaAsset(TimestampMixin, Base):
    __tablename__ = "media_assets"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    owner_user_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("users.id"), nullable=False
    )
    origin_project_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    source_type: Mapped[str] = mapped_column(String(16), nullable=False)
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    prompt: Mapped[str] = mapped_column(Text, nullable=False, default="")
    model: Mapped[str | None] = mapped_column(String(255))
    generation_job_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("generation_jobs.id")
    )
    output_index: Mapped[int | None] = mapped_column(Integer)
    recovery_key: Mapped[str | None] = mapped_column(String(64))
    source_shot_id: Mapped[str | None] = mapped_column(String(128))
    source_video_version: Mapped[int | None] = mapped_column(Integer)
    source_media_sha256: Mapped[str | None] = mapped_column(String(64))
    sample_time_seconds: Mapped[float | None] = mapped_column(Float)
    storage_path: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="ready")

    __table_args__ = (
        CheckConstraint(
            "kind IN ('character', 'scene', 'prop')",
            name="ck_media_assets_kind",
        ),
        CheckConstraint(
            "source_type IN ('upload', 'ai_generated', 'video_frame')",
            name="ck_media_assets_source_type",
        ),
        CheckConstraint(
            "status IN ('ready', 'missing', 'stale', 'deleted')",
            name="ck_media_assets_status",
        ),
        CheckConstraint("length(label) > 0", name="ck_media_assets_label_nonempty"),
        CheckConstraint(
            "length(storage_path) > 0",
            name="ck_media_assets_storage_path_nonempty",
        ),
        CheckConstraint(
            "(source_type = 'upload' AND generation_job_id IS NULL AND "
            "output_index IS NULL AND recovery_key IS NULL AND "
            "source_shot_id IS NULL AND source_video_version IS NULL AND "
            "source_media_sha256 IS NULL AND sample_time_seconds IS NULL) OR "
            "(source_type = 'ai_generated' AND generation_job_id IS NOT NULL AND "
            "output_index IS NOT NULL AND output_index >= 0 AND model IS NOT NULL AND "
            "recovery_key IS NULL AND source_shot_id IS NULL AND "
            "source_video_version IS NULL AND source_media_sha256 IS NULL AND "
            "sample_time_seconds IS NULL) OR "
            "(source_type = 'ai_generated' AND generation_job_id IS NULL AND "
            "output_index IS NULL AND recovery_key IS NOT NULL AND "
            "source_shot_id IS NULL AND source_video_version IS NULL AND "
            "source_media_sha256 IS NULL AND sample_time_seconds IS NULL) OR "
            "(source_type = 'video_frame' AND generation_job_id IS NULL AND "
            "output_index IS NULL AND recovery_key IS NULL AND model IS NULL AND "
            "source_shot_id IS NOT NULL AND source_video_version IS NOT NULL AND "
            "source_video_version >= 1 AND length(source_media_sha256) = 64 AND "
            "sample_time_seconds IS NOT NULL AND sample_time_seconds >= 0)",
            name="ck_media_assets_source_shape",
        ),
        UniqueConstraint(
            "generation_job_id",
            "output_index",
            name="uq_media_assets_generation_output",
        ),
        UniqueConstraint(
            "owner_user_id",
            "recovery_key",
            name="uq_media_assets_owner_recovery_key",
        ),
        UniqueConstraint(
            "origin_project_id",
            "source_shot_id",
            "source_video_version",
            "source_media_sha256",
            name="uq_media_assets_video_frame_source",
        ),
        Index("ix_media_assets_owner_created", "owner_user_id", "created_at", "id"),
        Index(
            "ix_media_assets_origin_created",
            "origin_project_id",
            "created_at",
            "id",
        ),
    )


class MediaAssetProjectLink(TimestampMixin, Base):
    __tablename__ = "media_asset_project_links"

    asset_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("media_assets.id", ondelete="CASCADE"), primary_key=True
    )
    project_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    storage_path: Mapped[str] = mapped_column(Text, nullable=False)

    __table_args__ = (
        CheckConstraint(
            "length(storage_path) > 0",
            name="ck_media_asset_project_links_storage_path_nonempty",
        ),
        Index(
            "ix_media_asset_project_links_project_created",
            "project_id",
            "created_at",
            "asset_id",
        ),
    )
