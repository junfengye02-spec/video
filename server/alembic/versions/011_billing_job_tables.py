"""Create billing job, receipt, setting, and reconciliation tables.

Revision ID: 011
Revises: 010
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "011"
down_revision: str | None = "010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "generation_jobs",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("parent_job_id", sa.String(length=32), nullable=True),
        sa.Column("chargeable", sa.Boolean(), nullable=False),
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("project_id", sa.String(length=32), nullable=False),
        sa.Column("operation", sa.String(length=191), nullable=False),
        sa.Column("capability", sa.String(length=16), nullable=True),
        sa.Column("token_kind", sa.String(length=16), nullable=True),
        sa.Column("token_alias", sa.String(length=64), nullable=True),
        sa.Column("model", sa.String(length=255), nullable=True),
        sa.Column("multiplier_bps", sa.Integer(), nullable=True),
        sa.Column("provider_method", sa.String(length=16), nullable=True),
        sa.Column("provider_route", sa.String(length=255), nullable=True),
        sa.Column("provider_reference_type", sa.String(length=16), nullable=True),
        sa.Column("provider_reference_id", sa.String(length=191), nullable=True),
        sa.Column("reference_deadline", sa.DateTime(timezone=True), nullable=True),
        sa.Column("receipt_deadline", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(length=64), nullable=False),
        sa.Column("result_locator", sa.Text(), nullable=True),
        sa.Column("result_sha256", sa.String(length=64), nullable=True),
        sa.Column("result_staged", sa.Boolean(), nullable=False),
        sa.Column("result_visible", sa.Boolean(), nullable=False),
        sa.Column("quote_id", sa.String(length=191), nullable=True),
        sa.Column("quote_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("quote_estimated_quota", sa.BigInteger(), nullable=True),
        sa.Column(
            "quote_estimated_provider_cost_micro", sa.BigInteger(), nullable=True
        ),
        sa.Column("quote_quota_per_unit", sa.Numeric(precision=30, scale=9), nullable=True),
        sa.Column("quote_pricing_version", sa.String(length=191), nullable=True),
        sa.Column("quote_other_ratios_json", sa.Text(), nullable=True),
        sa.Column("quote_billing_fingerprint", sa.String(length=191), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["parent_job_id"], ["generation_jobs.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_generation_jobs_parent",
        "generation_jobs",
        ["parent_job_id"],
        unique=False,
    )
    op.create_index(
        "ix_generation_jobs_project_created",
        "generation_jobs",
        ["project_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_generation_jobs_status_deadline",
        "generation_jobs",
        ["status", "receipt_deadline"],
        unique=False,
    )
    op.create_index(
        "ix_generation_jobs_user_created",
        "generation_jobs",
        ["user_id", "created_at"],
        unique=False,
    )
    op.create_foreign_key(
        "fk_wallet_holds_job_id_generation_jobs",
        "wallet_holds",
        "generation_jobs",
        ["job_id"],
        ["id"],
    )

    op.create_table(
        "cost_receipts",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("job_id", sa.String(length=32), nullable=False),
        sa.Column("reference_type", sa.String(length=16), nullable=False),
        sa.Column("reference_id", sa.String(length=191), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("model", sa.String(length=255), nullable=False),
        sa.Column("quota", sa.BigInteger(), nullable=False),
        sa.Column("refunded_quota", sa.BigInteger(), nullable=False),
        sa.Column("quota_per_unit", sa.Numeric(precision=30, scale=9), nullable=False),
        sa.Column("pricing_version", sa.String(length=191), nullable=False),
        sa.Column("cost_currency", sa.String(length=3), nullable=False),
        sa.Column("cost_amount_micro", sa.BigInteger(), nullable=False),
        sa.Column("settled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("raw_canonical_json", sa.Text(), nullable=False),
        sa.Column("raw_sha256", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "reference_type IN ('request', 'task')",
            name="ck_cost_receipts_reference_type",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'settled', 'refunded', 'refund_pending', "
            "'not_chargeable')",
            name="ck_cost_receipts_status",
        ),
        sa.CheckConstraint(
            "quota >= 0", name="ck_cost_receipts_quota_nonnegative"
        ),
        sa.CheckConstraint(
            "refunded_quota >= 0", name="ck_cost_receipts_refunded_nonnegative"
        ),
        sa.CheckConstraint(
            "quota_per_unit > 0", name="ck_cost_receipts_quota_per_unit_positive"
        ),
        sa.CheckConstraint(
            "cost_currency = 'USD'", name="ck_cost_receipts_currency"
        ),
        sa.CheckConstraint(
            "cost_amount_micro >= 0", name="ck_cost_receipts_cost_nonnegative"
        ),
        sa.ForeignKeyConstraint(["job_id"], ["generation_jobs.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_id", name="uq_cost_receipts_job_id"),
    )
    op.create_index(
        "ix_cost_receipts_reference",
        "cost_receipts",
        ["reference_type", "reference_id"],
        unique=False,
    )

    op.create_table(
        "billing_settings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("multiplier_bps", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("id = 1", name="ck_billing_settings_singleton"),
        sa.CheckConstraint(
            "multiplier_bps > 0", name="ck_billing_settings_multiplier_positive"
        ),
        sa.CheckConstraint(
            "version >= 0", name="ck_billing_settings_version_nonnegative"
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "billing_reconciliations",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("job_id", sa.String(length=32), nullable=False),
        sa.Column("reason", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("next_retry_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "status IN ('open', 'resolved')",
            name="ck_billing_reconciliations_status",
        ),
        sa.CheckConstraint(
            "attempts >= 0",
            name="ck_billing_reconciliations_attempts_nonnegative",
        ),
        sa.ForeignKeyConstraint(["job_id"], ["generation_jobs.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_billing_reconciliations_due",
        "billing_reconciliations",
        ["status", "next_retry_at"],
        unique=False,
    )
    op.create_index(
        "ix_billing_reconciliations_job",
        "billing_reconciliations",
        ["job_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_billing_reconciliations_job", table_name="billing_reconciliations"
    )
    op.drop_index(
        "ix_billing_reconciliations_due", table_name="billing_reconciliations"
    )
    op.drop_table("billing_reconciliations")
    op.drop_table("billing_settings")
    op.drop_index("ix_cost_receipts_reference", table_name="cost_receipts")
    op.drop_table("cost_receipts")
    op.drop_constraint(
        "fk_wallet_holds_job_id_generation_jobs",
        "wallet_holds",
        type_="foreignkey",
    )
    op.drop_index("ix_generation_jobs_user_created", table_name="generation_jobs")
    op.drop_index("ix_generation_jobs_status_deadline", table_name="generation_jobs")
    op.drop_index("ix_generation_jobs_project_created", table_name="generation_jobs")
    op.drop_index("ix_generation_jobs_parent", table_name="generation_jobs")
    op.drop_table("generation_jobs")
