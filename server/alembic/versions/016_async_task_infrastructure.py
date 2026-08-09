"""Add durable asynchronous task infrastructure.

Revision ID: 016
Revises: 015
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "016"
down_revision: str | None = "015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_BATCH_STATUSES = (
    "queued",
    "running",
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
    "awaiting_payment",
    "waiting_dependency",
    "complete",
    "failed",
    "cancelled",
)


def _sql_values(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    op.create_table(
        "task_batches",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("owner_user_id", sa.String(length=32), nullable=False),
        sa.Column("project_id", sa.String(length=32), nullable=False),
        sa.Column("task_type", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("request_hash", sa.String(length=64), nullable=False),
        sa.Column("snapshot_version", sa.Integer(), nullable=False),
        sa.Column("project_version", sa.Integer(), nullable=False),
        sa.Column("request_snapshot", sa.JSON(), nullable=False),
        sa.Column("progress", sa.Integer(), nullable=False),
        sa.Column("total_items", sa.Integer(), nullable=False),
        sa.Column("completed_items", sa.Integer(), nullable=False),
        sa.Column("failed_items", sa.Integer(), nullable=False),
        sa.Column("billing_job_id", sa.String(length=32), nullable=True),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            f"status IN ({_sql_values(_BATCH_STATUSES)})",
            name="ck_task_batches_status",
        ),
        sa.CheckConstraint(
            "snapshot_version >= 1", name="ck_task_batches_snapshot_version"
        ),
        sa.CheckConstraint(
            "project_version >= 1", name="ck_task_batches_project_version"
        ),
        sa.CheckConstraint(
            "progress BETWEEN 0 AND 100", name="ck_task_batches_progress"
        ),
        sa.CheckConstraint("total_items > 0", name="ck_task_batches_total_items"),
        sa.CheckConstraint(
            "completed_items >= 0 AND completed_items <= total_items",
            name="ck_task_batches_completed_items",
        ),
        sa.CheckConstraint(
            "failed_items >= 0 AND failed_items <= total_items",
            name="ck_task_batches_failed_items",
        ),
        sa.CheckConstraint(
            "completed_items + failed_items <= total_items",
            name="ck_task_batches_terminal_counts",
        ),
        sa.CheckConstraint(
            "length(request_hash) = 64", name="ck_task_batches_request_hash"
        ),
        sa.ForeignKeyConstraint(["billing_job_id"], ["generation_jobs.id"]),
        sa.ForeignKeyConstraint(["owner_user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "owner_user_id",
            "project_id",
            "idempotency_key",
            name="uq_task_batches_owner_project_idempotency",
        ),
    )
    op.create_index(
        "ix_task_batches_owner_created",
        "task_batches",
        ["owner_user_id", "created_at", "id"],
    )
    op.create_index(
        "ix_task_batches_project_created",
        "task_batches",
        ["project_id", "created_at", "id"],
    )
    op.create_index(
        "ix_task_batches_status_created",
        "task_batches",
        ["status", "created_at", "id"],
    )

    op.create_table(
        "task_items",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("batch_id", sa.String(length=32), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("task_type", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("snapshot_version", sa.Integer(), nullable=False),
        sa.Column("project_version", sa.Integer(), nullable=False),
        sa.Column("input_snapshot", sa.JSON(), nullable=False),
        sa.Column("reference_snapshot", sa.JSON(), nullable=False),
        sa.Column("model", sa.String(length=255), nullable=True),
        sa.Column("target_entity_type", sa.String(length=64), nullable=True),
        sa.Column("target_entity_id", sa.String(length=128), nullable=True),
        sa.Column("target_entity_version", sa.Integer(), nullable=True),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("max_attempts", sa.Integer(), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("progress", sa.Integer(), nullable=False),
        sa.Column("retryable", sa.Boolean(), nullable=False),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("result_snapshot", sa.JSON(), nullable=True),
        sa.Column("billing_job_id", sa.String(length=32), nullable=True),
        sa.Column("settlement_key", sa.String(length=64), nullable=False),
        sa.Column("claimed_by", sa.String(length=64), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            f"status IN ({_sql_values(_ITEM_STATUSES)})",
            name="ck_task_items_status",
        ),
        sa.CheckConstraint("position >= 0", name="ck_task_items_position"),
        sa.CheckConstraint(
            "snapshot_version >= 1", name="ck_task_items_snapshot_version"
        ),
        sa.CheckConstraint(
            "project_version >= 1", name="ck_task_items_project_version"
        ),
        sa.CheckConstraint("attempt_count >= 0", name="ck_task_items_attempt_count"),
        sa.CheckConstraint(
            "attempt_count <= max_attempts", name="ck_task_items_attempt_limit"
        ),
        sa.CheckConstraint(
            "max_attempts BETWEEN 1 AND 10", name="ck_task_items_max_attempts"
        ),
        sa.CheckConstraint("progress BETWEEN 0 AND 100", name="ck_task_items_progress"),
        sa.CheckConstraint(
            "(target_entity_type IS NULL AND target_entity_id IS NULL AND "
            "target_entity_version IS NULL) OR "
            "(target_entity_type IS NOT NULL AND target_entity_id IS NOT NULL AND "
            "target_entity_version IS NOT NULL AND target_entity_version >= 1)",
            name="ck_task_items_target_version_shape",
        ),
        sa.ForeignKeyConstraint(["batch_id"], ["task_batches.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["billing_job_id"], ["generation_jobs.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "batch_id", "idempotency_key", name="uq_task_items_batch_key"
        ),
        sa.UniqueConstraint("batch_id", "id", name="uq_task_items_batch_id"),
        sa.UniqueConstraint("settlement_key", name="uq_task_items_settlement_key"),
    )
    op.create_index(
        "ix_task_items_batch_position", "task_items", ["batch_id", "position", "id"]
    )
    op.create_index("ix_task_items_billing_job", "task_items", ["billing_job_id"])
    op.create_index("ix_task_items_lease", "task_items", ["status", "lease_expires_at"])
    op.create_index(
        "ix_task_items_runnable",
        "task_items",
        ["status", "next_attempt_at", "created_at", "id"],
    )

    op.create_table(
        "task_dependencies",
        sa.Column("batch_id", sa.String(length=32), nullable=False),
        sa.Column("task_item_id", sa.String(length=32), nullable=False),
        sa.Column("depends_on_item_id", sa.String(length=32), nullable=False),
        sa.Column("failure_policy", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "task_item_id <> depends_on_item_id",
            name="ck_task_dependencies_not_self",
        ),
        sa.CheckConstraint(
            "failure_policy IN ('fail')",
            name="ck_task_dependencies_failure_policy",
        ),
        sa.ForeignKeyConstraint(
            ["batch_id", "task_item_id"],
            ["task_items.batch_id", "task_items.id"],
            ondelete="CASCADE",
            name="fk_task_dependencies_item_batch",
        ),
        sa.ForeignKeyConstraint(
            ["batch_id", "depends_on_item_id"],
            ["task_items.batch_id", "task_items.id"],
            ondelete="CASCADE",
            name="fk_task_dependencies_parent_batch",
        ),
        sa.PrimaryKeyConstraint("batch_id", "task_item_id", "depends_on_item_id"),
    )
    op.create_index(
        "ix_task_dependencies_parent",
        "task_dependencies",
        ["batch_id", "depends_on_item_id", "task_item_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_task_dependencies_parent", table_name="task_dependencies")
    op.drop_table("task_dependencies")
    op.drop_index("ix_task_items_runnable", table_name="task_items")
    op.drop_index("ix_task_items_lease", table_name="task_items")
    op.drop_index("ix_task_items_billing_job", table_name="task_items")
    op.drop_index("ix_task_items_batch_position", table_name="task_items")
    op.drop_table("task_items")
    op.drop_index("ix_task_batches_status_created", table_name="task_batches")
    op.drop_index("ix_task_batches_project_created", table_name="task_batches")
    op.drop_index("ix_task_batches_owner_created", table_name="task_batches")
    op.drop_table("task_batches")
