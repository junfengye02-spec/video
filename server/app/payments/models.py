from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from server.app.db.base import Base, TimestampMixin


class TopupProduct(TimestampMixin, Base):
    __tablename__ = "topup_products"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    price_cny_fen: Mapped[int] = mapped_column(BigInteger, nullable=False)
    credit_units: Mapped[int] = mapped_column(BigInteger, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (
        CheckConstraint("price_cny_fen > 0", name="ck_topup_products_price_positive"),
        CheckConstraint("credit_units > 0", name="ck_topup_products_credits_positive"),
    )


class PaymentOrder(TimestampMixin, Base):
    __tablename__ = "payment_orders"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String(32), ForeignKey("users.id"), nullable=False
    )
    product_id: Mapped[str] = mapped_column(String(32), nullable=False)
    product_title: Mapped[str] = mapped_column(String(255), nullable=False)
    price_cny_fen: Mapped[int] = mapped_column(BigInteger, nullable=False)
    credit_units: Mapped[int] = mapped_column(BigInteger, nullable=False)
    merchant_order_no: Mapped[str] = mapped_column(String(64), nullable=False)
    payment_provider: Mapped[str] = mapped_column(
        String(16), nullable=False, default="epay"
    )
    payment_method: Mapped[str] = mapped_column(
        String(16), nullable=False, default="alipay"
    )
    provider_trade_no: Mapped[str | None] = mapped_column(String(191))
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("merchant_order_no", name="uq_payment_orders_merchant_order_no"),
        UniqueConstraint("provider_trade_no", name="uq_payment_orders_provider_trade_no"),
        CheckConstraint("price_cny_fen > 0", name="ck_payment_orders_price_positive"),
        CheckConstraint("credit_units > 0", name="ck_payment_orders_credits_positive"),
        CheckConstraint("payment_provider = 'epay'", name="ck_payment_orders_provider"),
        CheckConstraint("payment_method = 'alipay'", name="ck_payment_orders_method"),
        CheckConstraint(
            "status IN ('pending', 'paid', 'expired', 'failed')",
            name="ck_payment_orders_status",
        ),
        Index("ix_payment_orders_user_created", "user_id", "created_at"),
        Index("ix_payment_orders_status_expires", "status", "expires_at"),
    )
