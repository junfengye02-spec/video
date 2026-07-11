from __future__ import annotations

from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from server.app.db.base import Base, TimestampMixin


CHILD_JOB_STATUSES = (
    "reserved",
    "submitted_ambiguous",
    "reference_recovery_pending",
    "payment_required_quote",
    "provider_pricing_unstable_no_charge",
    "provider_quote_rate_limited_no_charge",
    "provider_pricing_unavailable_no_charge",
    "provider_not_submitted_no_charge",
    "provider_rejected_no_charge",
    "provider_reference_missing_no_charge",
    "provider_result_missing_no_charge",
    "result_pending",
    "receipt_pending",
    "receipt_missing_no_charge",
    "payment_required",
    "failed_no_charge",
    "billed",
)
PARENT_JOB_STATUSES = ("running", "complete", "partial_failure", "failed")


def _sql_values(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


class GenerationJob(TimestampMixin, Base):
    __tablename__ = "generation_jobs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    parent_job_id: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("generation_jobs.id")
    )
    chargeable: Mapped[bool] = mapped_column(Boolean, nullable=False)
    user_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("users.id"), nullable=False
    )
    project_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("projects.id"), nullable=False
    )
    operation: Mapped[str] = mapped_column(
        String(191), nullable=False, default="provider_call"
    )
    capability: Mapped[str | None] = mapped_column(String(16))
    token_kind: Mapped[str | None] = mapped_column(String(16))
    token_alias: Mapped[str | None] = mapped_column(String(64))
    model: Mapped[str | None] = mapped_column(String(255))
    multiplier_bps: Mapped[int | None] = mapped_column(Integer)
    provider_method: Mapped[str | None] = mapped_column(String(16))
    provider_route: Mapped[str | None] = mapped_column(String(255))
    provider_reference_type: Mapped[str | None] = mapped_column(String(16))
    provider_reference_id: Mapped[str | None] = mapped_column(String(191))
    reference_deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    receipt_deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(64), nullable=False)
    result_locator: Mapped[str | None] = mapped_column(Text)
    result_sha256: Mapped[str | None] = mapped_column(String(64))
    result_staged: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    result_visible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    quote_id: Mapped[str | None] = mapped_column(String(191))
    quote_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    quote_estimated_quota: Mapped[int | None] = mapped_column(BigInteger)
    quote_estimated_provider_cost_micro: Mapped[int | None] = mapped_column(BigInteger)
    quote_quota_per_unit: Mapped[Decimal | None] = mapped_column(Numeric(30, 9))
    quote_pricing_version: Mapped[str | None] = mapped_column(String(191))
    quote_other_ratios_json: Mapped[str | None] = mapped_column(Text)
    quote_billing_fingerprint: Mapped[str | None] = mapped_column(String(191))

    __table_args__ = (
        CheckConstraint(
            f"(chargeable AND status IN ({_sql_values(CHILD_JOB_STATUSES)})) OR "
            f"((NOT chargeable) AND status IN ({_sql_values(PARENT_JOB_STATUSES)}))",
            name="ck_generation_jobs_chargeable_status",
        ),
        CheckConstraint(
            "chargeable OR ("
            "parent_job_id IS NULL AND capability IS NULL AND token_kind IS NULL AND "
            "token_alias IS NULL AND model IS NULL AND multiplier_bps IS NULL AND "
            "provider_method IS NULL AND provider_route IS NULL AND "
            "provider_reference_type IS NULL AND provider_reference_id IS NULL AND "
            "reference_deadline IS NULL AND receipt_deadline IS NULL AND "
            "quote_id IS NULL AND quote_expires_at IS NULL AND "
            "quote_estimated_quota IS NULL AND "
            "quote_estimated_provider_cost_micro IS NULL AND "
            "quote_quota_per_unit IS NULL AND quote_pricing_version IS NULL AND "
            "quote_other_ratios_json IS NULL AND quote_billing_fingerprint IS NULL AND "
            "result_locator IS NULL AND result_sha256 IS NULL AND "
            "result_staged = false AND result_visible = false)",
            name="ck_generation_jobs_parent_shape",
        ),
        CheckConstraint(
            "(NOT chargeable) OR ("
            "token_kind IS NOT NULL AND token_alias IS NOT NULL AND model IS NOT NULL AND "
            "multiplier_bps > 0 AND quote_id IS NOT NULL AND "
            "quote_expires_at IS NOT NULL AND quote_estimated_quota > 0 AND "
            "quote_estimated_provider_cost_micro > 0 AND quote_quota_per_unit > 0 AND "
            "quote_pricing_version IS NOT NULL AND quote_other_ratios_json IS NOT NULL AND "
            "quote_billing_fingerprint IS NOT NULL)",
            name="ck_generation_jobs_child_quote",
        ),
        CheckConstraint(
            "(provider_reference_type IS NULL) = (provider_reference_id IS NULL)",
            name="ck_generation_jobs_provider_reference_pair",
        ),
        CheckConstraint(
            "token_kind IS NULL OR token_kind IN ('text', 'image', 'video')",
            name="ck_generation_jobs_token_kind",
        ),
        CheckConstraint(
            "provider_reference_type IS NULL OR "
            "provider_reference_type IN ('request', 'task')",
            name="ck_generation_jobs_provider_reference_type",
        ),
        CheckConstraint(
            "(NOT result_visible) OR (result_staged AND result_locator IS NOT NULL AND "
            "result_sha256 IS NOT NULL AND status = 'billed')",
            name="ck_generation_jobs_result_visible",
        ),
        Index("ix_generation_jobs_user_created", "user_id", "created_at"),
        Index("ix_generation_jobs_project_created", "project_id", "created_at"),
        Index("ix_generation_jobs_parent", "parent_job_id"),
        Index("ix_generation_jobs_status_deadline", "status", "receipt_deadline"),
        Index(
            "uq_generation_jobs_provider_reference_token",
            "provider_reference_type",
            "provider_reference_id",
            "token_alias",
            unique=True,
            postgresql_where=text(
                "provider_reference_type IS NOT NULL AND "
                "provider_reference_id IS NOT NULL AND token_alias IS NOT NULL"
            ),
        ),
        Index(
            "uq_generation_jobs_quote_token",
            "quote_id",
            "token_alias",
            unique=True,
            postgresql_where=text("quote_id IS NOT NULL AND token_alias IS NOT NULL"),
        ),
    )

    @classmethod
    def parent(
        cls,
        *,
        id: str,
        user_id: str,
        project_id: str,
        operation: str,
    ) -> "GenerationJob":
        return cls(
            id=id,
            user_id=user_id,
            project_id=project_id,
            operation=operation,
            chargeable=False,
            status="running",
            result_staged=False,
            result_visible=False,
        )


class CostReceipt(TimestampMixin, Base):
    __tablename__ = "cost_receipts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    job_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("generation_jobs.id"), nullable=False
    )
    reference_type: Mapped[str] = mapped_column(String(16), nullable=False)
    reference_id: Mapped[str] = mapped_column(String(191), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    model: Mapped[str] = mapped_column(String(255), nullable=False)
    quota: Mapped[int] = mapped_column(BigInteger, nullable=False)
    refunded_quota: Mapped[int] = mapped_column(BigInteger, nullable=False)
    quota_per_unit: Mapped[Decimal] = mapped_column(Numeric(30, 9), nullable=False)
    pricing_version: Mapped[str] = mapped_column(String(191), nullable=False)
    cost_currency: Mapped[str] = mapped_column(String(3), nullable=False)
    cost_amount_micro: Mapped[int] = mapped_column(BigInteger, nullable=False)
    settled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    raw_canonical_json: Mapped[str] = mapped_column(Text, nullable=False)
    raw_sha256: Mapped[str] = mapped_column(String(64), nullable=False)

    __table_args__ = (
        UniqueConstraint("job_id", name="uq_cost_receipts_job_id"),
        CheckConstraint(
            "reference_type IN ('request', 'task')",
            name="ck_cost_receipts_reference_type",
        ),
        CheckConstraint(
            "status IN ('pending', 'settled', 'refunded', 'refund_pending', "
            "'not_chargeable')",
            name="ck_cost_receipts_status",
        ),
        CheckConstraint("quota >= 0", name="ck_cost_receipts_quota_nonnegative"),
        CheckConstraint(
            "refunded_quota >= 0", name="ck_cost_receipts_refunded_nonnegative"
        ),
        CheckConstraint(
            "quota_per_unit > 0", name="ck_cost_receipts_quota_per_unit_positive"
        ),
        CheckConstraint("cost_currency = 'USD'", name="ck_cost_receipts_currency"),
        CheckConstraint(
            "cost_amount_micro >= 0", name="ck_cost_receipts_cost_nonnegative"
        ),
        Index("ix_cost_receipts_reference", "reference_type", "reference_id"),
    )


class BillingSetting(TimestampMixin, Base):
    __tablename__ = "billing_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    multiplier_bps: Mapped[int] = mapped_column(Integer, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (
        CheckConstraint("id = 1", name="ck_billing_settings_singleton"),
        CheckConstraint(
            "multiplier_bps > 0", name="ck_billing_settings_multiplier_positive"
        ),
        CheckConstraint("version >= 0", name="ck_billing_settings_version_nonnegative"),
    )
    __mapper_args__ = {
        "version_id_col": version,
        "version_id_generator": False,
    }


class BillingReconciliation(TimestampMixin, Base):
    __tablename__ = "billing_reconciliations"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    job_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("generation_jobs.id"), nullable=False
    )
    reason: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="open")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        CheckConstraint(
            "status IN ('open', 'resolved')", name="ck_billing_reconciliations_status"
        ),
        CheckConstraint(
            "attempts >= 0", name="ck_billing_reconciliations_attempts_nonnegative"
        ),
        Index("ix_billing_reconciliations_due", "status", "next_retry_at"),
        Index("ix_billing_reconciliations_job", "job_id"),
    )
