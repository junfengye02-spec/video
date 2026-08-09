from __future__ import annotations

from urllib.parse import parse_qsl, urlencode

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field, model_validator
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
    TopupProductNotFound,
    create_epay_order,
    epay_return_result,
    get_user_order,
    list_user_orders,
    list_topup_products,
    payment_order_user_payload,
    settle_epay_notify,
)


router = APIRouter()


class CreatePaymentOrderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    amount_cny_fen: int | None = Field(default=None, strict=True, gt=0, le=10_000_000)
    product_id: str | None = Field(default=None, min_length=1, max_length=32)

    @model_validator(mode="after")
    def _require_one_payment_source(self):
        if (self.amount_cny_fen is None) == (self.product_id is None):
            raise ValueError("provide exactly one of amount_cny_fen or product_id")
        return self


PaymentStatus = Literal["pending", "paid", "expired", "failed"]


class TopupProductResponse(BaseModel):
    id: str
    title: str
    price_cny_fen: int
    credit_units: int


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
            amount_cny_fen=body.amount_cny_fen,
            product_id=body.product_id,
            settings=settings,
        )
        db.commit()
    except TopupProductNotFound as exc:
        db.rollback()
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except EpayNotConfigured as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail="payment order unavailable") from exc

    payload = payment_order_user_payload(order)
    payload.update({"action_url": action_url, "form": fields})
    return payload


@router.get("/api/topup-products", response_model=list[TopupProductResponse])
def get_topup_products(
    _current: CurrentUser = Depends(require_user),
    db: Session = Depends(get_db),
) -> list[TopupProductResponse]:
    return [
        TopupProductResponse(
            id=product.id,
            title=product.title,
            price_cny_fen=product.price_cny_fen,
            credit_units=product.credit_units,
        )
        for product in list_topup_products(db)
    ]


@router.get("/api/payment-orders")
def get_payment_orders(
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
    status: Annotated[PaymentStatus | None, Query()] = None,
    search: Annotated[str | None, Query(max_length=255)] = None,
    current: CurrentUser = Depends(require_user),
    db: Session = Depends(get_db),
) -> list[dict[str, object]]:
    try:
        orders = list_user_orders(
            db,
            user_id=current.id,
            limit=limit,
            offset=offset,
            status=status,
            search=search,
        )
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail="payment orders unavailable") from exc
    return [payment_order_user_payload(order) for order in orders]


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
    return payment_order_user_payload(order)


@router.get("/api/payments/epay/return")
async def epay_return(
    request: Request,
    db: Session = Depends(get_db),
    settings: AppSettings = Depends(get_settings),
) -> RedirectResponse:
    fields = await _read_epay_fields(request)
    state = "failed"
    order_id = None
    if fields is not None:
        try:
            state, order_id = epay_return_result(
                db, fields=fields, settings=settings
            )
        except EpayNotConfigured:
            state = "failed"
    query = {"payment": state}
    if order_id is not None:
        query["order_id"] = order_id
    location = f"{settings.public_origin.rstrip('/')}/wallet?{urlencode(query)}"
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
