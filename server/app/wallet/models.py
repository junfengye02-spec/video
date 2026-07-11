from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from server.app.db.base import Base, TimestampMixin


class WalletAccount(TimestampMixin, Base):
    __tablename__ = "wallet_accounts"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("users.id"), nullable=False
    )
    balance_units: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    held_units: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (
        UniqueConstraint("user_id", name="uq_wallet_accounts_user_id"),
        CheckConstraint("balance_units >= 0", name="ck_wallet_accounts_balance_nonnegative"),
        CheckConstraint("held_units >= 0", name="ck_wallet_accounts_held_nonnegative"),
        CheckConstraint(
            "held_units <= balance_units", name="ck_wallet_accounts_held_within_balance"
        ),
        CheckConstraint("version >= 0", name="ck_wallet_accounts_version_nonnegative"),
    )
    __mapper_args__ = {
        "version_id_col": version,
        "version_id_generator": False,
    }


class WalletEntry(Base):
    __tablename__ = "wallet_entries"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    wallet_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("wallet_accounts.id"), nullable=False
    )
    user_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("users.id"), nullable=False
    )
    amount_units: Mapped[int] = mapped_column(BigInteger, nullable=False)
    balance_after_units: Mapped[int] = mapped_column(BigInteger, nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    source_type: Mapped[str] = mapped_column(String(64), nullable=False)
    source_id: Mapped[str] = mapped_column(String(191), nullable=False)
    idempotency_key: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    __table_args__ = (
        UniqueConstraint("idempotency_key", name="uq_wallet_entries_idempotency_key"),
        CheckConstraint("amount_units <> 0", name="ck_wallet_entries_amount_nonzero"),
        CheckConstraint(
            "balance_after_units >= 0", name="ck_wallet_entries_balance_nonnegative"
        ),
        Index("ix_wallet_entries_user_created", "user_id", "created_at"),
    )


class WalletHold(TimestampMixin, Base):
    __tablename__ = "wallet_holds"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("users.id"), nullable=False
    )
    job_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("generation_jobs.id"), nullable=False
    )
    amount_units: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reason: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        UniqueConstraint("job_id", name="uq_wallet_holds_job_id"),
        CheckConstraint("amount_units > 0", name="ck_wallet_holds_amount_positive"),
        CheckConstraint(
            "status IN ('active', 'released', 'captured')",
            name="ck_wallet_holds_status",
        ),
        Index("ix_wallet_holds_user_status", "user_id", "status"),
    )
