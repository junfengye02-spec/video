"""Add authoritative video generation unit execution ledger.

Revision ID: 018
Revises: 017
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "018"
down_revision: str | None = "017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_STATUSES = (
    "planned",
    "queued",
    "running",
    "waiting_provider",
    "complete",
    "failed",
    "stale",
)
_OPERATIONS = (
    "text_to_video",
    "image_to_video",
    "first_last_frame_to_video",
    "extend",
)


def _sql_values(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    op.create_table(
        "video_generation_units",
        sa.Column("project_id", sa.String(length=32), nullable=False),
        sa.Column("id", sa.String(length=128), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("plan_id", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("source_shot_ids_json", sa.JSON(), nullable=False),
        sa.Column("source_shot_versions_json", sa.JSON(), nullable=False),
        sa.Column("source_beat_ids_json", sa.JSON(), nullable=False),
        sa.Column("prompt_segments_json", sa.JSON(), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("model_id", sa.String(length=255), nullable=False),
        sa.Column("operation", sa.String(length=64), nullable=False),
        sa.Column("profile_revision", sa.String(length=128), nullable=False),
        sa.Column("profile_json", sa.JSON(), nullable=False),
        sa.Column("requested_duration_seconds", sa.Float(), nullable=True),
        sa.Column("source_duration_seconds", sa.Float(), nullable=True),
        sa.Column("timeline_duration_seconds", sa.Float(), nullable=True),
        sa.Column("output_asset_id", sa.String(length=128), nullable=True),
        sa.Column("output_path", sa.Text(), nullable=True),
        sa.Column("task_item_id", sa.String(length=32), nullable=True),
        sa.Column("billing_job_id", sa.String(length=32), nullable=True),
        sa.Column("replaces_unit_id", sa.String(length=128), nullable=True),
        sa.Column("legacy_source_shot_id", sa.String(length=128), nullable=True),
        sa.Column("execution_key", sa.String(length=64), nullable=False),
        sa.Column("diagnostics_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("revision >= 1", name="ck_video_generation_units_revision"),
        sa.CheckConstraint(
            f"status IN ({_sql_values(_STATUSES)})",
            name="ck_video_generation_units_status",
        ),
        sa.CheckConstraint(
            f"operation IN ({_sql_values(_OPERATIONS)})",
            name="ck_video_generation_units_operation",
        ),
        sa.CheckConstraint(
            "requested_duration_seconds IS NULL OR requested_duration_seconds > 0",
            name="ck_video_generation_units_requested_duration",
        ),
        sa.CheckConstraint(
            "source_duration_seconds IS NULL OR source_duration_seconds > 0",
            name="ck_video_generation_units_source_duration",
        ),
        sa.CheckConstraint(
            "timeline_duration_seconds IS NULL OR timeline_duration_seconds > 0",
            name="ck_video_generation_units_timeline_duration",
        ),
        sa.CheckConstraint(
            "length(plan_id) = 64", name="ck_video_generation_units_plan_id"
        ),
        sa.CheckConstraint(
            "length(execution_key) = 64",
            name="ck_video_generation_units_execution_key",
        ),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["task_item_id"], ["task_items.id"]),
        sa.ForeignKeyConstraint(["billing_job_id"], ["generation_jobs.id"]),
        sa.PrimaryKeyConstraint(
            "project_id", "id", "revision", name="pk_video_generation_units"
        ),
        sa.UniqueConstraint(
            "execution_key", name="uq_video_generation_units_execution_key"
        ),
        sa.UniqueConstraint(
            "task_item_id", name="uq_video_generation_units_task_item"
        ),
        sa.UniqueConstraint(
            "billing_job_id", name="uq_video_generation_units_billing_job"
        ),
    )
    op.create_index(
        "ix_video_generation_units_project_status",
        "video_generation_units",
        ["project_id", "status", "created_at", "id"],
    )
    op.create_index(
        "uq_video_generation_units_active_revision",
        "video_generation_units",
        ["project_id", "id"],
        unique=True,
        postgresql_where=sa.text("active = true"),
        sqlite_where=sa.text("active = 1"),
    )
    op.create_index(
        "uq_video_generation_units_legacy_shot",
        "video_generation_units",
        ["project_id", "legacy_source_shot_id"],
        unique=True,
        postgresql_where=sa.text("legacy_source_shot_id IS NOT NULL"),
        sqlite_where=sa.text("legacy_source_shot_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_video_generation_units_legacy_shot",
        table_name="video_generation_units",
    )
    op.drop_index(
        "uq_video_generation_units_active_revision",
        table_name="video_generation_units",
    )
    op.drop_index(
        "ix_video_generation_units_project_status",
        table_name="video_generation_units",
    )
    op.drop_table("video_generation_units")
