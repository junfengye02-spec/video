from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from server.app.core.config import AppSettings
from server.app.payments.epay import parse_epay_money_to_fen, sign_epay, verify_epay
from server.app.payments.models import PaymentOrder
from server.app.wallet.service import credit


CREDIT_UNITS_PER_CNY_FEN = 10_000
LEGACY_DIRECT_TOPUP_PRODUCT_ID = "direct"
DIRECT_TOPUP_DESCRIPTION = "Balance top-up"


class EpayNotConfigured(RuntimeError):
    pass


class PaymentOrderNotFound(RuntimeError):
    pass


class InvalidEpayNotify(RuntimeError):
    pass


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _money_from_fen(price_cny_fen: int) -> str:
    return format(Decimal(price_cny_fen) / Decimal(100), ".2f")


def _epay_credentials(settings: AppSettings) -> tuple[str, str, str]:
    if (
        settings.epay_pay_address is None
        or settings.epay_id is None
        or settings.epay_key is None
    ):
        raise EpayNotConfigured("EPay is not configured")
    return (
        settings.epay_pay_address,
        settings.epay_id,
        settings.epay_key.get_secret_value(),
    )


def _valid_provider_trade_no(value: str | None) -> bool:
    return value is not None and bool(value) and value == value.strip()


def create_epay_order(
    db: Session,
    *,
    user_id: str,
    amount_cny_fen: int,
    settings: AppSettings,
    now: datetime | None = None,
) -> tuple[PaymentOrder, str, dict[str, str]]:
    action_url, merchant_id, merchant_key = _epay_credentials(settings)

    created_at = now or utcnow()
    order = PaymentOrder(
        id=uuid.uuid4().hex,
        user_id=user_id,
        # Keep deployed snapshot columns populated for schema compatibility.
        product_id=LEGACY_DIRECT_TOPUP_PRODUCT_ID,
        product_title=DIRECT_TOPUP_DESCRIPTION,
        price_cny_fen=amount_cny_fen,
        credit_units=amount_cny_fen * CREDIT_UNITS_PER_CNY_FEN,
        merchant_order_no=f"OM{secrets.token_hex(20)}",
        payment_provider="epay",
        payment_method="alipay",
        status="pending",
        expires_at=created_at + timedelta(minutes=30),
    )
    db.add(order)
    db.flush()

    callback_origin = settings.public_origin.rstrip("/")
    fields = {
        "pid": merchant_id,
        "type": "alipay",
        "out_trade_no": order.merchant_order_no,
        "notify_url": f"{callback_origin}/api/payments/epay/notify",
        "return_url": f"{callback_origin}/api/payments/epay/return",
        "name": order.product_title,
        "money": _money_from_fen(order.price_cny_fen),
        "device": "pc",
    }
    fields["sign"] = sign_epay(fields, merchant_key)
    fields["sign_type"] = "MD5"
    return order, action_url, fields


def payment_order_payload(order: PaymentOrder) -> dict[str, object]:
    return {
        "id": order.id,
        "user_id": order.user_id,
        "product_id": order.product_id,
        "product_title": order.product_title,
        "price_cny_fen": order.price_cny_fen,
        "credit_units": order.credit_units,
        "merchant_order_no": order.merchant_order_no,
        "payment_provider": order.payment_provider,
        "payment_method": order.payment_method,
        "provider_trade_no": order.provider_trade_no,
        "status": order.status,
        "expires_at": order.expires_at,
        "paid_at": order.paid_at,
        "created_at": order.created_at,
        "updated_at": order.updated_at,
    }


def expire_pending_orders(
    db: Session, *, user_id: str, now: datetime | None = None
) -> None:
    cutoff = now or utcnow()
    expired = db.scalars(
        select(PaymentOrder)
        .where(
            PaymentOrder.user_id == user_id,
            PaymentOrder.status == "pending",
            PaymentOrder.expires_at <= cutoff,
        )
        .order_by(PaymentOrder.id)
        .with_for_update()
    )
    for order in expired:
        order.status = "expired"
    db.flush()


def list_user_orders(db: Session, *, user_id: str) -> list[PaymentOrder]:
    expire_pending_orders(db, user_id=user_id)
    return list(
        db.scalars(
            select(PaymentOrder)
            .where(PaymentOrder.user_id == user_id)
            .order_by(PaymentOrder.created_at.desc(), PaymentOrder.id.desc())
        )
    )


def get_user_order(db: Session, *, user_id: str, order_id: str) -> PaymentOrder:
    expire_pending_orders(db, user_id=user_id)
    order = db.scalar(
        select(PaymentOrder).where(
            PaymentOrder.id == order_id,
            PaymentOrder.user_id == user_id,
        )
    )
    if order is None:
        raise PaymentOrderNotFound("payment order not found")
    return order


def epay_return_state(
    db: Session, *, fields: dict[str, str], settings: AppSettings
) -> str:
    _action_url, merchant_id, merchant_key = _epay_credentials(settings)
    if not verify_epay(fields, merchant_key):
        return "failed"
    if (
        fields.get("pid") != merchant_id
        or fields.get("type") != "alipay"
        or fields.get("trade_status") != "TRADE_SUCCESS"
        or fields.get("sign_type") != "MD5"
        or not _valid_provider_trade_no(fields.get("trade_no"))
    ):
        return "failed"

    order = db.scalar(
        select(PaymentOrder).where(
            PaymentOrder.merchant_order_no == fields.get("out_trade_no", "")
        )
    )
    if (
        order is None
        or order.payment_provider != "epay"
        or order.payment_method != "alipay"
        or order.product_title != fields.get("name")
        or parse_epay_money_to_fen(fields.get("money", ""))
        != order.price_cny_fen
    ):
        return "failed"
    return order.status if order.status in {"pending", "paid"} else "failed"


def _is_expired(order: PaymentOrder, now: datetime) -> bool:
    expires_at = order.expires_at
    if expires_at.tzinfo is None:
        now = now.replace(tzinfo=None)
    return expires_at <= now


def settle_epay_notify(
    db: Session,
    *,
    fields: dict[str, str],
    settings: AppSettings,
    now: datetime | None = None,
) -> None:
    _action_url, merchant_id, merchant_key = _epay_credentials(settings)
    if not verify_epay(fields, merchant_key):
        raise InvalidEpayNotify("invalid signature")
    if (
        fields.get("pid") != merchant_id
        or fields.get("type") != "alipay"
        or fields.get("trade_status") != "TRADE_SUCCESS"
        or fields.get("sign_type") != "MD5"
        or not _valid_provider_trade_no(fields.get("trade_no"))
    ):
        raise InvalidEpayNotify("invalid callback fields")

    order = db.scalar(
        select(PaymentOrder)
        .where(
            PaymentOrder.merchant_order_no == fields.get("out_trade_no", "")
        )
        .with_for_update()
    )
    if (
        order is None
        or order.payment_provider != "epay"
        or order.payment_method != "alipay"
        or order.product_title != fields.get("name")
        or parse_epay_money_to_fen(fields.get("money", ""))
        != order.price_cny_fen
    ):
        raise InvalidEpayNotify("callback does not match payment order")

    provider_trade_no = fields["trade_no"]
    if order.status == "paid":
        if order.provider_trade_no != provider_trade_no:
            raise InvalidEpayNotify("paid order trade number mismatch")
        return
    if order.status != "pending" or _is_expired(order, now or utcnow()):
        raise InvalidEpayNotify("payment order is not payable")

    trade_owner = db.scalar(
        select(PaymentOrder).where(
            PaymentOrder.provider_trade_no == provider_trade_no,
            PaymentOrder.id != order.id,
        )
    )
    if trade_owner is not None:
        raise InvalidEpayNotify("provider trade number already used")

    credit(
        db,
        order.user_id,
        order.credit_units,
        kind="topup",
        source_id=order.id,
        idempotency_key=f"topup:{order.id}",
    )
    order.provider_trade_no = provider_trade_no
    order.status = "paid"
    order.paid_at = now or utcnow()
    db.flush()
