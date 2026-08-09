from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from server.app.db.base import Base, TimestampMixin


BATCH_STATUSES = (
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
ITEM_STATUSES = (
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


class TaskBatch(TimestampMixin, Base):
    __tablename__ = "task_batches"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    owner_user_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("users.id"), nullable=False
    )
    project_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    task_type: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="queued")
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    snapshot_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    project_version: Mapped[int] = mapped_column(Integer, nullable=False)
    request_snapshot: Mapped[dict] = mapped_column(JSON, nullable=False)
    progress: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_items: Mapped[int] = mapped_column(Integer, nullable=False)
    completed_items: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failed_items: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    billing_job_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("generation_jobs.id")
    )
    error_code: Mapped[str | None] = mapped_column(String(64))
    error_message: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    items: Mapped[list["TaskItem"]] = relationship(
        back_populates="batch",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="TaskItem.position",
    )

    __table_args__ = (
        UniqueConstraint(
            "owner_user_id",
            "project_id",
            "idempotency_key",
            name="uq_task_batches_owner_project_idempotency",
        ),
        CheckConstraint(
            f"status IN ({_sql_values(BATCH_STATUSES)})",
            name="ck_task_batches_status",
        ),
        CheckConstraint(
            "snapshot_version >= 1", name="ck_task_batches_snapshot_version"
        ),
        CheckConstraint("project_version >= 1", name="ck_task_batches_project_version"),
        CheckConstraint("progress BETWEEN 0 AND 100", name="ck_task_batches_progress"),
        CheckConstraint("total_items > 0", name="ck_task_batches_total_items"),
        CheckConstraint(
            "completed_items >= 0 AND completed_items <= total_items",
            name="ck_task_batches_completed_items",
        ),
        CheckConstraint(
            "failed_items >= 0 AND failed_items <= total_items",
            name="ck_task_batches_failed_items",
        ),
        CheckConstraint(
            "completed_items + failed_items <= total_items",
            name="ck_task_batches_terminal_counts",
        ),
        CheckConstraint(
            "length(request_hash) = 64", name="ck_task_batches_request_hash"
        ),
        Index("ix_task_batches_project_created", "project_id", "created_at", "id"),
        Index("ix_task_batches_owner_created", "owner_user_id", "created_at", "id"),
        Index("ix_task_batches_status_created", "status", "created_at", "id"),
    )


class TaskItem(TimestampMixin, Base):
    __tablename__ = "task_items"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    batch_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("task_batches.id", ondelete="CASCADE"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    task_type: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="queued")
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    snapshot_version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    project_version: Mapped[int] = mapped_column(Integer, nullable=False)
    input_snapshot: Mapped[dict] = mapped_column(JSON, nullable=False)
    reference_snapshot: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    model: Mapped[str | None] = mapped_column(String(255))
    target_entity_type: Mapped[str | None] = mapped_column(String(64))
    target_entity_id: Mapped[str | None] = mapped_column(String(128))
    target_entity_version: Mapped[int | None] = mapped_column(Integer)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    progress: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    retryable: Mapped[bool] = mapped_column(nullable=False, default=True)
    error_code: Mapped[str | None] = mapped_column(String(64))
    error_message: Mapped[str | None] = mapped_column(Text)
    result_snapshot: Mapped[dict | None] = mapped_column(JSON)
    billing_job_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("generation_jobs.id")
    )
    settlement_key: Mapped[str] = mapped_column(String(64), nullable=False)
    generation_key: Mapped[str | None] = mapped_column(String(64))
    generation_revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    provider_wait_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    provider_next_poll_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    provider_poll_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    claimed_by: Mapped[str | None] = mapped_column(String(64))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    batch: Mapped[TaskBatch] = relationship(back_populates="items")

    __table_args__ = (
        UniqueConstraint("batch_id", "idempotency_key", name="uq_task_items_batch_key"),
        UniqueConstraint("batch_id", "id", name="uq_task_items_batch_id"),
        UniqueConstraint("settlement_key", name="uq_task_items_settlement_key"),
        UniqueConstraint("generation_key", name="uq_task_items_generation_key"),
        CheckConstraint(
            f"status IN ({_sql_values(ITEM_STATUSES)})",
            name="ck_task_items_status",
        ),
        CheckConstraint("position >= 0", name="ck_task_items_position"),
        CheckConstraint("snapshot_version >= 1", name="ck_task_items_snapshot_version"),
        CheckConstraint("project_version >= 1", name="ck_task_items_project_version"),
        CheckConstraint("attempt_count >= 0", name="ck_task_items_attempt_count"),
        CheckConstraint(
            "generation_revision >= 0", name="ck_task_items_generation_revision"
        ),
        CheckConstraint(
            "provider_poll_count >= 0", name="ck_task_items_provider_poll_count"
        ),
        CheckConstraint(
            "attempt_count <= max_attempts", name="ck_task_items_attempt_limit"
        ),
        CheckConstraint(
            "max_attempts BETWEEN 1 AND 10", name="ck_task_items_max_attempts"
        ),
        CheckConstraint("progress BETWEEN 0 AND 100", name="ck_task_items_progress"),
        CheckConstraint(
            "(target_entity_type IS NULL AND target_entity_id IS NULL AND "
            "target_entity_version IS NULL) OR "
            "(target_entity_type IS NOT NULL AND target_entity_id IS NOT NULL AND "
            "target_entity_version IS NOT NULL AND target_entity_version >= 1)",
            name="ck_task_items_target_version_shape",
        ),
        Index("ix_task_items_batch_position", "batch_id", "position", "id"),
        Index(
            "ix_task_items_runnable", "status", "next_attempt_at", "created_at", "id"
        ),
        Index("ix_task_items_lease", "status", "lease_expires_at"),
        Index("ix_task_items_billing_job", "billing_job_id"),
        Index(
            "ix_task_items_generation_target",
            "target_entity_type",
            "target_entity_id",
            "target_entity_version",
            "model",
            "status",
        ),
        Index("ix_task_items_provider_poll", "status", "provider_next_poll_at"),
    )


class TaskDependency(TimestampMixin, Base):
    __tablename__ = "task_dependencies"

    batch_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    task_item_id: Mapped[str] = mapped_column(
        String(32), primary_key=True
    )
    depends_on_item_id: Mapped[str] = mapped_column(
        String(32), primary_key=True
    )
    failure_policy: Mapped[str] = mapped_column(
        String(16), nullable=False, default="fail"
    )

    __table_args__ = (
        CheckConstraint(
            "task_item_id <> depends_on_item_id",
            name="ck_task_dependencies_not_self",
        ),
        CheckConstraint(
            "failure_policy IN ('fail')",
            name="ck_task_dependencies_failure_policy",
        ),
        ForeignKeyConstraint(
            ["batch_id", "task_item_id"],
            ["task_items.batch_id", "task_items.id"],
            ondelete="CASCADE",
            name="fk_task_dependencies_item_batch",
        ),
        ForeignKeyConstraint(
            ["batch_id", "depends_on_item_id"],
            ["task_items.batch_id", "task_items.id"],
            ondelete="CASCADE",
            name="fk_task_dependencies_parent_batch",
        ),
        Index(
            "ix_task_dependencies_parent",
            "batch_id",
            "depends_on_item_id",
            "task_item_id",
        ),
    )
