from __future__ import annotations

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    PrimaryKeyConstraint,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from server.app.db.base import Base, TimestampMixin


GENERATION_UNIT_STATUSES = (
    "planned",
    "queued",
    "running",
    "waiting_provider",
    "complete",
    "failed",
    "stale",
)
GENERATION_UNIT_OPERATIONS = (
    "text_to_video",
    "image_to_video",
    "first_last_frame_to_video",
    "extend",
)


def _sql_values(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


class VideoGenerationUnit(TimestampMixin, Base):
    __tablename__ = "video_generation_units"

    project_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    id: Mapped[str] = mapped_column(String(128), nullable=False)
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    plan_id: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="planned")
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    source_shot_ids_json: Mapped[list] = mapped_column(JSON, nullable=False)
    source_shot_versions_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    source_beat_ids_json: Mapped[list] = mapped_column(JSON, nullable=False)
    source_segment_ids_json: Mapped[list] = mapped_column(
        JSON, nullable=False, default=list
    )
    prompt_segments_json: Mapped[list] = mapped_column(
        JSON, nullable=False, default=list
    )
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    model_id: Mapped[str] = mapped_column(String(255), nullable=False)
    operation: Mapped[str] = mapped_column(String(64), nullable=False)
    profile_revision: Mapped[str] = mapped_column(String(128), nullable=False)
    profile_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    requested_duration_seconds: Mapped[float | None] = mapped_column(Float)
    source_duration_seconds: Mapped[float | None] = mapped_column(Float)
    timeline_duration_seconds: Mapped[float | None] = mapped_column(Float)
    output_asset_id: Mapped[str | None] = mapped_column(String(128))
    output_path: Mapped[str | None] = mapped_column(Text)
    task_item_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("task_items.id")
    )
    billing_job_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("generation_jobs.id")
    )
    replaces_unit_id: Mapped[str | None] = mapped_column(String(128))
    legacy_source_shot_id: Mapped[str | None] = mapped_column(String(128))
    execution_key: Mapped[str] = mapped_column(String(64), nullable=False)
    diagnostics_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)

    __table_args__ = (
        PrimaryKeyConstraint(
            "project_id", "id", "revision", name="pk_video_generation_units"
        ),
        UniqueConstraint(
            "execution_key", name="uq_video_generation_units_execution_key"
        ),
        UniqueConstraint("task_item_id", name="uq_video_generation_units_task_item"),
        UniqueConstraint(
            "billing_job_id", name="uq_video_generation_units_billing_job"
        ),
        CheckConstraint("revision >= 1", name="ck_video_generation_units_revision"),
        CheckConstraint(
            f"status IN ({_sql_values(GENERATION_UNIT_STATUSES)})",
            name="ck_video_generation_units_status",
        ),
        CheckConstraint(
            f"operation IN ({_sql_values(GENERATION_UNIT_OPERATIONS)})",
            name="ck_video_generation_units_operation",
        ),
        CheckConstraint(
            "requested_duration_seconds IS NULL OR requested_duration_seconds > 0",
            name="ck_video_generation_units_requested_duration",
        ),
        CheckConstraint(
            "source_duration_seconds IS NULL OR source_duration_seconds > 0",
            name="ck_video_generation_units_source_duration",
        ),
        CheckConstraint(
            "timeline_duration_seconds IS NULL OR timeline_duration_seconds > 0",
            name="ck_video_generation_units_timeline_duration",
        ),
        CheckConstraint(
            "length(plan_id) = 64", name="ck_video_generation_units_plan_id"
        ),
        CheckConstraint(
            "length(execution_key) = 64",
            name="ck_video_generation_units_execution_key",
        ),
        Index(
            "ix_video_generation_units_project_status",
            "project_id",
            "status",
            "created_at",
            "id",
        ),
        Index(
            "uq_video_generation_units_active_revision",
            "project_id",
            "id",
            unique=True,
            postgresql_where=text("active = true"),
            sqlite_where=text("active = 1"),
        ),
        Index(
            "uq_video_generation_units_legacy_shot",
            "project_id",
            "legacy_source_shot_id",
            unique=True,
            postgresql_where=text("legacy_source_shot_id IS NOT NULL"),
            sqlite_where=text("legacy_source_shot_id IS NOT NULL"),
        ),
    )
