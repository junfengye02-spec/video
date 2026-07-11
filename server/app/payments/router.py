from __future__ import annotations

from urllib.parse import parse_qsl

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from starlette.responses import PlainTextResponse, RedirectResponse

from server.app.auth.dependencies import CurrentUser, require_csrf, require_user
from server.app.core.config import AppSettings, get_settings
from server.app.db.session import get_db
from server.app.payments.epay import (
    MAX_EPAY_CALLBACK_BYTES,
    bounded_epay_fields,
    valid_urlencoded_percent_escapes,
)
from server.app.payments.service import (
    EpayNotConfigured,
    PaymentOrderNotFound,
    ProductUnavailable,
    create_epay_order,
    epay_return_state,
    get_user_order,
    list_enabled_products,
    list_user_orders,
    payment_order_payload,
    settle_epay_notify,
    topup_product_payload,
)


router = APIRouter()


class CreatePaymentOrderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    product_id: str = Field(min_length=1, max_length=32)


async def _read_epay_fields(request: Request) -> dict[str, str] | None:
    if request.method == "GET":
        raw_query = request.scope.get("query_string", b"")
        raw_size = len(raw_query)
        if raw_size > MAX_EPAY_CALLBACK_BYTES:
            return None
        if not valid_urlencoded_percent_escapes(raw_query):
            return None
        return bounded_epay_fields(
            request.query_params.multi_items(), encoded_size=raw_size
        )

    if request.method != "POST":
        return None
    content_type = request.headers.get("content-type", "")
    if content_type.split(";", 1)[0].strip().lower() != (
        "application/x-www-form-urlencoded"
    ):
        return None

    content_length = request.headers.get("content-length", "")
    if content_length and not content_length.isdigit():
        return None
    if content_length and int(content_length) > MAX_EPAY_CALLBACK_BYTES:
        return None

    body = bytearray()
    try:
        async for chunk in request.stream():
            if len(body) + len(chunk) > MAX_EPAY_CALLBACK_BYTES:
                return None
            body.extend(chunk)
        raw_body = bytes(body)
        if not valid_urlencoded_percent_escapes(raw_body):
            return None
        encoded = raw_body.decode("ascii")
        items = parse_qsl(
            encoded,
            keep_blank_values=True,
            strict_parsing=True,
            encoding="utf-8",
            errors="strict",
            max_num_fields=16,
        )
    except Exception:
        return None
    return bounded_epay_fields(items, encoded_size=len(body))


@router.get("/api/topup-products")
def get_topup_products(
    _current: CurrentUser = Depends(require_user),
    db: Session = Depends(get_db),
) -> list[dict[str, object]]:
    return [topup_product_payload(product) for product in list_enabled_products(db)]


@router.post("/api/payment-orders", status_code=status.HTTP_201_CREATED)
def create_payment_order(
    body: CreatePaymentOrderRequest,
    current: CurrentUser = Depends(require_csrf),
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> dict[str, object]:
    try:
        order, action_url, fields = create_epay_order(
            db,
            user_id=current.id,
            product_id=body.product_id,
            settings=settings,
        )
        db.commit()
    except ProductUnavailable as exc:
        db.rollback()
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except EpayNotConfigured as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail="payment order unavailable") from exc

    payload = payment_order_payload(order)
    payload.update({"action_url": action_url, "form": fields})
    return payload


@router.get("/api/payment-orders")
def get_payment_orders(
    current: CurrentUser = Depends(require_user),
    db: Session = Depends(get_db),
) -> list[dict[str, object]]:
    try:
        orders = list_user_orders(db, user_id=current.id)
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail="payment orders unavailable") from exc
    return [payment_order_payload(order) for order in orders]


@router.get("/api/payment-orders/{order_id}")
def get_payment_order(
    order_id: str,
    current: CurrentUser = Depends(require_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    try:
        order = get_user_order(db, user_id=current.id, order_id=order_id)
        db.commit()
    except PaymentOrderNotFound as exc:
        db.rollback()
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail="payment order unavailable") from exc
    return payment_order_payload(order)


@router.get("/api/payments/epay/return")
async def epay_return(
    request: Request,
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> RedirectResponse:
    fields = await _read_epay_fields(request)
    state = "failed"
    if fields is not None:
        try:
            state = epay_return_state(db, fields=fields, settings=settings)
        except EpayNotConfigured:
            state = "failed"
    location = f"{settings.public_origin.rstrip('/')}/recharge?payment={state}"
    return RedirectResponse(location, status_code=status.HTTP_303_SEE_OTHER)


@router.get("/api/payments/epay/notify")
@router.post("/api/payments/epay/notify")
async def epay_notify(
    request: Request,
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> PlainTextResponse:
    fields = await _read_epay_fields(request)
    if fields is None:
        return PlainTextResponse("fail")
    try:
        settle_epay_notify(db, fields=fields, settings=settings)
        db.commit()
    except Exception:
        db.rollback()
        return PlainTextResponse("fail")
    return PlainTextResponse("success")
