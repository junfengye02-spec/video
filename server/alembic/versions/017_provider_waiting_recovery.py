"""Add provider waiting, generation fencing, and billing worker health.

Revision ID: 017
Revises: 016
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "017"
down_revision: str | None = "016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_BATCH_STATUSES = (
    "queued",
    "running",
    "waiting_provider",
    "awaiting_payment",
    "waiting_dependency",
    "complete",
    "failed",
    "cancelled",
    "partial_failure",
)
_ITEM_STATUSES = (
    "queued",
    "running",
    "waiting_provider",
    "awaiting_payment",
    "waiting_dependency",
    "complete",
    "failed",
    "cancelled",
)


def _sql_values(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    with op.batch_alter_table("task_batches") as batch:
        batch.drop_constraint("ck_task_batches_status", type_="check")
        batch.create_check_constraint(
            "ck_task_batches_status",
            f"status IN ({_sql_values(_BATCH_STATUSES)})",
        )

    with op.batch_alter_table("task_items") as batch:
        batch.drop_constraint("ck_task_items_status", type_="check")
        batch.create_check_constraint(
            "ck_task_items_status",
            f"status IN ({_sql_values(_ITEM_STATUSES)})",
        )
        batch.add_column(sa.Column("generation_key", sa.String(length=64)))
        batch.add_column(
            sa.Column(
                "generation_revision", sa.Integer(), nullable=False, server_default="0"
            )
        )
        batch.add_column(sa.Column("provider_wait_started_at", sa.DateTime(timezone=True)))
        batch.add_column(sa.Column("provider_next_poll_at", sa.DateTime(timezone=True)))
        batch.add_column(
            sa.Column(
                "provider_poll_count", sa.Integer(), nullable=False, server_default="0"
            )
        )
        batch.create_check_constraint(
            "ck_task_items_generation_revision", "generation_revision >= 0"
        )
        batch.create_check_constraint(
            "ck_task_items_provider_poll_count", "provider_poll_count >= 0"
        )
        batch.create_unique_constraint("uq_task_items_generation_key", ["generation_key"])

    op.create_index(
        "ix_task_items_generation_target",
        "task_items",
        [
            "target_entity_type",
            "target_entity_id",
            "target_entity_version",
            "model",
            "status",
        ],
    )
    op.create_index(
        "ix_task_items_provider_poll",
        "task_items",
        ["status", "provider_next_poll_at"],
    )
    op.execute(
        sa.text(
            "UPDATE task_items SET status = 'waiting_provider', retryable = false, "
            "provider_wait_started_at = COALESCE(updated_at, created_at), "
            "provider_next_poll_at = NULL, completed_at = NULL "
            "WHERE status = 'failed' AND error_code = 'provider_result_pending' "
            "AND billing_job_id IS NOT NULL"
        )
    )

    op.create_table(
        "billing_worker_heartbeats",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("worker_id", sa.String(length=64), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("id = 1", name="ck_billing_worker_heartbeat_singleton"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_billing_worker_heartbeat_lease",
        "billing_worker_heartbeats",
        ["lease_expires_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_billing_worker_heartbeat_lease", table_name="billing_worker_heartbeats"
    )
    op.drop_table("billing_worker_heartbeats")
    op.execute(
        sa.text(
            "UPDATE task_items SET status = 'failed', "
            "error_code = 'provider_result_pending', "
            "error_message = 'Video provider result is still being reconciled', "
            "retryable = true, completed_at = COALESCE(updated_at, created_at) "
            "WHERE status = 'waiting_provider'"
        )
    )
    op.drop_index("ix_task_items_provider_poll", table_name="task_items")
    op.drop_index("ix_task_items_generation_target", table_name="task_items")
    with op.batch_alter_table("task_items") as batch:
        batch.drop_constraint("uq_task_items_generation_key", type_="unique")
        batch.drop_constraint("ck_task_items_provider_poll_count", type_="check")
        batch.drop_constraint("ck_task_items_generation_revision", type_="check")
        batch.drop_column("provider_poll_count")
        batch.drop_column("provider_next_poll_at")
        batch.drop_column("provider_wait_started_at")
        batch.drop_column("generation_revision")
        batch.drop_column("generation_key")
        batch.drop_constraint("ck_task_items_status", type_="check")
        batch.create_check_constraint(
            "ck_task_items_status",
            "status IN ('queued', 'running', 'awaiting_payment', "
            "'waiting_dependency', 'complete', 'failed', 'cancelled')",
        )
    with op.batch_alter_table("task_batches") as batch:
        batch.drop_constraint("ck_task_batches_status", type_="check")
        batch.create_check_constraint(
            "ck_task_batches_status",
            "status IN ('queued', 'running', 'awaiting_payment', "
            "'waiting_dependency', 'complete', 'failed', 'cancelled', "
            "'partial_failure')",
        )
