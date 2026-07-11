"""Add generation job shape constraints and partial unique indexes.

Revision ID: 012
Revises: 011
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "012"
down_revision: str | None = "011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


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


def upgrade() -> None:
    op.create_check_constraint(
        "ck_generation_jobs_chargeable_status",
        "generation_jobs",
        f"(chargeable AND status IN ({_sql_values(CHILD_JOB_STATUSES)})) OR "
        f"((NOT chargeable) AND status IN ({_sql_values(PARENT_JOB_STATUSES)}))",
    )
    op.create_check_constraint(
        "ck_generation_jobs_parent_shape",
        "generation_jobs",
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
    )
    op.create_check_constraint(
        "ck_generation_jobs_child_quote",
        "generation_jobs",
        "(NOT chargeable) OR ("
        "token_kind IS NOT NULL AND token_alias IS NOT NULL AND model IS NOT NULL AND "
        "multiplier_bps > 0 AND quote_id IS NOT NULL AND "
        "quote_expires_at IS NOT NULL AND quote_estimated_quota > 0 AND "
        "quote_estimated_provider_cost_micro > 0 AND quote_quota_per_unit > 0 AND "
        "quote_pricing_version IS NOT NULL AND quote_other_ratios_json IS NOT NULL AND "
        "quote_billing_fingerprint IS NOT NULL)",
    )
    op.create_check_constraint(
        "ck_generation_jobs_provider_reference_pair",
        "generation_jobs",
        "(provider_reference_type IS NULL) = (provider_reference_id IS NULL)",
    )
    op.create_check_constraint(
        "ck_generation_jobs_token_kind",
        "generation_jobs",
        "token_kind IS NULL OR token_kind IN ('text', 'image', 'video')",
    )
    op.create_check_constraint(
        "ck_generation_jobs_provider_reference_type",
        "generation_jobs",
        "provider_reference_type IS NULL OR "
        "provider_reference_type IN ('request', 'task')",
    )
    op.create_check_constraint(
        "ck_generation_jobs_result_visible",
        "generation_jobs",
        "(NOT result_visible) OR (result_staged AND result_locator IS NOT NULL AND "
        "result_sha256 IS NOT NULL AND status = 'billed')",
    )
    op.create_index(
        "uq_generation_jobs_provider_reference_token",
        "generation_jobs",
        ["provider_reference_type", "provider_reference_id", "token_alias"],
        unique=True,
        postgresql_where=sa.text(
            "provider_reference_type IS NOT NULL AND "
            "provider_reference_id IS NOT NULL AND token_alias IS NOT NULL"
        ),
    )
    op.create_index(
        "uq_generation_jobs_quote_token",
        "generation_jobs",
        ["quote_id", "token_alias"],
        unique=True,
        postgresql_where=sa.text("quote_id IS NOT NULL AND token_alias IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_generation_jobs_quote_token", table_name="generation_jobs")
    op.drop_index(
        "uq_generation_jobs_provider_reference_token", table_name="generation_jobs"
    )
    op.drop_constraint(
        "ck_generation_jobs_result_visible", "generation_jobs", type_="check"
    )
    op.drop_constraint(
        "ck_generation_jobs_provider_reference_type",
        "generation_jobs",
        type_="check",
    )
    op.drop_constraint(
        "ck_generation_jobs_token_kind", "generation_jobs", type_="check"
    )
    op.drop_constraint(
        "ck_generation_jobs_provider_reference_pair",
        "generation_jobs",
        type_="check",
    )
    op.drop_constraint(
        "ck_generation_jobs_child_quote", "generation_jobs", type_="check"
    )
    op.drop_constraint(
        "ck_generation_jobs_parent_shape", "generation_jobs", type_="check"
    )
    op.drop_constraint(
        "ck_generation_jobs_chargeable_status", "generation_jobs", type_="check"
    )
