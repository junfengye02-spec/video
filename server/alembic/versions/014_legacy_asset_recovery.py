"""Allow legacy AI asset recovery without generation jobs.

Revision ID: 014
Revises: 013
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "014"
down_revision: str | None = "013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_SOURCE_SHAPE_WITH_RECOVERY = (
    "(source_type = 'upload' AND generation_job_id IS NULL AND "
    "output_index IS NULL AND recovery_key IS NULL) OR "
    "(source_type = 'ai_generated' AND generation_job_id IS NOT NULL AND "
    "output_index IS NOT NULL AND output_index >= 0 AND model IS NOT NULL AND "
    "recovery_key IS NULL) OR "
    "(source_type = 'ai_generated' AND generation_job_id IS NULL AND "
    "output_index IS NULL AND recovery_key IS NOT NULL)"
)

_SOURCE_SHAPE_WITHOUT_RECOVERY = (
    "(source_type = 'upload' AND generation_job_id IS NULL AND "
    "output_index IS NULL) OR "
    "(source_type = 'ai_generated' AND generation_job_id IS NOT NULL AND "
    "output_index IS NOT NULL AND output_index >= 0 AND model IS NOT NULL)"
)


def upgrade() -> None:
    with op.batch_alter_table("media_assets") as batch_op:
        batch_op.add_column(sa.Column("recovery_key", sa.String(length=64)))
        batch_op.drop_constraint(
            "ck_media_assets_source_shape",
            type_="check",
        )
        batch_op.create_check_constraint(
            "ck_media_assets_source_shape",
            _SOURCE_SHAPE_WITH_RECOVERY,
        )
        batch_op.create_unique_constraint(
            "uq_media_assets_owner_recovery_key",
            ["owner_user_id", "recovery_key"],
        )


def downgrade() -> None:
    with op.batch_alter_table("media_assets") as batch_op:
        batch_op.drop_constraint(
            "uq_media_assets_owner_recovery_key",
            type_="unique",
        )
        batch_op.drop_constraint(
            "ck_media_assets_source_shape",
            type_="check",
        )
        batch_op.create_check_constraint(
            "ck_media_assets_source_shape",
            _SOURCE_SHAPE_WITHOUT_RECOVERY,
        )
        batch_op.drop_column("recovery_key")
