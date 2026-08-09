"""Add durable user media assets.

Revision ID: 013
Revises: 012
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "013"
down_revision: str | None = "012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "media_assets",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("owner_user_id", sa.String(length=32), nullable=False),
        sa.Column("origin_project_id", sa.String(length=32), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("source_type", sa.String(length=16), nullable=False),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("model", sa.String(length=255), nullable=True),
        sa.Column("generation_job_id", sa.String(length=32), nullable=True),
        sa.Column("output_index", sa.Integer(), nullable=True),
        sa.Column("storage_path", sa.Text(), nullable=False),
        sa.Column("content_type", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "kind IN ('character', 'scene', 'prop')",
            name="ck_media_assets_kind",
        ),
        sa.CheckConstraint(
            "source_type IN ('upload', 'ai_generated')",
            name="ck_media_assets_source_type",
        ),
        sa.CheckConstraint(
            "status IN ('ready', 'missing', 'deleted')",
            name="ck_media_assets_status",
        ),
        sa.CheckConstraint(
            "length(label) > 0", name="ck_media_assets_label_nonempty"
        ),
        sa.CheckConstraint(
            "length(storage_path) > 0",
            name="ck_media_assets_storage_path_nonempty",
        ),
        sa.CheckConstraint(
            "(source_type = 'upload' AND generation_job_id IS NULL AND "
            "output_index IS NULL) OR "
            "(source_type = 'ai_generated' AND generation_job_id IS NOT NULL AND "
            "output_index IS NOT NULL AND output_index >= 0 AND model IS NOT NULL)",
            name="ck_media_assets_source_shape",
        ),
        sa.ForeignKeyConstraint(["generation_job_id"], ["generation_jobs.id"]),
        sa.ForeignKeyConstraint(
            ["origin_project_id"], ["projects.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "generation_job_id",
            "output_index",
            name="uq_media_assets_generation_output",
        ),
    )
    op.create_index(
        "ix_media_assets_origin_created",
        "media_assets",
        ["origin_project_id", "created_at", "id"],
        unique=False,
    )
    op.create_index(
        "ix_media_assets_owner_created",
        "media_assets",
        ["owner_user_id", "created_at", "id"],
        unique=False,
    )
    op.create_table(
        "media_asset_project_links",
        sa.Column("asset_id", sa.String(length=32), nullable=False),
        sa.Column("project_id", sa.String(length=32), nullable=False),
        sa.Column("storage_path", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "length(storage_path) > 0",
            name="ck_media_asset_project_links_storage_path_nonempty",
        ),
        sa.ForeignKeyConstraint(
            ["asset_id"], ["media_assets.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("asset_id", "project_id"),
    )
    op.create_index(
        "ix_media_asset_project_links_project_created",
        "media_asset_project_links",
        ["project_id", "created_at", "asset_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_media_asset_project_links_project_created",
        table_name="media_asset_project_links",
    )
    op.drop_table("media_asset_project_links")
    op.drop_index("ix_media_assets_owner_created", table_name="media_assets")
    op.drop_index("ix_media_assets_origin_created", table_name="media_assets")
    op.drop_table("media_assets")
