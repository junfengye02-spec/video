from __future__ import annotations

from datetime import datetime, timezone
import json
from typing import Annotated, Literal
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import case, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from server.app.auth.dependencies import CurrentUser, require_admin, require_csrf
from server.app.auth.models import AdminAuditLog, User
from server.app.billing.models import BillingReconciliation, BillingSetting
from server.app.db.session import get_db
from server.app.payments.models import PaymentOrder
from server.app.wallet.models import WalletAccount, WalletEntry


router = APIRouter(prefix="/api/admin", tags=["admin-billing"])

LimitQuery = Annotated[int, Query(ge=1, le=200)]
PaymentStatus = Literal["pending", "paid", "expired", "failed"]
ReconciliationStatus = Literal["open", "resolved"]


class BillingSettingsResponse(BaseModel):
    multiplier_bps: int
    version: int
    created_at: datetime
    updated_at: datetime


class BillingSummaryResponse(BaseModel):
    gross_paid_cny_fen: int
    total_orders: int
    pending_orders: int
    paid_orders: int
    failed_orders: int
    expired_orders: int
    wallet_balance_units: int
    wallet_held_units: int
    wallet_available_units: int


class PaymentOrderAdminResponse(BaseModel):
    id: str
    user_id: str
    product_id: str
    product_title: str
    price_cny_fen: int
    credit_units: int
    merchant_order_no_masked: str
    status: str
    expires_at: datetime
    paid_at: datetime | None
    created_at: datetime
    updated_at: datetime


class WalletEntryAdminResponse(BaseModel):
    id: str
    wallet_id: str
    user_id: str
    amount_units: int
    balance_after_units: int
    kind: str
    source_type: str
    source_id: str
    created_at: datetime


class AdminUserWalletResponse(BaseModel):
    id: str
    email: str
    role: str
    status: str
    wallet_id: str | None
    balance_units: int
    held_units: int
    available_units: int
    created_at: datetime


class BillingReconciliationAdminResponse(BaseModel):
    id: str
    job_id: str
    kind: str
    status: str
    attempts: int
    last_error_code: str | None
    next_retry_at: datetime | None
    created_at: datetime
    updated_at: datetime


class ReasonedRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(min_length=1, max_length=500)

    @field_validator("reason")
    @classmethod
    def _strip_reason(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("reason is required")
        return stripped


class UpdateBillingSettingsRequest(ReasonedRequest):
    multiplier_bps: int = Field(ge=10_000, le=100_000)


class AdjustWalletBalanceRequest(ReasonedRequest):
    amount_units: int = Field(
        strict=True,
        ge=-9_000_000_000_000_000,
        le=9_000_000_000_000_000,
    )
    request_id: str = Field(
        min_length=16,
        max_length=64,
        pattern=r"^[A-Za-z0-9_-]+$",
    )

    @field_validator("amount_units")
    @classmethod
    def _require_nonzero_amount(cls, value: int) -> int:
        if value == 0:
            raise ValueError("amount_units must not be zero")
        return value


class WalletBalanceAdjustmentResponse(AdminUserWalletResponse):
    entry_id: str
    adjustment_amount_units: int


class ReconciliationRetryResponse(BaseModel):
    id: str
    status: str
    next_retry_at: datetime


class RetryReconciliationRequest(ReasonedRequest):
    pass


def _require_admin_csrf(current: CurrentUser = Depends(require_csrf)) -> CurrentUser:
    if current.role != "admin":
        raise HTTPException(status_code=403, detail="Administrator access required")
    return current


def _mask_merchant_order_no(value: str) -> str:
    suffix = value[-4:] if len(value) >= 4 else value
    return f"****{suffix}"


def _last_error_code(value: str | None) -> str | None:
    if not value:
        return None
    head = value.split(":", 1)[0].strip()
    safe = "".join(char for char in head if char.isalnum() or char in "._-")
    return safe[:64] or "error"


def _compact_json(value: dict[str, object]) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _audit_datetime(value: datetime | None) -> str | None:
    return None if value is None else value.isoformat()


def _audit_log(
    *,
    actor_id: str,
    action: str,
    object_type: str,
    object_id: str,
    before: dict[str, object] | None,
    after: dict[str, object] | None,
) -> AdminAuditLog:
    return AdminAuditLog(
        id=uuid.uuid4().hex,
        admin_user_id=actor_id,
        action=action,
        object_type=object_type,
        object_id=object_id,
        before_json=None if before is None else _compact_json(before),
        after_json=None if after is None else _compact_json(after),
        ip_address=None,
    )


def _admin_user_wallet_response(
    user: User,
    wallet: WalletAccount | None,
) -> AdminUserWalletResponse:
    balance_units = wallet.balance_units if wallet is not None else 0
    held_units = wallet.held_units if wallet is not None else 0
    return AdminUserWalletResponse(
        id=user.id,
        email=user.email,
        role=user.role,
        status=user.status,
        wallet_id=wallet.id if wallet is not None else None,
        balance_units=balance_units,
        held_units=held_units,
        available_units=balance_units - held_units,
        created_at=user.created_at,
    )


@router.get("/billing/settings", response_model=BillingSettingsResponse)
def get_billing_settings(
    _current: CurrentUser = Depends(require_admin),
    db: Session = Depends(get_db),
) -> BillingSettingsResponse:
    settings = db.get(BillingSetting, 1)
    if settings is None:
        raise HTTPException(status_code=404, detail="billing settings not found")
    return BillingSettingsResponse(
        multiplier_bps=settings.multiplier_bps,
        version=settings.version,
        created_at=settings.created_at,
        updated_at=settings.updated_at,
    )


@router.get("/billing/summary", response_model=BillingSummaryResponse)
def get_billing_summary(
    _current: CurrentUser = Depends(require_admin),
    db: Session = Depends(get_db),
) -> BillingSummaryResponse:
    order_rows = db.execute(
        select(
            func.count(PaymentOrder.id),
            func.coalesce(
                func.sum(
                    case(
                        (PaymentOrder.status == "paid", PaymentOrder.price_cny_fen),
                        else_=0,
                    )
                ),
                0,
            ),
            func.coalesce(func.sum(case((PaymentOrder.status == "pending", 1), else_=0)), 0),
            func.coalesce(func.sum(case((PaymentOrder.status == "paid", 1), else_=0)), 0),
            func.coalesce(func.sum(case((PaymentOrder.status == "failed", 1), else_=0)), 0),
            func.coalesce(func.sum(case((PaymentOrder.status == "expired", 1), else_=0)), 0),
        )
    ).one()
    wallet_row = db.execute(
        select(
            func.coalesce(func.sum(WalletAccount.balance_units), 0),
            func.coalesce(func.sum(WalletAccount.held_units), 0),
        )
    ).one()
    balance_units = int(wallet_row[0])
    held_units = int(wallet_row[1])
    return BillingSummaryResponse(
        total_orders=int(order_rows[0]),
        gross_paid_cny_fen=int(order_rows[1]),
        pending_orders=int(order_rows[2]),
        paid_orders=int(order_rows[3]),
        failed_orders=int(order_rows[4]),
        expired_orders=int(order_rows[5]),
        wallet_balance_units=balance_units,
        wallet_held_units=held_units,
        wallet_available_units=balance_units - held_units,
    )


@router.put("/billing/settings", response_model=BillingSettingsResponse)
def update_billing_settings(
    body: UpdateBillingSettingsRequest,
    current: CurrentUser = Depends(_require_admin_csrf),
    db: Session = Depends(get_db),
) -> BillingSettingsResponse:
    try:
        settings = db.scalar(
            select(BillingSetting).where(BillingSetting.id == 1).with_for_update()
        )
        if settings is None:
            raise HTTPException(status_code=404, detail="billing settings not found")
        before = {"multiplier_bps": settings.multiplier_bps}
        settings.multiplier_bps = body.multiplier_bps
        settings.version += 1
        after = {"multiplier_bps": settings.multiplier_bps}
        db.add(
            _audit_log(
                actor_id=current.id,
                action="billing.multiplier.update",
                object_type="billing_setting",
                object_id="1",
                before=before,
                after=after,
            )
        )
        db.commit()
        db.refresh(settings)
        return BillingSettingsResponse(
            multiplier_bps=settings.multiplier_bps,
            version=settings.version,
            created_at=settings.created_at,
            updated_at=settings.updated_at,
        )
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(
            status_code=503, detail="billing settings unavailable"
        ) from exc


@router.get("/users", response_model=list[AdminUserWalletResponse])
def get_admin_users(
    limit: LimitQuery = 100,
    search: Annotated[str | None, Query(max_length=320)] = None,
    _current: CurrentUser = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[AdminUserWalletResponse]:
    stmt = select(User, WalletAccount).outerjoin(
        WalletAccount, WalletAccount.user_id == User.id
    )
    normalized_search = search.strip().lower() if search is not None else ""
    if normalized_search:
        stmt = stmt.where(
            func.lower(User.email).contains(normalized_search, autoescape=True)
        )
    rows = db.execute(
        stmt.order_by(User.created_at.desc(), User.id.desc()).limit(limit)
    ).all()
    return [_admin_user_wallet_response(user, wallet) for user, wallet in rows]


@router.post(
    "/users/{user_id}/balance-adjustments",
    response_model=WalletBalanceAdjustmentResponse,
)
def adjust_admin_user_balance(
    user_id: str,
    body: AdjustWalletBalanceRequest,
    current: CurrentUser = Depends(_require_admin_csrf),
    db: Session = Depends(get_db),
) -> WalletBalanceAdjustmentResponse:
    idempotency_key = f"admin-adjust:{body.request_id}"
    try:
        existing = db.scalar(
            select(WalletEntry).where(
                WalletEntry.idempotency_key == idempotency_key
            )
        )
        if existing is not None:
            if (
                existing.user_id != user_id
                or existing.amount_units != body.amount_units
                or existing.source_type != "admin_adjustment"
            ):
                raise HTTPException(
                    status_code=409,
                    detail="adjustment request conflicts with an existing entry",
                )
            user = db.get(User, user_id)
            wallet = db.scalar(
                select(WalletAccount).where(WalletAccount.user_id == user_id)
            )
            if user is None or wallet is None:
                raise HTTPException(status_code=404, detail="user wallet not found")
            response = _admin_user_wallet_response(user, wallet)
            return WalletBalanceAdjustmentResponse(
                **response.model_dump(),
                entry_id=existing.id,
                adjustment_amount_units=existing.amount_units,
            )

        user = db.get(User, user_id)
        wallet = db.scalar(
            select(WalletAccount)
            .where(WalletAccount.user_id == user_id)
            .with_for_update()
        )
        if user is None or wallet is None:
            raise HTTPException(status_code=404, detail="user wallet not found")

        next_balance = wallet.balance_units + body.amount_units
        if next_balance < wallet.held_units:
            raise HTTPException(
                status_code=409,
                detail="adjustment would reduce balance below held units",
            )

        entry = WalletEntry(
            id=uuid.uuid4().hex,
            wallet_id=wallet.id,
            user_id=user.id,
            amount_units=body.amount_units,
            balance_after_units=next_balance,
            kind="admin_credit" if body.amount_units > 0 else "admin_debit",
            source_type="admin_adjustment",
            source_id=body.request_id,
            idempotency_key=idempotency_key,
        )
        before = {
            "balance_units": wallet.balance_units,
            "held_units": wallet.held_units,
        }
        wallet.balance_units = next_balance
        after = {
            "amount_units": body.amount_units,
            "balance_units": next_balance,
            "entry_id": entry.id,
            "held_units": wallet.held_units,
            "reason": body.reason,
            "user_id": user.id,
        }
        db.add(entry)
        db.add(
            _audit_log(
                actor_id=current.id,
                action="wallet.balance.adjust",
                object_type="wallet_account",
                object_id=wallet.id,
                before=before,
                after=after,
            )
        )
        db.commit()
        db.refresh(wallet)
        response = _admin_user_wallet_response(user, wallet)
        return WalletBalanceAdjustmentResponse(
            **response.model_dump(),
            entry_id=entry.id,
            adjustment_amount_units=entry.amount_units,
        )
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail="user wallet unavailable") from exc


@router.get("/payment-orders", response_model=list[PaymentOrderAdminResponse])
def get_admin_payment_orders(
    limit: LimitQuery = 50,
    offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
    status: Annotated[PaymentStatus | None, Query()] = None,
    search: Annotated[str | None, Query(max_length=255)] = None,
    _current: CurrentUser = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[PaymentOrderAdminResponse]:
    stmt = select(PaymentOrder)
    if status is not None:
        stmt = stmt.where(PaymentOrder.status == status)
    normalized_search = search.strip().lower() if search is not None else ""
    if normalized_search:
        stmt = stmt.where(
            func.lower(PaymentOrder.product_title).contains(
                normalized_search,
                autoescape=True,
            )
        )
    orders = db.scalars(
        stmt.order_by(PaymentOrder.created_at.desc(), PaymentOrder.id.desc())
        .offset(offset)
        .limit(limit)
    ).all()
    return [
        PaymentOrderAdminResponse(
            id=order.id,
            user_id=order.user_id,
            product_id=order.product_id,
            product_title=order.product_title,
            price_cny_fen=order.price_cny_fen,
            credit_units=order.credit_units,
            merchant_order_no_masked=_mask_merchant_order_no(order.merchant_order_no),
            status=order.status,
            expires_at=order.expires_at,
            paid_at=order.paid_at,
            created_at=order.created_at,
            updated_at=order.updated_at,
        )
        for order in orders
    ]


@router.get("/wallet-entries", response_model=list[WalletEntryAdminResponse])
def get_admin_wallet_entries(
    limit: LimitQuery = 50,
    kind: Annotated[str | None, Query(min_length=1, max_length=32)] = None,
    _current: CurrentUser = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[WalletEntryAdminResponse]:
    stmt = select(WalletEntry)
    if kind is not None:
        stmt = stmt.where(WalletEntry.kind == kind)
    entries = db.scalars(
        stmt.order_by(WalletEntry.created_at.desc(), WalletEntry.id.desc()).limit(limit)
    ).all()
    return [
        WalletEntryAdminResponse(
            id=entry.id,
            wallet_id=entry.wallet_id,
            user_id=entry.user_id,
            amount_units=entry.amount_units,
            balance_after_units=entry.balance_after_units,
            kind=entry.kind,
            source_type=entry.source_type,
            source_id=entry.source_id,
            created_at=entry.created_at,
        )
        for entry in entries
    ]


@router.get(
    "/billing-reconciliations",
    response_model=list[BillingReconciliationAdminResponse],
)
def get_admin_billing_reconciliations(
    limit: LimitQuery = 50,
    status: Annotated[ReconciliationStatus | None, Query()] = None,
    _current: CurrentUser = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[BillingReconciliationAdminResponse]:
    stmt = select(BillingReconciliation)
    if status is not None:
        stmt = stmt.where(BillingReconciliation.status == status)
    rows = db.scalars(
        stmt.order_by(
            BillingReconciliation.created_at.desc(),
            BillingReconciliation.id.desc(),
        ).limit(limit)
    ).all()
    return [
        BillingReconciliationAdminResponse(
            id=row.id,
            job_id=row.job_id,
            kind=row.reason,
            status=row.status,
            attempts=row.attempts,
            last_error_code=_last_error_code(row.last_error),
            next_retry_at=row.next_retry_at,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )
        for row in rows
    ]


@router.post(
    "/billing-reconciliations/{reconciliation_id}/retry",
    response_model=ReconciliationRetryResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
def retry_admin_billing_reconciliation(
    reconciliation_id: str,
    body: RetryReconciliationRequest,
    current: CurrentUser = Depends(_require_admin_csrf),
    db: Session = Depends(get_db),
) -> ReconciliationRetryResponse:
    try:
        row = db.scalar(
            select(BillingReconciliation)
            .where(BillingReconciliation.id == reconciliation_id)
            .with_for_update()
        )
        if row is None:
            raise HTTPException(status_code=404, detail="reconciliation not found")
        if row.status != "open":
            raise HTTPException(status_code=409, detail="reconciliation is closed")
        before = {"next_retry_at": _audit_datetime(row.next_retry_at)}
        row.next_retry_at = datetime.now(timezone.utc)
        after = {
            "next_retry_at": _audit_datetime(row.next_retry_at),
            "reason": body.reason,
        }
        db.add(
            _audit_log(
                actor_id=current.id,
                action="billing.reconciliation.retry",
                object_type="billing_reconciliation",
                object_id=row.id,
                before=before,
                after=after,
            )
        )
        db.commit()
        db.refresh(row)
        retry_at = row.next_retry_at
        if retry_at is None:
            raise HTTPException(status_code=503, detail="reconciliation unavailable")
        return ReconciliationRetryResponse(
            id=row.id,
            status=row.status,
            next_retry_at=retry_at,
        )
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(
            status_code=503, detail="reconciliation unavailable"
        ) from exc
