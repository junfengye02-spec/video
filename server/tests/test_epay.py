import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import os
import re
from threading import Barrier, Event, Lock
from urllib.parse import urlencode
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import Engine, create_engine, event, func, select, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool
from starlette.requests import Request
import starlette.requests

os.environ.setdefault("AUTH_HMAC_SECRET", "x" * 32)

from server.app.auth.dependencies import CurrentUser, require_csrf, require_user
from server.app.auth.models import User
from server.app.billing.models import GenerationJob  # noqa: F401
from server.app.core.config import AppSettings
from server.app.core.config import get_settings
from server.app.db.base import Base
from server.app.db.session import get_db
from server.app.payments import epay
import server.app.payments.router as payments_router_module
from server.app.payments.epay import (
    MAX_EPAY_CALLBACK_BYTES,
    bounded_epay_fields,
    canonical_epay_string,
    parse_epay_money_to_fen,
    sign_epay,
    verify_epay,
)
from server.app.payments.models import PaymentOrder, TopupProduct
from server.app.payments.router import router as payments_router
from server.app.payments.service import (
    create_epay_order,
    expire_pending_orders,
    list_user_orders,
    payment_order_payload,
    settle_epay_notify,
)
from server.app.projects.models import ProjectRecord  # noqa: F401
from server.app.wallet.models import WalletAccount, WalletEntry
from server.app.wallet.router import router as wallet_router
from server.app.wallet.service import credit


TEST_USER = CurrentUser(
    id="u000000000000000000000000000001",
    email="epay@example.com",
    role="user",
)
OTHER_USER = CurrentUser(
    id="u000000000000000000000000000002",
    email="other-epay@example.com",
    role="user",
)


def signed_callback(order: dict[str, object], **overrides: str) -> dict[str, str]:
    fields = {
        "pid": "1001",
        "type": "alipay",
        "out_trade_no": str(order["merchant_order_no"]),
        "trade_no": "EPAY-TRADE-1",
        "name": str(order["product_title"]),
        "money": format(
            Decimal(int(order["price_cny_fen"])) / Decimal(100), ".2f"
        ),
        "trade_status": "TRADE_SUCCESS",
    }
    fields.update(overrides)
    fields["sign"] = sign_epay(fields, "merchant-secret")
    fields["sign_type"] = "MD5"
    return fields


def callback_request(
    *,
    method: str,
    query_string: bytes = b"",
    body: bytes = b"",
    headers: list[tuple[bytes, bytes]] | None = None,
) -> Request:
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.request", "body": b"", "more_body": False}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(
        {
            "type": "http",
            "method": method,
            "path": "/api/payments/epay/notify",
            "query_string": query_string,
            "headers": headers or [],
        },
        receive,
    )


@pytest.fixture
def db_session() -> Session:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as db:
        db.add_all(
            [
                User(
                    id=TEST_USER.id,
                    email=TEST_USER.email,
                    password_hash="hash",
                    role="user",
                    status="active",
                ),
                User(
                    id=OTHER_USER.id,
                    email=OTHER_USER.email,
                    password_hash="hash",
                    role="user",
                    status="active",
                ),
            ]
        )
        db.flush()
        db.add_all(
            [
                WalletAccount(
                    id="w000000000000000000000000000001",
                    user_id=TEST_USER.id,
                    balance_units=0,
                    held_units=0,
                ),
                WalletAccount(
                    id="w000000000000000000000000000002",
                    user_id=OTHER_USER.id,
                    balance_units=0,
                    held_units=0,
                ),
                TopupProduct(
                    id="tp_basic",
                    title="Starter credits",
                    price_cny_fen=1_234,
                    credit_units=50_000,
                    enabled=True,
                    sort_order=10,
                ),
                TopupProduct(
                    id="tp_disabled",
                    title="Disabled credits",
                    price_cny_fen=1,
                    credit_units=999_999,
                    enabled=False,
                    sort_order=1,
                ),
            ]
        )
        db.commit()
        yield db
    engine.dispose()


@pytest.fixture
def epay_settings() -> AppSettings:
    return AppSettings(
        _env_file=None,
        environment="test",
        auth_hmac_secret="x" * 32,
        public_origin="https://studio.example.com",
        epay_pay_address="https://pay.example.com/submit.php",
        epay_id="1001",
        epay_key="merchant-secret",
    )


@pytest.fixture
def app(db_session: Session, epay_settings: AppSettings) -> FastAPI:
    task_app = FastAPI()
    task_app.include_router(payments_router)
    task_app.include_router(wallet_router)
    task_app.dependency_overrides[get_db] = lambda: db_session
    task_app.dependency_overrides[get_settings] = lambda: epay_settings
    task_app.dependency_overrides[require_user] = lambda: TEST_USER
    task_app.dependency_overrides[require_csrf] = lambda: TEST_USER
    return task_app


@pytest.fixture
def client(app: FastAPI):
    with TestClient(app, base_url="https://studio.example.com") as test_client:
        yield test_client


@pytest.fixture
def postgres_engine() -> Engine:
    database_url = os.getenv("OPENMONTAGE_TEST_POSTGRES_URL")
    if not database_url:
        pytest.skip("OPENMONTAGE_TEST_POSTGRES_URL is not configured")

    schema_name = f"billing_task6_{uuid.uuid4().hex}"
    admin_engine = create_engine(database_url)
    engine = None
    try:
        with admin_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema_name}"'))
        engine = create_engine(
            database_url,
            connect_args={"options": f"-csearch_path={schema_name}"},
            pool_size=12,
            max_overflow=4,
        )
        Base.metadata.create_all(engine)
        yield engine
    finally:
        if engine is not None:
            engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema_name}" CASCADE'))
        admin_engine.dispose()


@pytest.fixture
def postgres_app(postgres_engine: Engine, epay_settings: AppSettings) -> FastAPI:
    task_app = FastAPI()
    task_app.include_router(payments_router)

    def request_session():
        with Session(postgres_engine, expire_on_commit=False) as db:
            yield db

    task_app.dependency_overrides[get_db] = request_session
    task_app.dependency_overrides[get_settings] = lambda: epay_settings
    return task_app


def seed_postgres_order(
    engine: Engine,
    settings: AppSettings,
    *,
    suffix: str,
    create_product: bool,
) -> dict[str, object]:
    user_id = f"u{suffix}"
    with Session(engine, expire_on_commit=False) as db:
        db.add(
            User(
                id=user_id,
                email=f"epay-{suffix}@example.com",
                password_hash="hash",
                role="user",
                status="active",
            )
        )
        db.flush()
        db.add(
            WalletAccount(
                id=f"w{suffix}",
                user_id=user_id,
                balance_units=0,
                held_units=0,
            )
        )
        if create_product:
            db.add(
                TopupProduct(
                    id="tp_postgres",
                    title="PostgreSQL credits",
                    price_cny_fen=2_500,
                    credit_units=75_000,
                    enabled=True,
                    sort_order=1,
                )
            )
        db.flush()
        order, _action_url, _fields = create_epay_order(
            db,
            user_id=user_id,
            product_id="tp_postgres",
            settings=settings,
        )
        db.commit()
        return payment_order_payload(order)


def run_concurrent_requests(count: int, operation):
    barrier = Barrier(count)

    def synchronized(index: int):
        barrier.wait(timeout=15)
        return operation(index)

    with ThreadPoolExecutor(max_workers=count) as executor:
        return list(executor.map(synchronized, range(count)))


def test_epay_signature_matches_exact_canonical_vector() -> None:
    fields = {
        "pid": "1001",
        "type": "alipay",
        "out_trade_no": "OM123",
        "money": "10.00",
        "name": "Credits",
    }

    assert canonical_epay_string(fields) == (
        "money=10.00&name=Credits&out_trade_no=OM123&pid=1001&type=alipay"
    )
    assert sign_epay(fields, "merchant-secret") == (
        "e4c7381e349055c6089e2fd57942886a"
    )


def test_epay_canonical_string_excludes_empty_and_signature_fields() -> None:
    fields = {
        "z": "last",
        "empty": "",
        "sign": "attacker-controlled",
        "sign_type": "MD5",
        "a": "first",
    }

    assert canonical_epay_string(fields) == "a=first&z=last"


def test_epay_verification_always_uses_constant_time_comparison(monkeypatch) -> None:
    comparisons: list[tuple[str, str]] = []

    def record_compare(left: str, right: str) -> bool:
        comparisons.append((left, right))
        return left == right

    monkeypatch.setattr(epay.secrets, "compare_digest", record_compare)
    signed = {"pid": "1001", "money": "10.00"}
    signed["sign"] = sign_epay(signed, "merchant-secret").upper()

    assert verify_epay(signed, "merchant-secret") is True
    assert verify_epay({"pid": "1001", "money": "10.00"}, "merchant-secret") is False
    assert len(comparisons) == 2
    assert comparisons[0][0] == comparisons[0][1]
    assert comparisons[1][0] == ""


def test_epay_money_requires_exact_bounded_two_place_decimal() -> None:
    assert parse_epay_money_to_fen("0.01") == 1
    assert parse_epay_money_to_fen("10.00") == 1_000
    assert parse_epay_money_to_fen("999999999999.99") == 99_999_999_999_999

    malformed = (
        "",
        "10",
        "10.0",
        "10.000",
        " 10.00",
        "+10.00",
        "-10.00",
        "1e1",
        "01.00",
        "0.00",
        "1000000000000.00",
    )
    assert all(parse_epay_money_to_fen(value) is None for value in malformed)


def test_epay_callback_fields_are_strictly_bounded() -> None:
    valid = [("pid", "1001"), ("money", "10.00"), ("sign", "a" * 32)]
    assert bounded_epay_fields(valid, encoded_size=64) == dict(valid)

    assert bounded_epay_fields(valid, encoded_size=4_097) is None
    assert bounded_epay_fields(valid + [("pid", "1002")], encoded_size=80) is None
    assert bounded_epay_fields([("unknown", "value")], encoded_size=20) is None
    assert bounded_epay_fields([("trade_no", "x" * 192)], encoded_size=200) is None
    assert bounded_epay_fields([("name", "line\r\nbreak")], encoded_size=20) is None


def test_oversized_get_is_rejected_before_query_params_parsing(monkeypatch) -> None:
    parsed = False

    def forbidden_query_params(*_args, **_kwargs):
        nonlocal parsed
        parsed = True
        raise AssertionError("oversized query must not be parsed")

    monkeypatch.setattr(starlette.requests, "QueryParams", forbidden_query_params)
    request = callback_request(
        method="GET",
        query_string=b"pid=1001&param=" + b"x" * MAX_EPAY_CALLBACK_BYTES,
    )

    result = asyncio.run(payments_router_module._read_epay_fields(request))

    assert result is None
    assert parsed is False


def test_actual_oversized_post_is_rejected_before_structured_parsing(
    monkeypatch,
) -> None:
    parsed = False

    async def forbidden_form(_request):
        nonlocal parsed
        parsed = True
        raise AssertionError("oversized body must not be parsed")

    monkeypatch.setattr(Request, "form", forbidden_form)
    request = callback_request(
        method="POST",
        body=b"param=" + b"x" * MAX_EPAY_CALLBACK_BYTES,
        headers=[
            (b"content-type", b"application/x-www-form-urlencoded"),
            (b"content-length", b"1"),
        ],
    )

    result = asyncio.run(payments_router_module._read_epay_fields(request))

    assert result is None
    assert parsed is False


def test_falsely_small_content_length_never_reaches_settlement(
    client: TestClient,
    monkeypatch,
) -> None:
    settled = False

    def forbidden_settlement(*_args, **_kwargs):
        nonlocal settled
        settled = True
        raise AssertionError("oversized body must not reach settlement")

    monkeypatch.setattr(
        payments_router_module,
        "settle_epay_notify",
        forbidden_settlement,
    )

    response = client.post(
        "/api/payments/epay/notify",
        content=b"param=" + b"x" * MAX_EPAY_CALLBACK_BYTES,
        headers={
            "content-type": "application/x-www-form-urlencoded",
            "content-length": "1",
        },
    )

    assert response.text == "fail"
    assert settled is False


def test_bounded_chunked_urlencoded_post_is_structurally_parsed() -> None:
    fields = [
        ("pid", "1001"),
        ("name", "Credits & more"),
        ("money", "10.00"),
        ("sign", "a" * 32),
    ]
    request = callback_request(
        method="POST",
        body=urlencode(fields).encode("ascii"),
        headers=[(b"content-type", b"application/x-www-form-urlencoded")],
    )

    result = asyncio.run(payments_router_module._read_epay_fields(request))

    assert result == dict(fields)


def test_duplicate_and_unsupported_post_forms_are_rejected() -> None:
    duplicate = callback_request(
        method="POST",
        body=b"pid=1001&pid=1002",
        headers=[(b"content-type", b"application/x-www-form-urlencoded")],
    )
    unsupported = callback_request(
        method="POST",
        body=b'{"pid":"1001"}',
        headers=[(b"content-type", b"application/json")],
    )

    duplicate_result = asyncio.run(
        payments_router_module._read_epay_fields(duplicate)
    )
    unsupported_result = asyncio.run(
        payments_router_module._read_epay_fields(unsupported)
    )

    assert duplicate_result is None
    assert unsupported_result is None


def test_epay_configuration_is_optional_complete_and_secret_safe() -> None:
    settings = AppSettings(
        _env_file=None,
        environment="test",
        auth_hmac_secret="x" * 32,
        epay_pay_address="https://pay.example.com/submit.php",
        epay_id="1001",
        epay_key="merchant-secret",
    )

    assert settings.epay_key is not None
    assert settings.epay_key.get_secret_value() == "merchant-secret"
    assert "merchant-secret" not in repr(settings)
    assert "merchant-secret" not in settings.model_dump_json()

    empty = AppSettings(
        _env_file=None,
        environment="test",
        auth_hmac_secret="x" * 32,
        epay_pay_address="",
        epay_id="",
        epay_key="",
    )
    assert (empty.epay_pay_address, empty.epay_id, empty.epay_key) == (None, None, None)

    with pytest.raises(ValidationError, match="configured together"):
        AppSettings(
            _env_file=None,
            environment="test",
            auth_hmac_secret="x" * 32,
            epay_id="1001",
        )


def assert_validation_error_hides(error: ValidationError, sentinel: str) -> None:
    surfaces = (
        str(error),
        repr(error),
        repr(error.errors()),
        error.json(),
    )
    assert all(sentinel not in surface for surface in surfaces)


def test_incomplete_epay_configuration_error_never_exposes_key() -> None:
    sentinel = "EPAY_SENTINEL_INCOMPLETE_DO_NOT_EXPOSE"

    with pytest.raises(ValidationError, match="configured together") as caught:
        AppSettings(
            _env_file=None,
            environment="test",
            auth_hmac_secret="x" * 32,
            epay_key=sentinel,
        )

    assert_validation_error_hides(caught.value, sentinel)


def test_unrelated_production_validation_error_never_exposes_epay_key() -> None:
    sentinel = "EPAY_SENTINEL_PRODUCTION_DO_NOT_EXPOSE"

    with pytest.raises(ValidationError, match="production cookies") as caught:
        AppSettings(
            _env_file=None,
            environment="production",
            database_url=(
                "postgresql+psycopg://billing:database-password@db.internal/"
                "openmontage"
            ),
            redis_url="redis://redis.internal:6379/4",
            public_origin="https://studio.example.com",
            session_cookie_secure=False,
            auth_hmac_secret="x" * 32,
            smtp_host="smtp.internal",
            smtp_from_address="billing@example.com",
            smtp_username="billing",
            smtp_password="smtp-password",
            epay_pay_address="https://pay.example.com/submit.php",
            epay_id="1001",
            epay_key=sentinel,
        )

    assert_validation_error_hides(caught.value, sentinel)


def test_create_order_snapshots_enabled_server_owned_product(
    client: TestClient, db_session: Session
) -> None:
    response = client.post("/api/payment-orders", json={"product_id": "tp_basic"})

    assert response.status_code == 201
    payload = response.json()
    assert payload["product_id"] == "tp_basic"
    assert payload["product_title"] == "Starter credits"
    assert payload["price_cny_fen"] == 1_234
    assert payload["credit_units"] == 50_000
    assert payload["status"] == "pending"
    assert payload["action_url"] == "https://pay.example.com/submit.php"
    assert payload["form"]["pid"] == "1001"
    assert payload["form"]["type"] == "alipay"
    assert payload["form"]["money"] == "12.34"
    assert payload["form"]["sign_type"] == "MD5"
    assert verify_epay(payload["form"], "merchant-secret") is True

    order = db_session.scalar(
        select(PaymentOrder).where(PaymentOrder.id == payload["id"])
    )
    assert order is not None
    assert (order.price_cny_fen, order.credit_units) == (1_234, 50_000)
    assert order.expires_at > datetime.now(timezone.utc).replace(tzinfo=None)


def test_create_order_accepts_only_enabled_product_id_and_uses_opaque_order_no(
    client: TestClient,
) -> None:
    extra = client.post(
        "/api/payment-orders",
        json={"product_id": "tp_basic", "price_cny_fen": 1},
    )
    disabled = client.post(
        "/api/payment-orders", json={"product_id": "tp_disabled"}
    )
    first = client.post("/api/payment-orders", json={"product_id": "tp_basic"})
    second = client.post("/api/payment-orders", json={"product_id": "tp_basic"})

    assert extra.status_code == 422
    assert disabled.status_code == 404
    merchant_numbers = {
        first.json()["merchant_order_no"],
        second.json()["merchant_order_no"],
    }
    assert len(merchant_numbers) == 2
    assert all(re.fullmatch(r"OM[0-9a-f]{40}", number) for number in merchant_numbers)
    assert all(TEST_USER.id not in number for number in merchant_numbers)


def test_product_and_order_reads_are_enabled_current_user_scoped_and_expire(
    client: TestClient, db_session: Session
) -> None:
    created = client.post(
        "/api/payment-orders", json={"product_id": "tp_basic"}
    ).json()
    own = db_session.get(PaymentOrder, created["id"])
    assert own is not None
    own.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    other = PaymentOrder(
        id="o000000000000000000000000000002",
        user_id=OTHER_USER.id,
        product_id="tp_basic",
        product_title="Starter credits",
        price_cny_fen=1_234,
        credit_units=50_000,
        merchant_order_no="OM" + "f" * 40,
        payment_provider="epay",
        payment_method="alipay",
        status="pending",
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=30),
    )
    db_session.add(other)
    db_session.commit()

    products = client.get("/api/topup-products")
    orders = client.get("/api/payment-orders")
    hidden = client.get(f"/api/payment-orders/{other.id}")

    assert products.status_code == 200
    assert [product["id"] for product in products.json()] == ["tp_basic"]
    assert orders.status_code == 200
    assert [order["id"] for order in orders.json()] == [own.id]
    assert orders.json()[0]["status"] == "expired"
    assert hidden.status_code == 404


def test_wallet_and_entries_are_always_current_user_scoped(
    client: TestClient, db_session: Session
) -> None:
    credit(
        db_session,
        TEST_USER.id,
        123,
        kind="topup",
        source_id="own-order",
        idempotency_key="topup:own-order",
    )
    credit(
        db_session,
        OTHER_USER.id,
        999_000,
        kind="topup",
        source_id="other-order",
        idempotency_key="topup:other-order",
    )
    db_session.commit()

    wallet = client.get("/api/wallet")
    entries = client.get("/api/wallet/entries")
    oversized = client.get("/api/wallet/entries", params={"limit": 101})

    assert wallet.status_code == 200
    assert wallet.json()["user_id"] == TEST_USER.id
    assert wallet.json()["balance_units"] == 123
    assert entries.status_code == 200
    assert [entry["user_id"] for entry in entries.json()] == [TEST_USER.id]
    assert entries.json()[0]["idempotency_key"] == "topup:own-order"
    assert oversized.status_code == 422


def test_browser_return_routes_display_state_without_crediting(
    client: TestClient, db_session: Session
) -> None:
    order = client.post(
        "/api/payment-orders", json={"product_id": "tp_basic"}
    ).json()
    valid = client.get(
        "/api/payments/epay/return",
        params=signed_callback(order),
        follow_redirects=False,
    )
    invalid_fields = signed_callback(order)
    invalid_fields["money"] = "0.01"
    invalid = client.get(
        "/api/payments/epay/return",
        params=invalid_fields,
        follow_redirects=False,
    )

    wallet = db_session.scalar(
        select(WalletAccount).where(WalletAccount.user_id == TEST_USER.id)
    )
    assert valid.status_code == 303
    assert valid.headers["location"].endswith("/recharge?payment=pending")
    assert invalid.status_code == 303
    assert invalid.headers["location"].endswith("/recharge?payment=failed")
    assert wallet is not None and wallet.balance_units == 0


def test_notify_post_settles_once_and_get_duplicate_is_success(
    client: TestClient, db_session: Session
) -> None:
    order_payload = client.post(
        "/api/payment-orders", json={"product_id": "tp_basic"}
    ).json()
    fields = signed_callback(order_payload)

    first = client.post("/api/payments/epay/notify", data=fields)
    duplicate = client.get("/api/payments/epay/notify", params=fields)

    db_session.expire_all()
    order = db_session.get(PaymentOrder, order_payload["id"])
    wallet = db_session.scalar(
        select(WalletAccount).where(WalletAccount.user_id == TEST_USER.id)
    )
    assert first.text == "success"
    assert duplicate.text == "success"
    assert order is not None
    assert (order.status, order.provider_trade_no) == ("paid", "EPAY-TRADE-1")
    assert order.paid_at is not None
    assert wallet is not None and wallet.balance_units == 50_000
    assert db_session.scalar(select(func.count(WalletEntry.id))) == 1
    entry = db_session.scalar(select(WalletEntry))
    assert entry is not None
    assert entry.idempotency_key == f"topup:{order.id}"
    assert entry.source_type == "payment_order"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("money", "0.01"),
        ("type", "wxpay"),
        ("trade_status", "WAIT_BUYER_PAY"),
        ("out_trade_no", "OM" + "0" * 40),
        ("pid", "different-merchant"),
        ("name", "Different product"),
        ("trade_no", ""),
        ("trade_no", " "),
    ],
)
def test_signed_notify_rejects_tampered_callback_fields_without_mutation(
    client: TestClient,
    db_session: Session,
    field: str,
    value: str,
) -> None:
    order_payload = client.post(
        "/api/payment-orders", json={"product_id": "tp_basic"}
    ).json()

    response = client.post(
        "/api/payments/epay/notify",
        data=signed_callback(order_payload, **{field: value}),
    )

    db_session.expire_all()
    order = db_session.get(PaymentOrder, order_payload["id"])
    wallet = db_session.scalar(
        select(WalletAccount).where(WalletAccount.user_id == TEST_USER.id)
    )
    assert response.text == "fail"
    assert order is not None and order.status == "pending"
    assert wallet is not None and wallet.balance_units == 0
    assert db_session.scalar(select(func.count(WalletEntry.id))) == 0


def test_notify_rejects_invalid_signature_and_bounded_malformed_inputs(
    client: TestClient, db_session: Session
) -> None:
    order = client.post(
        "/api/payment-orders", json={"product_id": "tp_basic"}
    ).json()
    invalid_signature = signed_callback(order)
    invalid_signature["money"] = "0.01"

    responses = [
        client.post("/api/payments/epay/notify", data=invalid_signature),
        client.post(
            "/api/payments/epay/notify",
            content=b"x" * 4_097,
            headers={"content-type": "application/x-www-form-urlencoded"},
        ),
        client.get(
            "/api/payments/epay/notify",
            params=[("pid", "1001"), ("pid", "1001")],
        ),
        client.post(
            "/api/payments/epay/notify",
            data={"unknown": "field"},
        ),
        client.post(
            "/api/payments/epay/notify",
            content=b"broken",
            headers={"content-type": "multipart/form-data"},
        ),
    ]

    assert [response.text for response in responses] == ["fail"] * 5
    assert db_session.scalar(select(func.count(WalletEntry.id))) == 0


def test_notify_rejects_order_with_tampered_payment_provider(
    client: TestClient, db_session: Session
) -> None:
    order = client.post(
        "/api/payment-orders", json={"product_id": "tp_basic"}
    ).json()
    db_session.execute(text("PRAGMA ignore_check_constraints = ON"))
    db_session.execute(
        PaymentOrder.__table__.update()
        .where(PaymentOrder.id == order["id"])
        .values(payment_provider="other")
    )
    db_session.commit()
    db_session.execute(text("PRAGMA ignore_check_constraints = OFF"))

    response = client.post(
        "/api/payments/epay/notify", data=signed_callback(order)
    )

    assert response.text == "fail"
    assert db_session.scalar(select(func.count(WalletEntry.id))) == 0


def test_provider_trade_number_cannot_settle_two_orders(
    client: TestClient, db_session: Session
) -> None:
    first = client.post(
        "/api/payment-orders", json={"product_id": "tp_basic"}
    ).json()
    second = client.post(
        "/api/payment-orders", json={"product_id": "tp_basic"}
    ).json()

    first_response = client.post(
        "/api/payments/epay/notify",
        data=signed_callback(first, trade_no="EPAY-SHARED"),
    )
    second_response = client.post(
        "/api/payments/epay/notify",
        data=signed_callback(second, trade_no="EPAY-SHARED"),
    )

    db_session.expire_all()
    first_order = db_session.get(PaymentOrder, first["id"])
    second_order = db_session.get(PaymentOrder, second["id"])
    assert (first_response.text, second_response.text) == ("success", "fail")
    assert first_order is not None and first_order.status == "paid"
    assert second_order is not None and second_order.status == "pending"
    assert db_session.scalar(select(func.count(WalletEntry.id))) == 1


def test_notify_commit_failure_returns_fail_and_rolls_back_everything(
    client: TestClient,
    db_session: Session,
    monkeypatch,
) -> None:
    order = client.post(
        "/api/payment-orders", json={"product_id": "tp_basic"}
    ).json()

    def fail_commit() -> None:
        raise RuntimeError("forced commit failure")

    monkeypatch.setattr(db_session, "commit", fail_commit)
    response = client.post(
        "/api/payments/epay/notify", data=signed_callback(order)
    )

    db_session.expire_all()
    reloaded_order = db_session.get(PaymentOrder, order["id"])
    wallet = db_session.scalar(
        select(WalletAccount).where(WalletAccount.user_id == TEST_USER.id)
    )
    assert response.text == "fail"
    assert reloaded_order is not None and reloaded_order.status == "pending"
    assert wallet is not None and wallet.balance_units == 0
    assert db_session.scalar(select(func.count(WalletEntry.id))) == 0


def test_paid_order_rejects_different_provider_trade_number_without_recredit(
    client: TestClient, db_session: Session
) -> None:
    order = client.post(
        "/api/payment-orders", json={"product_id": "tp_basic"}
    ).json()
    first = client.post(
        "/api/payments/epay/notify",
        data=signed_callback(order, trade_no="EPAY-ORIGINAL"),
    )
    tampered = client.post(
        "/api/payments/epay/notify",
        data=signed_callback(order, trade_no="EPAY-DIFFERENT"),
    )

    wallet = db_session.scalar(
        select(WalletAccount).where(WalletAccount.user_id == TEST_USER.id)
    )
    assert (first.text, tampered.text) == ("success", "fail")
    assert wallet is not None and wallet.balance_units == 50_000
    assert db_session.scalar(select(func.count(WalletEntry.id))) == 1


def test_expired_order_rejects_valid_notify_without_credit(
    client: TestClient, db_session: Session
) -> None:
    order = client.post(
        "/api/payment-orders", json={"product_id": "tp_basic"}
    ).json()
    record = db_session.get(PaymentOrder, order["id"])
    assert record is not None
    record.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db_session.commit()
    assert client.get(f"/api/payment-orders/{record.id}").json()["status"] == "expired"

    response = client.post(
        "/api/payments/epay/notify", data=signed_callback(order)
    )

    wallet = db_session.scalar(
        select(WalletAccount).where(WalletAccount.user_id == TEST_USER.id)
    )
    assert response.text == "fail"
    assert wallet is not None and wallet.balance_units == 0
    assert db_session.scalar(select(func.count(WalletEntry.id))) == 0


def test_merchant_secret_is_absent_from_payment_responses_and_openapi(
    client: TestClient, app: FastAPI
) -> None:
    response = client.post(
        "/api/payment-orders", json={"product_id": "tp_basic"}
    )
    serialized = response.text + str(app.openapi())

    assert response.status_code == 201
    assert "merchant-secret" not in serialized
    assert "epay_key" not in serialized.lower()


def test_postgres_eight_concurrent_duplicate_notifies_credit_once(
    postgres_engine: Engine,
    postgres_app: FastAPI,
    epay_settings: AppSettings,
) -> None:
    suffix = uuid.uuid4().hex[:12]
    order = seed_postgres_order(
        postgres_engine,
        epay_settings,
        suffix=suffix,
        create_product=True,
    )
    fields = signed_callback(order, trade_no="EPAY-PG-DUPLICATE")

    def post_notify(_index: int) -> str:
        with TestClient(postgres_app, raise_server_exceptions=False) as pg_client:
            return pg_client.post(
                "/api/payments/epay/notify", data=fields
            ).text

    responses = run_concurrent_requests(8, post_notify)

    with Session(postgres_engine) as db:
        wallet = db.scalar(
            select(WalletAccount).where(WalletAccount.user_id == f"u{suffix}")
        )
        settled_order = db.get(PaymentOrder, order["id"])
        assert set(responses) == {"success"}
        assert wallet is not None and wallet.balance_units == 75_000
        assert settled_order is not None and settled_order.status == "paid"
        assert db.scalar(select(func.count(WalletEntry.id))) == 1


def test_postgres_concurrent_orders_cannot_share_provider_trade_number(
    postgres_engine: Engine,
    postgres_app: FastAPI,
    epay_settings: AppSettings,
) -> None:
    first_suffix = uuid.uuid4().hex[:12]
    second_suffix = uuid.uuid4().hex[:12]
    first = seed_postgres_order(
        postgres_engine,
        epay_settings,
        suffix=first_suffix,
        create_product=True,
    )
    second = seed_postgres_order(
        postgres_engine,
        epay_settings,
        suffix=second_suffix,
        create_product=False,
    )
    orders = (first, second)
    lookup_barrier = Barrier(2)
    lookup_lock = Lock()
    lookups_remaining = 2

    def synchronize_trade_lookup(
        _conn, _cursor, statement, _parameters, _context, _many
    ) -> None:
        nonlocal lookups_remaining
        normalized = statement.lower()
        if "from payment_orders" not in normalized or "provider_trade_no" not in normalized:
            return
        if "payment_orders.id !=" not in normalized:
            return
        with lookup_lock:
            should_wait = lookups_remaining > 0
            if should_wait:
                lookups_remaining -= 1
        if should_wait:
            lookup_barrier.wait(timeout=15)

    def post_notify(index: int) -> str:
        with TestClient(postgres_app, raise_server_exceptions=False) as pg_client:
            return pg_client.post(
                "/api/payments/epay/notify",
                data=signed_callback(orders[index], trade_no="EPAY-PG-SHARED"),
            ).text

    event.listen(postgres_engine, "after_cursor_execute", synchronize_trade_lookup)
    try:
        responses = run_concurrent_requests(2, post_notify)
    finally:
        event.remove(
            postgres_engine, "after_cursor_execute", synchronize_trade_lookup
        )

    with Session(postgres_engine) as db:
        balances = db.scalars(select(WalletAccount.balance_units)).all()
        paid_count = db.scalar(
            select(func.count(PaymentOrder.id)).where(PaymentOrder.status == "paid")
        )
        assert sorted(responses) == ["fail", "success"]
        assert sorted(balances) == [0, 75_000]
        assert paid_count == 1
        assert db.scalar(select(func.count(WalletEntry.id))) == 1


def test_postgres_notify_holding_order_lock_wins_over_later_expiry_scan(
    postgres_engine: Engine,
    postgres_app: FastAPI,
    epay_settings: AppSettings,
) -> None:
    suffix = uuid.uuid4().hex[:12]
    order = seed_postgres_order(
        postgres_engine,
        epay_settings,
        suffix=suffix,
        create_product=True,
    )
    before_expiry = datetime(2035, 1, 1, tzinfo=timezone.utc)
    after_expiry = before_expiry + timedelta(seconds=2)
    with Session(postgres_engine) as db:
        record = db.get(PaymentOrder, order["id"])
        assert record is not None
        record.expires_at = before_expiry + timedelta(seconds=1)
        db.commit()

    notify_settled = Event()
    allow_notify_commit = Event()
    expiry_lock_attempted = Event()

    def record_expiry_lock_attempt(
        _conn, _cursor, statement, _parameters, _context, _many
    ) -> None:
        normalized = statement.lower()
        if (
            "from payment_orders" not in normalized
            or "payment_orders.status =" not in normalized
            or "payment_orders.expires_at <=" not in normalized
            or "for update" not in normalized
        ):
            return
        expiry_lock_attempted.set()

    def settle_notify() -> str:
        with Session(postgres_engine) as db:
            settle_epay_notify(
                db,
                fields=signed_callback(order, trade_no="EPAY-PG-EXPIRY"),
                settings=epay_settings,
                now=before_expiry,
            )
            notify_settled.set()
            assert allow_notify_commit.wait(timeout=15)
            db.commit()
            return "committed"

    def expire_orders() -> list[str]:
        with Session(postgres_engine) as db:
            expire_pending_orders(
                db,
                user_id=f"u{suffix}",
                now=after_expiry,
            )
            orders = list(
                db.scalars(
                    select(PaymentOrder).where(
                        PaymentOrder.user_id == f"u{suffix}"
                    )
                )
            )
            db.commit()
            return [item.status for item in orders]

    event.listen(
        postgres_engine,
        "before_cursor_execute",
        record_expiry_lock_attempt,
    )
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            notify_future = executor.submit(settle_notify)
            assert notify_settled.wait(timeout=15)
            expiry_future = executor.submit(expire_orders)
            assert expiry_lock_attempted.wait(timeout=15)
            assert notify_future.done() is False
            assert expiry_future.done() is False
            allow_notify_commit.set()
            notify_response = notify_future.result(timeout=15)
            expiry_statuses = expiry_future.result(timeout=15)
    finally:
        allow_notify_commit.set()
        event.remove(
            postgres_engine,
            "before_cursor_execute",
            record_expiry_lock_attempt,
        )

    with Session(postgres_engine) as db:
        settled = db.get(PaymentOrder, order["id"])
        assert notify_response == "committed"
        assert expiry_statuses == ["paid"]
        assert settled is not None and settled.status == "paid"
        assert db.scalar(select(func.count(WalletEntry.id))) == 1
