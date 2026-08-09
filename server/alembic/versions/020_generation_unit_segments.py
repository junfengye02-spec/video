"""Add generation segment coverage to the execution ledger.

Revision ID: 020
Revises: 019
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "020"
down_revision: str | None = "019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "video_generation_units",
        sa.Column(
            "source_segment_ids_json",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'"),
        ),
    )


def downgrade() -> None:
    op.drop_column("video_generation_units", "source_segment_ids_json")
