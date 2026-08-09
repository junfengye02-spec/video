"""Require every project to have an explicitly assigned owner.

Revision ID: 003
Revises: 002
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "003"
down_revision: str | None = "002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    result = bind.execute(
        sa.text("SELECT COUNT(*) FROM projects WHERE owner_user_id IS NULL")
    )
    if result is None:
        raise RuntimeError(
            "Revision 003 requires an online migration to verify ownership. "
            "Run assign-project for every unowned project, then run alembic upgrade 003 without --sql."
        )
    unowned_count = result.scalar_one()
    if unowned_count:
        raise RuntimeError(
            f"Cannot require project owners: {unowned_count} unowned projects remain. "
            "Run assign-project for every reported project ID, then retry revision 003."
        )
    if bind.dialect.name == "sqlite":
        with op.batch_alter_table("projects") as batch_op:
            batch_op.alter_column(
                "owner_user_id",
                existing_type=sa.String(length=32),
                nullable=False,
            )
    else:
        op.alter_column(
            "projects",
            "owner_user_id",
            existing_type=sa.String(length=32),
            nullable=False,
        )


def downgrade() -> None:
    if op.get_bind().dialect.name == "sqlite":
        with op.batch_alter_table("projects") as batch_op:
            batch_op.alter_column(
                "owner_user_id",
                existing_type=sa.String(length=32),
                nullable=True,
            )
    else:
        op.alter_column(
            "projects",
            "owner_user_id",
            existing_type=sa.String(length=32),
            nullable=True,
        )
