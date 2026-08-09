"""Persist administrator-managed video model call durations.

Revision ID: 019
Revises: 018
"""

from collections.abc import Sequence
from datetime import datetime, timezone
import hashlib

import sqlalchemy as sa
from alembic import op


revision: str = "019"
down_revision: str | None = "018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_BOOTSTRAP_SETTINGS = (
    ("newapi", "omni_flash-10s", 10.0),
    ("newapi", "sora-2-12s", 12.0),
    ("newapi", "sora_2", 12.0),
    ("newapi", "sora_v2", 12.0),
    ("newapi", "sora_v2_pro", 12.0),
)


def _setting_id(provider: str, model_id: str) -> str:
    return hashlib.sha256(f"{provider}\0{model_id}".encode("utf-8")).hexdigest()[:32]


def upgrade() -> None:
    table = op.create_table(
        "video_model_duration_settings",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("model_id", sa.String(length=200), nullable=False),
        sa.Column("call_duration_seconds", sa.Float(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("updated_by", sa.String(length=32), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "call_duration_seconds > 0",
            name="ck_video_model_duration_settings_positive_duration",
        ),
        sa.CheckConstraint(
            "version >= 1",
            name="ck_video_model_duration_settings_version",
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["users.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "provider",
            "model_id",
            name="uq_video_model_duration_settings_provider_model",
        ),
    )
    now = datetime.now(timezone.utc)
    op.bulk_insert(
        table,
        [
            {
                "id": _setting_id(provider, model_id),
                "provider": provider,
                "model_id": model_id,
                "call_duration_seconds": duration,
                "version": 1,
                "updated_by": None,
                "created_at": now,
                "updated_at": now,
            }
            for provider, model_id, duration in _BOOTSTRAP_SETTINGS
        ],
    )


def downgrade() -> None:
    op.drop_table("video_model_duration_settings")
