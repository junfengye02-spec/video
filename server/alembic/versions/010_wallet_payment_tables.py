"""Create wallet and payment tables.

Revision ID: 010
Revises: 003
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "010"
down_revision: str | None = "003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "wallet_accounts",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("balance_units", sa.BigInteger(), nullable=False),
        sa.Column("held_units", sa.BigInteger(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "balance_units >= 0", name="ck_wallet_accounts_balance_nonnegative"
        ),
        sa.CheckConstraint(
            "held_units >= 0", name="ck_wallet_accounts_held_nonnegative"
        ),
        sa.CheckConstraint(
            "held_units <= balance_units",
            name="ck_wallet_accounts_held_within_balance",
        ),
        sa.CheckConstraint(
            "version >= 0", name="ck_wallet_accounts_version_nonnegative"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", name="uq_wallet_accounts_user_id"),
    )

    op.create_table(
        "topup_products",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("price_cny_fen", sa.BigInteger(), nullable=False),
        sa.Column("credit_units", sa.BigInteger(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "price_cny_fen > 0", name="ck_topup_products_price_positive"
        ),
        sa.CheckConstraint(
            "credit_units > 0", name="ck_topup_products_credits_positive"
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "wallet_entries",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("wallet_id", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("amount_units", sa.BigInteger(), nullable=False),
        sa.Column("balance_after_units", sa.BigInteger(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("source_type", sa.String(length=64), nullable=False),
        sa.Column("source_id", sa.String(length=191), nullable=False),
        sa.Column("idempotency_key", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "amount_units <> 0", name="ck_wallet_entries_amount_nonzero"
        ),
        sa.CheckConstraint(
            "balance_after_units >= 0",
            name="ck_wallet_entries_balance_nonnegative",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["wallet_id"], ["wallet_accounts.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "idempotency_key", name="uq_wallet_entries_idempotency_key"
        ),
    )
    op.create_index(
        "ix_wallet_entries_user_created",
        "wallet_entries",
        ["user_id", "created_at"],
        unique=False,
    )
    op.execute(
        """
        CREATE FUNCTION wallet_entries_reject_mutation()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $wallet_entries_append_only$
        BEGIN
            RAISE EXCEPTION 'wallet entries are append-only'
                USING ERRCODE = '55000';
            RETURN NULL;
        END;
        $wallet_entries_append_only$
        """
    )
    op.execute(
        """
        CREATE TRIGGER wallet_entries_append_only
        BEFORE UPDATE OR DELETE ON wallet_entries
        FOR EACH ROW EXECUTE FUNCTION wallet_entries_reject_mutation()
        """
    )

    op.create_table(
        "payment_orders",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("product_id", sa.String(length=32), nullable=False),
        sa.Column("product_title", sa.String(length=255), nullable=False),
        sa.Column("price_cny_fen", sa.BigInteger(), nullable=False),
        sa.Column("credit_units", sa.BigInteger(), nullable=False),
        sa.Column("merchant_order_no", sa.String(length=64), nullable=False),
        sa.Column("payment_provider", sa.String(length=16), nullable=False),
        sa.Column("payment_method", sa.String(length=16), nullable=False),
        sa.Column("provider_trade_no", sa.String(length=191), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "price_cny_fen > 0", name="ck_payment_orders_price_positive"
        ),
        sa.CheckConstraint(
            "credit_units > 0", name="ck_payment_orders_credits_positive"
        ),
        sa.CheckConstraint(
            "payment_provider = 'epay'", name="ck_payment_orders_provider"
        ),
        sa.CheckConstraint(
            "payment_method = 'alipay'", name="ck_payment_orders_method"
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'paid', 'expired', 'failed')",
            name="ck_payment_orders_status",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "merchant_order_no", name="uq_payment_orders_merchant_order_no"
        ),
        sa.UniqueConstraint(
            "provider_trade_no", name="uq_payment_orders_provider_trade_no"
        ),
    )
    op.create_index(
        "ix_payment_orders_status_expires",
        "payment_orders",
        ["status", "expires_at"],
        unique=False,
    )
    op.create_index(
        "ix_payment_orders_user_created",
        "payment_orders",
        ["user_id", "created_at"],
        unique=False,
    )

    op.create_table(
        "wallet_holds",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("job_id", sa.String(length=32), nullable=False),
        sa.Column(
            "job_chargeable",
            sa.Boolean(),
            server_default=sa.true(),
            nullable=False,
        ),
        sa.Column("amount_units", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint(
            "amount_units > 0", name="ck_wallet_holds_amount_positive"
        ),
        sa.CheckConstraint(
            "job_chargeable = true", name="ck_wallet_holds_job_chargeable"
        ),
        sa.CheckConstraint(
            "status IN ('active', 'released', 'captured')",
            name="ck_wallet_holds_status",
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_id", name="uq_wallet_holds_job_id"),
    )
    op.create_index(
        "ix_wallet_holds_user_status",
        "wallet_holds",
        ["user_id", "status"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_wallet_holds_user_status", table_name="wallet_holds")
    op.drop_table("wallet_holds")
    op.drop_index("ix_payment_orders_user_created", table_name="payment_orders")
    op.drop_index("ix_payment_orders_status_expires", table_name="payment_orders")
    op.drop_table("payment_orders")
    op.execute("DROP TRIGGER IF EXISTS wallet_entries_append_only ON wallet_entries")
    op.execute("DROP FUNCTION IF EXISTS wallet_entries_reject_mutation()")
    op.drop_index("ix_wallet_entries_user_created", table_name="wallet_entries")
    op.drop_table("wallet_entries")
    op.drop_table("topup_products")
    op.drop_table("wallet_accounts")
