"""Create owner-scoped projects with nullable owners for legacy migration.

Revision ID: 002
Revises: 001
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "002"
down_revision: str | None = "001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("owner_user_id", sa.String(length=32), nullable=True),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("mode", sa.String(length=32), nullable=False),
        sa.Column("project_type", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_projects_owner_user_id",
        "projects",
        ["owner_user_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_projects_owner_user_id", table_name="projects")
    op.drop_table("projects")
