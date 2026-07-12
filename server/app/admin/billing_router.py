from __future__ import annotations

from datetime import datetime, timezone
import json
from typing import Annotated, Literal
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from server.app.auth.dependencies import CurrentUser, require_admin, require_csrf
from server.app.auth.models import AdminAuditLog
from server.app.billing.models import BillingReconciliation, BillingSetting
from server.app.db.session import get_db
from server.app.payments.models import PaymentOrder, TopupProduct
from server.app.wallet.models import WalletEntry


router = APIRouter(prefix="/api/admin", tags=["admin-billing"])

LimitQuery = Annotated[int, Query(ge=1, le=200)]
PaymentStatus = Literal["pending", "paid", "expired", "failed"]
ProductStatus = Literal["enabled", "disabled"]
ReconciliationStatus = Literal["open", "resolved"]


class BillingSettingsResponse(BaseModel):
    multiplier_bps: int
    version: int
    created_at: datetime
    updated_at: datetime


class TopupProductAdminResponse(BaseModel):
    id: str
    title: str
    price_cny_fen: int
    credit_units: int
    enabled: bool
    sort_order: int
    created_at: datetime
    updated_at: datetime


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


class CreateTopupProductRequest(ReasonedRequest):
    id: str = Field(min_length=1, max_length=32)
    title: str = Field(min_length=1, max_length=255)
    price_cny_fen: int = Field(gt=0)
    credit_units: int = Field(gt=0)
    enabled: bool = True
    sort_order: int = 0

    @field_validator("id", "title")
    @classmethod
    def _strip_required_text(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("value is required")
        return stripped


class UpdateTopupProductRequest(ReasonedRequest):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    price_cny_fen: int | None = Field(default=None, gt=0)
    credit_units: int | None = Field(default=None, gt=0)
    enabled: bool | None = None
    sort_order: int | None = None

    @field_validator("title")
    @classmethod
    def _strip_optional_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            raise ValueError("title is required")
        return stripped

    @model_validator(mode="after")
    def _requires_a_change(self) -> "UpdateTopupProductRequest":
        if (
            self.title is None
            and self.price_cny_fen is None
            and self.credit_units is None
            and self.enabled is None
            and self.sort_order is None
        ):
            raise ValueError("at least one product field is required")
        return self


class DeleteTopupProductRequest(ReasonedRequest):
    pass


class DeleteTopupProductResponse(BaseModel):
    id: str
    deleted: bool
    enabled: bool


class ReconciliationRetryResponse(BaseModel):
    id: str
    status: str
    next_retry_at: datetime


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


def _product_json(product: TopupProduct) -> dict[str, object]:
    return {
        "id": product.id,
        "title": product.title,
        "price_cny_fen": product.price_cny_fen,
        "credit_units": product.credit_units,
        "enabled": product.enabled,
        "sort_order": product.sort_order,
    }


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


@router.get("/topup-products", response_model=list[TopupProductAdminResponse])
def get_admin_topup_products(
    limit: LimitQuery = 50,
    status: Annotated[ProductStatus | None, Query()] = None,
    _current: CurrentUser = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[TopupProductAdminResponse]:
    stmt = select(TopupProduct)
    if status == "enabled":
        stmt = stmt.where(TopupProduct.enabled.is_(True))
    elif status == "disabled":
        stmt = stmt.where(TopupProduct.enabled.is_(False))
    products = db.scalars(
        stmt.order_by(TopupProduct.sort_order, TopupProduct.created_at.desc()).limit(limit)
    ).all()
    return [
        TopupProductAdminResponse(
            id=product.id,
            title=product.title,
            price_cny_fen=product.price_cny_fen,
            credit_units=product.credit_units,
            enabled=product.enabled,
            sort_order=product.sort_order,
            created_at=product.created_at,
            updated_at=product.updated_at,
        )
        for product in products
    ]


@router.post(
    "/topup-products",
    response_model=TopupProductAdminResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_admin_topup_product(
    body: CreateTopupProductRequest,
    current: CurrentUser = Depends(_require_admin_csrf),
    db: Session = Depends(get_db),
) -> TopupProductAdminResponse:
    try:
        if db.get(TopupProduct, body.id) is not None:
            raise HTTPException(status_code=409, detail="topup product already exists")
        product = TopupProduct(
            id=body.id,
            title=body.title,
            price_cny_fen=body.price_cny_fen,
            credit_units=body.credit_units,
            enabled=body.enabled,
            sort_order=body.sort_order,
        )
        db.add(product)
        db.flush()
        db.add(
            _audit_log(
                actor_id=current.id,
                action="billing.product.create",
                object_type="topup_product",
                object_id=product.id,
                before=None,
                after=_product_json(product),
            )
        )
        db.commit()
        db.refresh(product)
        return _topup_product_response(product)
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail="topup product unavailable") from exc


@router.put(
    "/topup-products/{product_id}",
    response_model=TopupProductAdminResponse,
)
def update_admin_topup_product(
    product_id: str,
    body: UpdateTopupProductRequest,
    current: CurrentUser = Depends(_require_admin_csrf),
    db: Session = Depends(get_db),
) -> TopupProductAdminResponse:
    try:
        product = db.scalar(
            select(TopupProduct)
            .where(TopupProduct.id == product_id)
            .with_for_update()
        )
        if product is None:
            raise HTTPException(status_code=404, detail="topup product not found")
        before = _product_json(product)
        if body.title is not None:
            product.title = body.title
        if body.price_cny_fen is not None:
            product.price_cny_fen = body.price_cny_fen
        if body.credit_units is not None:
            product.credit_units = body.credit_units
        if body.enabled is not None:
            product.enabled = body.enabled
        if body.sort_order is not None:
            product.sort_order = body.sort_order
        db.add(
            _audit_log(
                actor_id=current.id,
                action="billing.product.update",
                object_type="topup_product",
                object_id=product.id,
                before=before,
                after=_product_json(product),
            )
        )
        db.commit()
        db.refresh(product)
        return _topup_product_response(product)
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail="topup product unavailable") from exc


@router.delete(
    "/topup-products/{product_id}",
    response_model=DeleteTopupProductResponse,
)
def delete_admin_topup_product(
    product_id: str,
    body: DeleteTopupProductRequest,
    current: CurrentUser = Depends(_require_admin_csrf),
    db: Session = Depends(get_db),
) -> DeleteTopupProductResponse:
    try:
        product = db.scalar(
            select(TopupProduct)
            .where(TopupProduct.id == product_id)
            .with_for_update()
        )
        if product is None:
            raise HTTPException(status_code=404, detail="topup product not found")
        before = _product_json(product)
        order_count = db.scalar(
            select(func.count()).select_from(PaymentOrder).where(
                PaymentOrder.product_id == product.id
            )
        )
        deleted = not bool(order_count)
        if deleted:
            db.delete(product)
            after = None
            enabled = False
        else:
            product.enabled = False
            after = _product_json(product)
            enabled = product.enabled
        db.add(
            _audit_log(
                actor_id=current.id,
                action="billing.product.delete",
                object_type="topup_product",
                object_id=product_id,
                before=before,
                after=after,
            )
        )
        db.commit()
        return DeleteTopupProductResponse(
            id=product_id,
            deleted=deleted,
            enabled=enabled,
        )
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail="topup product unavailable") from exc


def _topup_product_response(product: TopupProduct) -> TopupProductAdminResponse:
    return TopupProductAdminResponse(
        id=product.id,
        title=product.title,
        price_cny_fen=product.price_cny_fen,
        credit_units=product.credit_units,
        enabled=product.enabled,
        sort_order=product.sort_order,
        created_at=product.created_at,
        updated_at=product.updated_at,
    )


@router.get("/payment-orders", response_model=list[PaymentOrderAdminResponse])
def get_admin_payment_orders(
    limit: LimitQuery = 50,
    status: Annotated[PaymentStatus | None, Query()] = None,
    _current: CurrentUser = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[PaymentOrderAdminResponse]:
    stmt = select(PaymentOrder)
    if status is not None:
        stmt = stmt.where(PaymentOrder.status == status)
    orders = db.scalars(
        stmt.order_by(PaymentOrder.created_at.desc(), PaymentOrder.id.desc()).limit(limit)
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
        after = {"next_retry_at": _audit_datetime(row.next_retry_at)}
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
