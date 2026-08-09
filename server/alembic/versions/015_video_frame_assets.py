"""Persist locally extracted video tail frames.

Revision ID: 015
Revises: 014
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "015"
down_revision: str | None = "014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_SOURCE_SHAPE = (
    "(source_type = 'upload' AND generation_job_id IS NULL AND output_index IS NULL AND "
    "recovery_key IS NULL AND source_shot_id IS NULL AND source_video_version IS NULL AND "
    "source_media_sha256 IS NULL AND sample_time_seconds IS NULL) OR "
    "(source_type = 'ai_generated' AND generation_job_id IS NOT NULL AND output_index IS NOT NULL AND "
    "output_index >= 0 AND model IS NOT NULL AND recovery_key IS NULL AND source_shot_id IS NULL AND "
    "source_video_version IS NULL AND source_media_sha256 IS NULL AND sample_time_seconds IS NULL) OR "
    "(source_type = 'ai_generated' AND generation_job_id IS NULL AND output_index IS NULL AND "
    "recovery_key IS NOT NULL AND source_shot_id IS NULL AND source_video_version IS NULL AND "
    "source_media_sha256 IS NULL AND sample_time_seconds IS NULL) OR "
    "(source_type = 'video_frame' AND generation_job_id IS NULL AND output_index IS NULL AND "
    "recovery_key IS NULL AND model IS NULL AND source_shot_id IS NOT NULL AND "
    "source_video_version IS NOT NULL AND source_video_version >= 1 AND "
    "length(source_media_sha256) = 64 AND sample_time_seconds IS NOT NULL AND sample_time_seconds >= 0)"
)


def upgrade() -> None:
    with op.batch_alter_table("media_assets") as batch_op:
        batch_op.add_column(sa.Column("source_shot_id", sa.String(length=128)))
        batch_op.add_column(sa.Column("source_video_version", sa.Integer()))
        batch_op.add_column(sa.Column("source_media_sha256", sa.String(length=64)))
        batch_op.add_column(sa.Column("sample_time_seconds", sa.Float()))
        batch_op.drop_constraint("ck_media_assets_source_type", type_="check")
        batch_op.create_check_constraint(
            "ck_media_assets_source_type",
            "source_type IN ('upload', 'ai_generated', 'video_frame')",
        )
        batch_op.drop_constraint("ck_media_assets_status", type_="check")
        batch_op.create_check_constraint(
            "ck_media_assets_status",
            "status IN ('ready', 'missing', 'stale', 'deleted')",
        )
        batch_op.drop_constraint("ck_media_assets_source_shape", type_="check")
        batch_op.create_check_constraint("ck_media_assets_source_shape", _SOURCE_SHAPE)
        batch_op.create_unique_constraint(
            "uq_media_assets_video_frame_source",
            [
                "origin_project_id",
                "source_shot_id",
                "source_video_version",
                "source_media_sha256",
            ],
        )


def downgrade() -> None:
    with op.batch_alter_table("media_assets") as batch_op:
        batch_op.drop_constraint("uq_media_assets_video_frame_source", type_="unique")
        batch_op.drop_constraint("ck_media_assets_source_shape", type_="check")
        batch_op.drop_constraint("ck_media_assets_status", type_="check")
        batch_op.drop_constraint("ck_media_assets_source_type", type_="check")
        batch_op.create_check_constraint(
            "ck_media_assets_source_type",
            "source_type IN ('upload', 'ai_generated')",
        )
        batch_op.create_check_constraint(
            "ck_media_assets_status",
            "status IN ('ready', 'missing', 'deleted')",
        )
        batch_op.create_check_constraint(
            "ck_media_assets_source_shape",
            "(source_type = 'upload' AND generation_job_id IS NULL AND output_index IS NULL AND recovery_key IS NULL) OR "
            "(source_type = 'ai_generated' AND generation_job_id IS NOT NULL AND output_index IS NOT NULL AND "
            "output_index >= 0 AND model IS NOT NULL AND recovery_key IS NULL) OR "
            "(source_type = 'ai_generated' AND generation_job_id IS NULL AND output_index IS NULL AND recovery_key IS NOT NULL)",
        )
        batch_op.drop_column("sample_time_seconds")
        batch_op.drop_column("source_media_sha256")
        batch_op.drop_column("source_video_version")
        batch_op.drop_column("source_shot_id")
