from __future__ import annotations

import json
import re
from dataclasses import FrozenInstanceError
from decimal import Decimal
from pathlib import Path
from typing import Callable

import httpx
import pytest
from pydantic import SecretStr, ValidationError

import server.app.provider.newapi as newapi
from server.app.billing.money import provider_micro_to_charge_units
from server.app.core.config import AppSettings
from server.app.provider.newapi import (
    AmbiguousNewApiResult,
    InvalidNewApiResponse,
    NewApiClient,
    NewApiCallError,
    NewApiRateLimited,
    PreparedNewApiRequest,
    ProviderTaskNotFound,
    QuoteNotFound,
    QuoteStale,
    QuotedExecutionResult,
    TokenScopedQuote,
    UsageQuote,
    UsageQuoteStatus,
    UsageReceipt,
    VideoTaskStatus,
    ReceiptNotFound,
)


QUOTE_ID = "uq_" + "A" * 32
TASK_ID = "task_" + "B" * 32
REQUEST_ID = "20260712123456000000000deadbeefABC12345"
OTHER_TASK_ID = "task_" + "C" * 32
OTHER_REQUEST_ID = "20260712123456000000001deadbeefABC12345"
QUOTE = {
    "quote_id": QUOTE_ID,
    "status": "quoted",
    "model": "video-model",
    "fixed_group": "openmontage-video",
    "relay_format": "task",
    "estimated_quota": 1_449_000,
    "quota_per_unit": 500000.5,
    "cost_currency": "USD",
    "estimated_cost_amount_micro": 2_898_001,
    "pricing_version": "sha256:pricing",
    "billing_fingerprint": "sha256:fingerprint",
    "other_ratios": {"seconds": 10, "resolution": 1.5},
    "expires_at": 1_783_390_000,
}
ROOT_DIR = Path(__file__).resolve().parents[2]


class SequenceTransport(httpx.BaseTransport):
    def __init__(
        self,
        responses: list[
            httpx.Response
            | Exception
            | Callable[[httpx.Request], httpx.Response]
        ],
    ) -> None:
        self.responses = list(responses)
        self.requests: list[httpx.Request] = []

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if not self.responses:
            raise AssertionError("unexpected HTTP request")
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        if callable(response):
            response = response(request)
        response.request = request
        return response


class CloseTrackingTransport(SequenceTransport):
    def __init__(self) -> None:
        super().__init__([])
        self.close_calls = 0

    def close(self) -> None:
        self.close_calls += 1


def test_list_models_uses_current_capability_token_and_returns_sorted_unique_ids(settings):
    transport = SequenceTransport([
        httpx.Response(200, json={
            "object": "list",
            "data": [
                {"id": "video-z", "object": "model", "owned_by": "provider"},
                {"id": "Video-a", "object": "model", "owned_by": "provider"},
                {"id": "video-z", "object": "model", "owned_by": "provider"},
            ],
        }),
    ])

    with NewApiClient(settings, transport=transport) as client:
        result = client.list_models("video")

    assert result == ["Video-a", "video-z"]
    assert transport.requests[0].method == "GET"
    assert str(transport.requests[0].url) == "https://newapi.example/v1/models"
    assert transport.requests[0].headers["Authorization"] == "Bearer video-secret"


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"data": "not-a-list"},
        {"data": [{"id": "  invalid-model  "}]},
        {"data": [{"id": "valid-model"}, {"missing": "id"}]},
    ],
)
def test_list_models_rejects_invalid_provider_payloads(settings, payload):
    transport = SequenceTransport([httpx.Response(200, json=payload)])

    with NewApiClient(settings, transport=transport) as client:
        with pytest.raises(InvalidNewApiResponse):
            client.list_models("image")


def test_image_content_download_streams_public_https_without_authorization(settings):
    content = b"generated-image-content"
    transport = SequenceTransport([httpx.Response(200, content=content)])

    with NewApiClient(settings, transport=transport) as client:
        downloaded = client.download_image_content(
            "https://1.1.1.1/generated/image.png",
            max_bytes=len(content),
        )

    assert downloaded == content
    assert str(transport.requests[0].url) == "https://1.1.1.1/generated/image.png"
    assert "Authorization" not in transport.requests[0].headers


def test_image_content_download_revalidates_relative_redirect(settings):
    transport = SequenceTransport(
        [
            httpx.Response(302, headers={"Location": "/final/image.png"}),
            httpx.Response(200, content=b"image"),
        ]
    )

    with NewApiClient(settings, transport=transport) as client:
        downloaded = client.download_image_content(
            "https://1.1.1.1/start",
            max_bytes=5,
        )

    assert downloaded == b"image"
    assert [str(request.url) for request in transport.requests] == [
        "https://1.1.1.1/start",
        "https://1.1.1.1/final/image.png",
    ]


@pytest.mark.parametrize(
    "url",
    [
        "http://1.1.1.1/image.png",
        "https://user:password@1.1.1.1/image.png",
        "https://127.0.0.1/image.png",
        "https://169.254.169.254/latest/meta-data",
        "https://1.1.1.1:8443/image.png",
    ],
)
def test_image_content_download_rejects_unsafe_urls_before_network(settings, url):
    transport = SequenceTransport([])

    with NewApiClient(settings, transport=transport) as client:
        with pytest.raises(InvalidNewApiResponse):
            client.download_image_content(url, max_bytes=1024)

    assert transport.requests == []


def test_image_content_download_rejects_oversized_response(settings):
    transport = SequenceTransport([httpx.Response(200, content=b"too-large")])

    with NewApiClient(settings, transport=transport) as client:
        with pytest.raises(InvalidNewApiResponse):
            client.download_image_content(
                "https://1.1.1.1/image.png",
                max_bytes=3,
            )


class ChunksThenError(httpx.SyncByteStream):
    def __init__(self, chunks: list[bytes], error: Exception) -> None:
        self.chunks = chunks
        self.error = error

    def __iter__(self):
        yield from self.chunks
        raise self.error


@pytest.fixture
def settings() -> AppSettings:
    return AppSettings(
        _env_file=None,
        environment="test",
        auth_hmac_secret="x" * 32,
        newapi_base_url="https://newapi.example",
        newapi_text_token_keys={"text-v1": "text-secret"},
        newapi_text_current_token_alias="text-v1",
        newapi_image_token_keys={"image-v1": "image-secret"},
        newapi_image_current_token_alias="image-v1",
        newapi_video_token_keys={"video-v1": "video-secret"},
        newapi_video_current_token_alias="video-v1",
    )


@pytest.fixture
def rotated_settings() -> AppSettings:
    return AppSettings(
        _env_file=None,
        environment="test",
        auth_hmac_secret="x" * 32,
        newapi_base_url="https://newapi.example",
        newapi_text_token_keys={"text-v1": "old-text", "text-v2": "new-text"},
        newapi_text_current_token_alias="text-v2",
        newapi_image_token_keys={
            "image-v1": "old-image",
            "image-v2": "new-image",
        },
        newapi_image_current_token_alias="image-v2",
        newapi_video_token_keys={
            "video-v1": "old-video",
            "video-v2": "new-video",
        },
        newapi_video_current_token_alias="video-v2",
    )


@pytest.mark.parametrize("kind", ["text", "image", "video"])
def test_token_keyrings_parse_json_environment_values(monkeypatch, kind):
    current_alias = f"{kind}-v1"
    retired_alias = f"{kind}-retired"
    monkeypatch.setenv(
        f"NEWAPI_{kind.upper()}_TOKEN_KEYS_JSON",
        (
            '{"'
            + current_alias
            + '":"current-secret","'
            + retired_alias
            + '":"retired-secret"}'
        ),
    )
    monkeypatch.setenv(
        f"NEWAPI_{kind.upper()}_CURRENT_TOKEN_ALIAS", current_alias
    )

    settings = AppSettings(_env_file=None, auth_hmac_secret="x" * 32)

    assert getattr(settings, f"newapi_{kind}_current_token_alias") == current_alias
    assert getattr(settings, f"newapi_{kind}_token_keys") == {
        current_alias: SecretStr("current-secret"),
        retired_alias: SecretStr("retired-secret"),
    }


def test_newapi_client_close_is_idempotent(settings):
    transport = CloseTrackingTransport()
    client = NewApiClient(settings, transport=transport)

    client.close()
    client.close()

    assert transport.close_calls == 1


def test_newapi_client_context_manager_closes_transport(settings):
    transport = CloseTrackingTransport()
    client = NewApiClient(settings, transport=transport)

    with client as entered:
        assert entered is client

    assert transport.close_calls == 1


def test_token_keyrings_reject_duplicate_environment_aliases_without_leaking_values(
    monkeypatch,
):
    first_secret = "first-provider-secret-sentinel"
    second_secret = "second-provider-secret-sentinel"
    monkeypatch.setenv(
        "NEWAPI_VIDEO_TOKEN_KEYS_JSON",
        '{"video-v1":"'
        + first_secret
        + '","video-v1":"'
        + second_secret
        + '"}',
    )
    monkeypatch.setenv("NEWAPI_VIDEO_CURRENT_TOKEN_ALIAS", "video-v1")

    with pytest.raises(ValidationError) as caught:
        AppSettings(_env_file=None, auth_hmac_secret="x" * 32)

    serialized_errors = json.dumps(caught.value.errors(), default=str)
    for secret in (first_secret, second_secret):
        assert secret not in str(caught.value)
        assert secret not in repr(caught.value)
        assert secret not in serialized_errors


@pytest.mark.parametrize(
    "raw_keyring",
    ["[]", "null", "123", '"provider-secret-sentinel"'],
)
def test_token_keyrings_reject_nonobject_environment_json(monkeypatch, raw_keyring):
    monkeypatch.setenv("NEWAPI_VIDEO_TOKEN_KEYS_JSON", raw_keyring)
    monkeypatch.setenv("NEWAPI_VIDEO_CURRENT_TOKEN_ALIAS", "video-v1")

    with pytest.raises(ValidationError) as caught:
        AppSettings(_env_file=None, auth_hmac_secret="x" * 32)

    assert "provider-secret-sentinel" not in repr(caught.value)


def test_current_token_alias_must_exist_without_leaking_key_value():
    sentinel = "provider-token-secret-sentinel"

    with pytest.raises(ValidationError) as caught:
        AppSettings(
            _env_file=None,
            auth_hmac_secret="x" * 32,
            newapi_video_token_keys={"video-v1": sentinel},
            newapi_video_current_token_alias="video-v2",
        )

    serialized_errors = json.dumps(caught.value.errors(), default=str)
    assert sentinel not in str(caught.value)
    assert sentinel not in repr(caught.value)
    assert sentinel not in serialized_errors


@pytest.mark.parametrize(
    ("keyring", "current_alias"),
    [
        ({"../video": "secret"}, "../video"),
        ({"video v1": "secret"}, "video v1"),
        ({"video-v1": ""}, "video-v1"),
        ({"video-v1": "   "}, "video-v1"),
        ({"video-v1": "x" * 4097}, "video-v1"),
    ],
)
def test_token_keyrings_reject_unsafe_aliases_and_blank_or_unbounded_keys(
    keyring, current_alias
):
    with pytest.raises(ValidationError):
        AppSettings(
            _env_file=None,
            auth_hmac_secret="x" * 32,
            newapi_video_token_keys=keyring,
            newapi_video_current_token_alias=current_alias,
        )


def test_billing_provider_safety_defaults_are_exact(monkeypatch):
    monkeypatch.delenv("NEWAPI_VIDEO_DOWNLOAD_HOST", raising=False)
    settings = AppSettings(_env_file=None, auth_hmac_secret="x" * 32)

    assert settings.billing_reference_recovery_seconds == 86_400
    assert settings.billing_receipt_deadline_seconds == 86_400
    assert settings.billing_hold_timeout_seconds == 86_400
    assert settings.billing_quote_stale_retries == 2
    assert settings.billing_max_video_bytes == 536_870_912
    assert settings.billing_default_multiplier_bps is None
    assert settings.newapi_video_download_host is None


def test_billing_provider_safety_settings_parse_documented_environment_strings(
    monkeypatch,
):
    expected = {
        "billing_reference_recovery_seconds": 86_400,
        "billing_receipt_deadline_seconds": 86_400,
        "billing_hold_timeout_seconds": 86_400,
        "billing_quote_stale_retries": 2,
        "billing_max_video_bytes": 536_870_912,
        "billing_default_multiplier_bps": 15_000,
    }
    for field, value in expected.items():
        monkeypatch.setenv(field.upper(), str(value))

    settings = AppSettings(_env_file=None, auth_hmac_secret="x" * 32)

    assert {
        field: getattr(settings, field)
        for field in expected
    } == expected


@pytest.mark.parametrize(
    "base_url",
    [
        "provider.example",
        "ftp://provider.example",
        "https://user:password@provider.example",
        "https://provider.example/api",
        "https://provider.example/?next=https://evil.example",
        "https://provider.example/#fragment",
    ],
)
def test_newapi_base_url_must_be_a_clean_http_origin(base_url):
    with pytest.raises(ValidationError):
        AppSettings(
            _env_file=None,
            auth_hmac_secret="x" * 32,
            newapi_base_url=base_url,
        )


def test_newapi_base_url_accepts_http_origins_and_strips_trailing_slash():
    settings = AppSettings(
        _env_file=None,
        auth_hmac_secret="x" * 32,
        newapi_base_url="https://provider.example:8443/",
    )

    assert settings.newapi_base_url == "https://provider.example:8443"


def test_video_download_host_parses_and_normalizes_environment_value(monkeypatch):
    monkeypatch.setenv("NEWAPI_VIDEO_DOWNLOAD_HOST", "MEDIA.EXAMPLE")

    settings = AppSettings(_env_file=None, auth_hmac_secret="x" * 32)

    assert settings.newapi_video_download_host == "media.example"


@pytest.mark.parametrize(
    "hostname",
    [
        "https://media.example",
        "media.example:443",
        "localhost",
        "127.0.0.1",
        "media..example",
        " media.example",
        "media.example/path",
    ],
)
def test_video_download_host_rejects_non_dns_hostname_values(hostname):
    with pytest.raises(ValidationError):
        AppSettings(
            _env_file=None,
            auth_hmac_secret="x" * 32,
            newapi_video_download_host=hostname,
        )


def test_env_example_documents_nonsecret_newapi_keyrings_and_billing_defaults():
    env_example = (ROOT_DIR / ".env.example").read_text(encoding="utf-8")
    assignments = {
        name: value
        for line in env_example.splitlines()
        if line and not line.startswith("#") and "=" in line
        for name, value in [line.split("=", 1)]
    }

    for kind in ("TEXT", "IMAGE", "VIDEO"):
        alias = kind.lower() + "-v1"
        assert (
            f'# Example: NEWAPI_{kind}_TOKEN_KEYS_JSON='
            f'{{"{alias}":"<set-in-secret-store>"}}'
            in env_example
        )
        assert assignments[f"NEWAPI_{kind}_TOKEN_KEYS_JSON"] == ""
        assert (
            f"# Example: NEWAPI_{kind}_CURRENT_TOKEN_ALIAS={alias}" in env_example
        )
        assert assignments[f"NEWAPI_{kind}_CURRENT_TOKEN_ALIAS"] == ""
    assert "BILLING_REFERENCE_RECOVERY_SECONDS=86400" in env_example
    assert "BILLING_RECEIPT_DEADLINE_SECONDS=86400" in env_example
    assert "BILLING_HOLD_TIMEOUT_SECONDS=86400" in env_example
    assert "BILLING_QUOTE_STALE_RETRIES=2" in env_example
    assert "BILLING_MAX_VIDEO_BYTES=536870912" in env_example
    assert "BILLING_DEFAULT_MULTIPLIER_BPS=15000" in env_example
    assert re.search(r"NEWAPI_.*TOKEN_KEYS_JSON=.*sk-", env_example) is None


def test_empty_newapi_keyring_environment_values_are_unconfigured(monkeypatch):
    for kind in ("TEXT", "IMAGE", "VIDEO"):
        monkeypatch.setenv(f"NEWAPI_{kind}_TOKEN_KEYS_JSON", "")
        monkeypatch.setenv(f"NEWAPI_{kind}_CURRENT_TOKEN_ALIAS", "")

    settings = AppSettings(_env_file=None, auth_hmac_secret="x" * 32)

    assert settings.newapi_text_token_keys == {}
    assert settings.newapi_text_current_token_alias is None
    assert settings.newapi_image_token_keys == {}
    assert settings.newapi_image_current_token_alias is None
    assert settings.newapi_video_token_keys == {}
    assert settings.newapi_video_current_token_alias is None


def test_httpx_is_an_explicit_runtime_dependency():
    requirements = (ROOT_DIR / "requirements.txt").read_text(encoding="utf-8")
    assert re.search(r"(?m)^httpx>=0\.27,<1$", requirements)


def test_settings_and_client_representations_redact_all_provider_keys(settings):
    rendered_settings = repr(settings)
    serialized_settings = settings.model_dump_json()
    rendered_client = repr(NewApiClient(settings, transport=SequenceTransport([])))

    for secret in ("text-secret", "image-secret", "video-secret"):
        assert secret not in rendered_settings
        assert secret not in serialized_settings
        assert secret not in rendered_client


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("billing_reference_recovery_seconds", 0),
        ("billing_receipt_deadline_seconds", -1),
        ("billing_hold_timeout_seconds", True),
        ("billing_quote_stale_retries", 1.5),
        ("billing_max_video_bytes", 0),
        ("billing_quote_stale_retries", "01"),
        ("billing_quote_stale_retries", " 1"),
        ("billing_quote_stale_retries", "1.0"),
        ("billing_quote_stale_retries", "+1"),
        ("billing_quote_stale_retries", "0"),
    ],
)
def test_billing_provider_safety_settings_require_positive_integers(field, value):
    with pytest.raises(ValidationError):
        AppSettings(
            _env_file=None,
            auth_hmac_secret="x" * 32,
            **{field: value},
        )


@pytest.mark.parametrize(
    ("provider_cost_micro", "multiplier_bps", "expected"),
    [
        (0, 15_000, 0),
        (1, 1, 10_000),
        (2_898_000, 15_000, 4_350_000),
        (2_898_001, 15_000, 4_350_000),
        (7_223_000, 10_000, 7_230_000),
        (10**30, 10_001, 1_000_100_000_000_000_000_000_000_000_000),
    ],
)
def test_provider_micro_to_charge_units_rounds_up_to_whole_cny_fen(
    provider_cost_micro, multiplier_bps, expected
):
    assert (
        provider_micro_to_charge_units(provider_cost_micro, multiplier_bps)
        == expected
    )


@pytest.mark.parametrize(
    ("provider_cost_micro", "multiplier_bps"),
    [
        (-1, 15_000),
        (1, 0),
        (1, -1),
        (True, 15_000),
        (1, True),
        (1.5, 15_000),
        (1, 15_000.0),
    ],
)
def test_provider_micro_to_charge_units_rejects_invalid_integer_ratios(
    provider_cost_micro, multiplier_bps
):
    with pytest.raises(ValueError, match="invalid integer ratio"):
        provider_micro_to_charge_units(provider_cost_micro, multiplier_bps)


def test_prepared_json_request_freezes_exact_bytes_and_redacts_body_repr():
    body = {
        "seconds": 10,
        "prompt": "private prompt sentinel",
        "model": "video-model",
    }

    request = PreparedNewApiRequest.json("POST", "/v1/videos", body)
    body["prompt"] = "mutated prompt"

    assert request.content == (
        b'{"model":"video-model","prompt":"private prompt sentinel","seconds":10}'
    )
    assert request.content_type == "application/json"
    assert "private prompt sentinel" not in repr(request)
    with pytest.raises(FrozenInstanceError):
        request.path = "/v1/responses"


@pytest.mark.parametrize("nonfinite", [float("nan"), float("inf"), float("-inf")])
def test_prepared_json_rejects_nonfinite_numbers_before_network(settings, nonfinite):
    transport = SequenceTransport([])
    client = NewApiClient(settings, transport=transport)

    with pytest.raises(ValueError):
        client.quote(
            "video",
            PreparedNewApiRequest.json(
                "POST",
                "/v1/videos",
                {"model": "video-model", "temperature": nonfinite},
            ),
        )

    assert transport.requests == []


@pytest.mark.parametrize(
    "path",
    [
        "/v1/chat/completions",
        "/v1/responses",
        "/v1/images/generations",
        "/v1/videos",
    ],
)
def test_prepared_request_allows_only_known_relative_post_routes(path):
    request = PreparedNewApiRequest.json("POST", path, {"model": "m"})
    assert request.method == "POST"
    assert request.path == path


@pytest.mark.parametrize(
    ("method", "path", "content_type"),
    [
        ("GET", "/v1/videos", "application/json"),
        ("POST", "https://provider.example/v1/videos", "application/json"),
        ("POST", "//provider.example/v1/videos", "application/json"),
        ("POST", "/v1/videos?target=https://evil.example", "application/json"),
        ("POST", "/v1/videos/../responses", "application/json"),
        ("POST", "/api/usage/receipt/request/id", "application/json"),
        ("POST", "/v1/videos", "text/plain"),
    ],
)
def test_direct_prepared_request_cannot_bypass_method_path_or_type_allowlist(
    method, path, content_type
):
    with pytest.raises(ValueError):
        PreparedNewApiRequest(
            method=method,
            path=path,
            content=b"{}",
            content_type=content_type,
        )


@pytest.mark.parametrize(
    "content",
    [
        b"{}",
        b'{"model":""}',
        b'{"model":123}',
        b'{"model":"first","model":"second"}',
        b'{"model":"video-model","temperature":NaN}',
        b'{"model":"video-model","temperature":Infinity}',
        b'{"model":"video-model","temperature":-Infinity}',
    ],
)
def test_direct_prepared_request_requires_one_strict_nonempty_model(content):
    with pytest.raises(ValueError):
        PreparedNewApiRequest(
            method="POST",
            path="/v1/videos",
            content=content,
            content_type="application/json",
        )


def test_usage_quote_preserves_integer_cost_and_decimal_audit_values():
    quote = UsageQuote.model_validate_json(json.dumps(QUOTE))

    assert quote.estimated_cost_amount_micro == 2_898_001
    assert quote.quota_per_unit == Decimal("500000.5")
    assert quote.other_ratios == {
        "seconds": Decimal("10"),
        "resolution": Decimal("1.5"),
    }
    assert QUOTE_ID not in repr(quote)
    assert QUOTE_ID not in quote.model_dump_json()


@pytest.mark.parametrize(
    "patch",
    [
        {"quote_id": "uq_short"},
        {"estimated_quota": "1449000"},
        {"estimated_cost_amount_micro": 2_898_001.5},
        {"quota_per_unit": 0},
        {"quota_per_unit": "500000.5"},
        {"other_ratios": {"seconds": -1}},
        {"other_ratios": {"seconds": "10"}},
        {"expires_at": 0},
        {"prompt": "provider response prompt sentinel"},
    ],
)
def test_usage_quote_rejects_malformed_coercing_or_extra_fields(patch):
    payload = {**QUOTE, **patch}

    with pytest.raises(ValidationError) as caught:
        UsageQuote.model_validate_json(json.dumps(payload))

    assert "provider response prompt sentinel" not in str(caught.value)
    assert "provider response prompt sentinel" not in repr(caught.value)


def quote_status_payload(**patch):
    return {
        "quote_id": QUOTE_ID,
        "status": "quoted",
        "created_at": 1,
        "expires_at": 121,
        "updated_at": 2,
        **patch,
    }


@pytest.mark.parametrize(
    "patch",
    [
        {},
        {"status": "expired"},
        {"status": "failed"},
        {
            "status": "failed",
            "reference_type": "request",
            "reference_id": REQUEST_ID,
            "consumed_at": 2,
        },
        {
            "status": "consuming",
            "reference_type": "task",
            "reference_id": TASK_ID,
            "consumed_at": 2,
        },
        {
            "status": "accepted",
            "reference_type": "request",
            "reference_id": REQUEST_ID,
            "consumed_at": 2,
        },
    ],
)
def test_quote_status_accepts_only_coherent_reference_states(patch):
    status = UsageQuoteStatus.model_validate(quote_status_payload(**patch))
    assert QUOTE_ID not in repr(status)
    assert QUOTE_ID not in status.model_dump_json()


@pytest.mark.parametrize(
    "patch",
    [
        {"status": "accepted", "reference_id": TASK_ID},
        {"status": "consuming", "reference_type": "task"},
        {
            "status": "quoted",
            "reference_type": "task",
            "reference_id": TASK_ID,
        },
        {
            "status": "expired",
            "reference_type": "request",
            "reference_id": REQUEST_ID,
        },
        {"status": "accepted"},
        {"status": "consuming"},
        {"unexpected": "field"},
    ],
)
def test_quote_status_rejects_incomplete_or_impossible_reference_states(patch):
    with pytest.raises(ValidationError):
        UsageQuoteStatus.model_validate(quote_status_payload(**patch))


@pytest.mark.parametrize(
    "patch",
    [
        {
            "status": "accepted",
            "reference_type": "task",
            "reference_id": REQUEST_ID,
            "consumed_at": 2,
        },
        {
            "status": "accepted",
            "reference_type": "request",
            "reference_id": TASK_ID,
            "consumed_at": 2,
        },
    ],
)
def test_quote_status_reference_format_must_match_reference_type(patch):
    with pytest.raises(ValidationError):
        UsageQuoteStatus.model_validate(quote_status_payload(**patch))


def receipt_payload(**patch):
    return {
        "reference_type": "task",
        "reference_id": TASK_ID,
        "status": "settled",
        "model": "video-model",
        "quota": 1_550_000,
        "refunded_quota": 0,
        "quota_per_unit": 500000.5,
        "pricing_version": "sha256:pricing",
        "cost_currency": "USD",
        "cost_amount_micro": 3_100_000,
        "settled_at": 1_783_390_100,
        **patch,
    }


def test_usage_receipt_preserves_integer_cost_and_decimal_snapshot():
    receipt = UsageReceipt.model_validate_json(json.dumps(receipt_payload()))
    pending = UsageReceipt.model_validate_json(
        json.dumps(
            receipt_payload(
                status="pending",
                quota=0,
                quota_per_unit=0,
                pricing_version="",
                cost_amount_micro=0,
                settled_at=None,
            )
        )
    )

    assert receipt.quota == 1_550_000
    assert receipt.cost_amount_micro == 3_100_000
    assert receipt.quota_per_unit == Decimal("500000.5")
    assert pending.settled_at is None


@pytest.mark.parametrize(
    "patch",
    [
        {"quota_per_unit": "500000.5"},
        {"quota": "1550000"},
        {"cost_amount_micro": 3_100_000.5},
        {"reference_id": "../receipt"},
        {"result_url": "https://private-result.example/video.mp4"},
    ],
)
def test_usage_receipt_rejects_coercing_or_extra_wire_types(patch):
    with pytest.raises(ValidationError):
        UsageReceipt.model_validate_json(json.dumps(receipt_payload(**patch)))


@pytest.mark.parametrize(
    "patch",
    [
        {"reference_type": "task", "reference_id": REQUEST_ID},
        {"reference_type": "request", "reference_id": TASK_ID},
    ],
)
def test_receipt_reference_format_must_match_reference_type(patch):
    with pytest.raises(ValidationError):
        UsageReceipt.model_validate(receipt_payload(**patch))


def test_video_task_status_uses_strict_error_object_and_hides_result_metadata():
    result_url = "https://provider-result.example/private-video.mp4"
    status = VideoTaskStatus.model_validate(
        {
            "id": TASK_ID,
            "task_id": TASK_ID,
            "object": "video",
            "model": "video-model",
            "status": "failed",
            "progress": 87,
            "created_at": 100,
            "completed_at": 120,
            "error": {"message": "upstream failed", "code": "provider_error"},
            "metadata": {"url": result_url},
            "url": result_url,
            "video_url": result_url,
            "image_url": "https://provider-result.example/private-poster.png",
        }
    )
    minimal = VideoTaskStatus.model_validate(
        {"id": TASK_ID, "status": "completed"}
    )

    assert status.error is not None
    assert status.error.message == "upstream failed"
    assert status.error.code == "provider_error"
    assert minimal.status == "completed"
    assert result_url not in repr(status)
    assert result_url not in status.model_dump_json()


def test_video_task_status_accepts_provider_unknown_fallback_only():
    status = VideoTaskStatus.model_validate({"id": TASK_ID, "status": "unknown"})
    assert status.status == "unknown"


@pytest.mark.parametrize(
    "patch",
    [
        {"error": "upstream failed"},
        {"error": {"message": "failed"}},
        {"error": {"message": "failed", "code": "x", "url": "private"}},
        {"status": "SUCCESS"},
        {"id": "../task"},
        {"result_url": "https://provider-result.example/private-video.mp4"},
    ],
)
def test_video_task_status_rejects_wrong_error_and_envelope_shapes(patch):
    with pytest.raises(ValidationError):
        VideoTaskStatus.model_validate(
            {"id": TASK_ID, "status": "failed", **patch}
        )


def test_video_task_status_rejects_nonprovider_task_identifiers():
    with pytest.raises(ValidationError):
        VideoTaskStatus.model_validate({"id": "task_other", "status": "completed"})


def test_quote_and_execute_reuse_exact_body_route_and_capability_token(settings):
    transport = SequenceTransport(
        [
            httpx.Response(200, json=QUOTE),
            httpx.Response(200, json={"id": TASK_ID}),
        ]
    )
    request = PreparedNewApiRequest.json(
        "POST",
        "/v1/videos",
        {"model": "video-model", "seconds": 10},
    )
    client = NewApiClient(settings, transport=transport)

    scoped_quote = client.quote("video", request)
    result = client.execute_quoted(
        "video", scoped_quote.token_alias, request, scoped_quote.quote.quote_id
    )

    assert isinstance(scoped_quote, TokenScopedQuote)
    assert isinstance(result, QuotedExecutionResult)
    assert (result.reference_type, result.reference_id) == ("task", TASK_ID)
    quoted, executed = transport.requests
    assert quoted.url == executed.url == httpx.URL(
        "https://newapi.example/v1/videos"
    )
    assert quoted.content == executed.content == request.content
    assert quoted.headers["X-OneAPI-Quote-Only"] == "1"
    assert "X-OneAPI-Usage-Quote" not in quoted.headers
    assert executed.headers["X-OneAPI-Usage-Quote"] == QUOTE_ID
    assert "X-OneAPI-Quote-Only" not in executed.headers
    assert quoted.headers["Authorization"] == executed.headers["Authorization"]
    assert quoted.headers["Authorization"] == "Bearer video-secret"


def test_image_execution_extends_only_the_read_timeout(settings):
    image_quote = {
        **QUOTE,
        "model": "gpt-image-2",
        "fixed_group": "openmontage-image",
        "relay_format": "openai_image",
        "other_ratios": {"n": 1},
    }
    transport = SequenceTransport(
        [
            httpx.Response(200, json=image_quote),
            httpx.Response(
                200,
                json={"data": []},
                headers={"X-Oneapi-Request-Id": REQUEST_ID},
            ),
        ]
    )
    request = PreparedNewApiRequest.json(
        "POST",
        "/v1/images/generations",
        {"model": "gpt-image-2", "prompt": "frame"},
    )
    client = NewApiClient(settings, transport=transport)

    scoped_quote = client.quote("image", request)
    client.execute_quoted(
        "image",
        scoped_quote.token_alias,
        request,
        scoped_quote.quote.quote_id,
    )

    quoted, executed = transport.requests
    assert quoted.extensions["timeout"] == {
        "connect": 30.0,
        "read": 30.0,
        "write": 30.0,
        "pool": 30.0,
    }
    assert executed.extensions["timeout"] == {
        "connect": 30.0,
        "read": 180.0,
        "write": 30.0,
        "pool": 30.0,
    }


def test_text_execution_extends_only_the_read_timeout(settings):
    text_quote = {
        **QUOTE,
        "model": "gpt-5.5",
        "fixed_group": "openmontage-text",
        "relay_format": "openai",
        "other_ratios": {},
    }
    transport = SequenceTransport(
        [
            httpx.Response(200, json=text_quote),
            httpx.Response(
                200,
                json={"choices": []},
                headers={"X-Oneapi-Request-Id": REQUEST_ID},
            ),
        ]
    )
    request = PreparedNewApiRequest.json(
        "POST",
        "/v1/chat/completions",
        {"model": "gpt-5.5", "messages": []},
    )
    client = NewApiClient(settings, transport=transport)

    scoped_quote = client.quote("text", request)
    client.execute_quoted(
        "text",
        scoped_quote.token_alias,
        request,
        scoped_quote.quote.quote_id,
    )

    quoted, executed = transport.requests
    assert quoted.extensions["timeout"] == {
        "connect": 30.0,
        "read": 30.0,
        "write": 30.0,
        "pool": 30.0,
    }
    assert executed.extensions["timeout"] == {
        "connect": 30.0,
        "read": 600.0,
        "write": 30.0,
        "pool": 30.0,
    }


def test_streamed_text_execution_is_reassembled_as_chat_completion(settings):
    text_quote = {
        **QUOTE,
        "model": "gpt-5.4",
        "fixed_group": "openmontage-text",
        "relay_format": "openai",
        "other_ratios": {},
    }
    stream_body = (
        b'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
        b'data: {"choices":[{"delta":{"content":" world"}}]}\n\n'
        b"data: [DONE]\n\n"
    )
    transport = SequenceTransport(
        [
            httpx.Response(200, json=text_quote),
            httpx.Response(
                200,
                content=stream_body,
                headers={
                    "Content-Type": "text/event-stream; charset=utf-8",
                    "X-Oneapi-Request-Id": REQUEST_ID,
                },
            ),
        ]
    )
    request = PreparedNewApiRequest.json(
        "POST",
        "/v1/chat/completions",
        {"model": "gpt-5.4", "messages": [], "stream": True},
    )
    client = NewApiClient(settings, transport=transport)

    scoped_quote = client.quote("text", request)
    result = client.execute_quoted(
        "text",
        scoped_quote.token_alias,
        request,
        scoped_quote.quote.quote_id,
    )

    assert result.reference_id == REQUEST_ID
    assert result.response.headers["content-type"] == "application/json"
    assert result.response.json() == {
        "choices": [{"message": {"content": "hello world"}}]
    }


def test_malformed_streamed_text_execution_is_ambiguous(settings):
    text_quote = {
        **QUOTE,
        "model": "gpt-5.4",
        "fixed_group": "openmontage-text",
        "relay_format": "openai",
        "other_ratios": {},
    }
    transport = SequenceTransport(
        [
            httpx.Response(200, json=text_quote),
            httpx.Response(
                200,
                content=b"data: not-json\n\n",
                headers={
                    "Content-Type": "text/event-stream",
                    "X-Oneapi-Request-Id": REQUEST_ID,
                },
            ),
        ]
    )
    request = PreparedNewApiRequest.json(
        "POST",
        "/v1/chat/completions",
        {"model": "gpt-5.4", "messages": [], "stream": True},
    )
    client = NewApiClient(settings, transport=transport)

    scoped_quote = client.quote("text", request)

    with pytest.raises(AmbiguousNewApiResult):
        client.execute_quoted(
            "text",
            scoped_quote.token_alias,
            request,
            scoped_quote.quote.quote_id,
        )


def test_prepared_request_model_is_derived_from_frozen_json_bytes():
    body = {"model": "video-model", "seconds": 10}

    request = PreparedNewApiRequest.json("POST", "/v1/videos", body)
    body["model"] = "mutated-model"

    assert request.model == "video-model"
    assert json.loads(request.content)["model"] == request.model


@pytest.mark.parametrize(
    ("kind", "path"),
    [
        ("text", "/v1/images/generations"),
        ("image", "/v1/videos"),
        ("video", "/v1/responses"),
    ],
)
def test_capability_tokens_cannot_cross_relay_route_families(settings, kind, path):
    transport = SequenceTransport([])
    client = NewApiClient(settings, transport=transport)

    with pytest.raises(ValueError, match="capability"):
        client.quote(kind, PreparedNewApiRequest.json("POST", path, {"model": "m"}))

    assert transport.requests == []


@pytest.mark.parametrize(
    ("kind", "path", "relay_format"),
    [
        ("video", "/v1/videos", "openai"),
        ("text", "/v1/responses", "task"),
        ("image", "/v1/images/generations", "task"),
        ("text", "/v1/chat/completions", "openai_responses"),
        ("text", "/v1/responses", "openai"),
        ("image", "/v1/images/generations", "openai"),
    ],
)
def test_quote_response_relay_format_must_match_capability(
    settings, kind, path, relay_format
):
    transport = SequenceTransport(
        [
            httpx.Response(
                200,
                json={**QUOTE, "model": "m", "relay_format": relay_format},
            )
        ]
    )

    with pytest.raises(InvalidNewApiResponse):
        NewApiClient(settings, transport=transport).quote(
            kind,
            PreparedNewApiRequest.json("POST", path, {"model": "m"}),
        )


def test_quote_response_model_must_match_prepared_request(settings):
    transport = SequenceTransport(
        [httpx.Response(200, json={**QUOTE, "model": "different-model"})]
    )

    with pytest.raises(InvalidNewApiResponse):
        NewApiClient(settings, transport=transport).quote(
            "video",
            PreparedNewApiRequest.json(
                "POST", "/v1/videos", {"model": "video-model"}
            ),
        )


@pytest.mark.parametrize(
    ("kind", "path", "response_json", "headers", "reference_type", "reference_id"),
    [
        (
            "text",
            "/v1/responses",
            {"output": []},
            {"X-Oneapi-Request-Id": REQUEST_ID},
            "request",
            REQUEST_ID,
        ),
        (
            "image",
            "/v1/images/generations",
            {"data": []},
            {"X-Oneapi-Request-Id": REQUEST_ID},
            "request",
            REQUEST_ID,
        ),
        ("video", "/v1/videos", {"id": TASK_ID}, {}, "task", TASK_ID),
    ],
)
def test_quoted_execution_returns_typed_sanitized_references(
    settings,
    kind,
    path,
    response_json,
    headers,
    reference_type,
    reference_id,
):
    transport = SequenceTransport(
        [httpx.Response(200, json=response_json, headers=headers)]
    )

    result = NewApiClient(settings, transport=transport).execute_quoted(
        kind,
        f"{kind}-v1",
        PreparedNewApiRequest.json("POST", path, {"model": "m"}),
        QUOTE_ID,
    )

    assert (result.reference_type, result.reference_id) == (
        reference_type,
        reference_id,
    )
    with pytest.raises(RuntimeError, match="request instance has not been set"):
        _ = result.response.request


@pytest.mark.parametrize(
    ("kind", "path", "response_json", "headers"),
    [
        ("text", "/v1/responses", {"output": []}, {}),
        (
            "image",
            "/v1/images/generations",
            {"data": []},
            {"X-Oneapi-Request-Id": " "},
        ),
        ("video", "/v1/videos", {"id": 123}, {}),
        ("video", "/v1/videos", {"id": "../task"}, {}),
        ("video", "/v1/videos", {"id": "task_other"}, {}),
        (
            "text",
            "/v1/responses",
            {"output": []},
            {"X-Oneapi-Request-Id": "request_other"},
        ),
        ("video", "/v1/videos", [], {}),
    ],
)
def test_successful_execution_without_valid_reference_is_ambiguous(
    settings, kind, path, response_json, headers
):
    transport = SequenceTransport(
        [httpx.Response(200, json=response_json, headers=headers)]
    )

    with pytest.raises(AmbiguousNewApiResult):
        NewApiClient(settings, transport=transport).execute_quoted(
            kind,
            f"{kind}-v1",
            PreparedNewApiRequest.json("POST", path, {"model": "m"}),
            QUOTE_ID,
        )


@pytest.mark.parametrize("quote_id", ["uq_1", " uq_" + "A" * 32, "uq_" + "/" * 32])
def test_malformed_quote_id_is_rejected_before_network(settings, quote_id):
    transport = SequenceTransport([])
    with pytest.raises(ValueError):
        NewApiClient(settings, transport=transport).execute_quoted(
            "video",
            "video-v1",
            PreparedNewApiRequest.json("POST", "/v1/videos", {"model": "m"}),
            quote_id,
        )
    assert transport.requests == []


@pytest.mark.parametrize(
    ("method_name", "args"),
    [
        ("get_video_task", ("video-v1", "task_other")),
        ("get_task_receipt", ("video", "video-v1", "task_other")),
        ("get_request_receipt", ("text", "text-v1", "request_other")),
    ],
)
def test_malformed_provider_references_are_rejected_before_network(
    settings, method_name, args
):
    transport = SequenceTransport([])
    client = NewApiClient(settings, transport=transport)

    with pytest.raises(ValueError):
        getattr(client, method_name)(*args)

    assert transport.requests == []


def test_malformed_video_download_task_id_is_rejected_before_network(
    settings, tmp_path
):
    transport = SequenceTransport([])
    client = NewApiClient(settings, transport=transport)

    with pytest.raises(ValueError):
        client.download_video_content(
            "video-v1", "task_other", tmp_path / "video.mp4"
        )

    assert transport.requests == []


@pytest.mark.parametrize(
    ("method_name", "kind", "token_alias", "identifier"),
    [
        ("get_task_receipt", "text", "text-v1", TASK_ID),
        ("get_task_receipt", "image", "image-v1", TASK_ID),
        ("get_request_receipt", "video", "video-v1", REQUEST_ID),
    ],
)
def test_receipt_reference_type_must_match_capability_before_network(
    settings, method_name, kind, token_alias, identifier
):
    transport = SequenceTransport([])
    client = NewApiClient(settings, transport=transport)

    with pytest.raises(ValueError, match="capability"):
        getattr(client, method_name)(kind, token_alias, identifier)

    assert transport.requests == []


def test_removed_retired_alias_fails_closed_without_current_token_fallback(settings):
    transport = SequenceTransport([])
    client = NewApiClient(settings, transport=transport)
    unavailable = getattr(newapi, "CapabilityAliasUnavailable", None)

    assert unavailable is not None
    with pytest.raises(unavailable, match="capability token is unavailable"):
        client.get_quote_status("video", "video-retired", QUOTE_ID)

    assert transport.requests == []


def test_removed_retired_alias_is_typed_for_video_download(settings, tmp_path):
    transport = SequenceTransport([])
    client = NewApiClient(settings, transport=transport)
    unavailable = getattr(newapi, "CapabilityAliasUnavailable", None)

    assert unavailable is not None
    with pytest.raises(unavailable, match="capability token is unavailable"):
        client.download_video_content(
            "video-retired", TASK_ID, tmp_path / "recovered.mp4"
        )

    assert transport.requests == []


def test_empty_explicit_quote_alias_does_not_fall_back_to_current(settings):
    transport = SequenceTransport([])
    client = NewApiClient(settings, transport=transport)

    with pytest.raises(NewApiCallError):
        client.quote(
            "video",
            PreparedNewApiRequest.json("POST", "/v1/videos", {"model": "m"}),
            token_alias="",
        )

    assert transport.requests == []


def test_quote_and_receipt_not_found_are_typed(settings):
    transport = SequenceTransport(
        [httpx.Response(404), httpx.Response(404), httpx.Response(404)]
    )
    client = NewApiClient(settings, transport=transport)

    with pytest.raises(QuoteNotFound):
        client.get_quote_status("video", "video-v1", QUOTE_ID)
    with pytest.raises(ReceiptNotFound):
        client.get_task_receipt("video", "video-v1", TASK_ID)
    with pytest.raises(ReceiptNotFound):
        client.get_request_receipt("text", "text-v1", REQUEST_ID)


@pytest.mark.parametrize(
    ("kind", "payload"),
    [
        (
            "video",
            quote_status_payload(
                status="accepted",
                reference_type="request",
                reference_id=REQUEST_ID,
                consumed_at=2,
            ),
        ),
        (
            "text",
            quote_status_payload(
                status="accepted",
                reference_type="task",
                reference_id=TASK_ID,
                consumed_at=2,
            ),
        ),
        ("video", {**quote_status_payload(), "quote_id": "uq_" + "Z" * 32}),
    ],
)
def test_quote_status_rejects_wrong_capability_or_response_identity(
    settings, kind, payload
):
    client = NewApiClient(
        settings,
        transport=SequenceTransport([httpx.Response(200, json=payload)]),
    )
    with pytest.raises(InvalidNewApiResponse):
        client.get_quote_status(kind, f"{kind}-v1", QUOTE_ID)


@pytest.mark.parametrize(
    ("method_name", "kind", "identifier", "payload"),
    [
        (
            "get_task_receipt",
            "video",
            TASK_ID,
            receipt_payload(reference_id=OTHER_TASK_ID),
        ),
        (
            "get_request_receipt",
            "text",
            REQUEST_ID,
            receipt_payload(
                reference_type="request", reference_id=OTHER_REQUEST_ID
            ),
        ),
    ],
)
def test_receipt_reads_reject_wrong_response_identity(
    settings, method_name, kind, identifier, payload
):
    client = NewApiClient(
        settings,
        transport=SequenceTransport([httpx.Response(200, json=payload)]),
    )
    with pytest.raises(InvalidNewApiResponse):
        getattr(client, method_name)(kind, f"{kind}-v1", identifier)


@pytest.mark.parametrize(
    ("method_name", "args", "payload"),
    [
        (
            "get_quote_status",
            ("video", "video-v1", QUOTE_ID),
            quote_status_payload(
                status="accepted",
                reference_type="task",
                reference_id="task_other",
                consumed_at=2,
            ),
        ),
        (
            "get_task_receipt",
            ("video", "video-v1", TASK_ID),
            receipt_payload(reference_id="task_other"),
        ),
        (
            "get_request_receipt",
            ("text", "text-v1", REQUEST_ID),
            receipt_payload(
                reference_type="request", reference_id="request_other"
            ),
        ),
    ],
)
def test_status_and_receipts_reject_malformed_provider_references(
    settings, method_name, args, payload
):
    client = NewApiClient(
        settings,
        transport=SequenceTransport([httpx.Response(200, json=payload)]),
    )

    with pytest.raises(InvalidNewApiResponse):
        getattr(client, method_name)(*args)


@pytest.mark.parametrize(
    "payload",
    [
        {"error": {"code": "quote_stale"}},
        {
            "error": {
                "message": "usage quote is stale (request id: internal)",
                "type": "new_api_error",
                "code": "quote_stale",
            }
        },
    ],
)
def test_execute_maps_only_valid_quote_stale_contract(settings, payload):
    transport = SequenceTransport([httpx.Response(409, json=payload)])
    client = NewApiClient(settings, transport=transport)

    with pytest.raises(QuoteStale):
        client.execute_quoted(
            "video",
            "video-v1",
            PreparedNewApiRequest.json("POST", "/v1/videos", {"model": "m"}),
            QUOTE_ID,
        )


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"error": "quote_stale"},
        {"error": {"code": "other"}},
        {"error": {"code": "quote_stale", "unexpected": "field"}},
        {"error": {"code": 123}},
    ],
)
def test_malformed_or_different_409_is_generic_failure(settings, payload):
    transport = SequenceTransport([httpx.Response(409, json=payload)])
    client = NewApiClient(settings, transport=transport)

    with pytest.raises(NewApiCallError):
        client.execute_quoted(
            "video",
            "video-v1",
            PreparedNewApiRequest.json("POST", "/v1/videos", {"model": "m"}),
            QUOTE_ID,
        )


def test_duplicate_json_names_fail_closed_for_stale_quote_and_task_contracts(settings):
    request = PreparedNewApiRequest.json(
        "POST", "/v1/videos", {"model": "m"}
    )
    stale_transport = SequenceTransport(
        [
            httpx.Response(
                409,
                content=b'{"error":{"code":"other","code":"quote_stale"}}',
            )
        ]
    )
    with pytest.raises(NewApiCallError):
        NewApiClient(settings, transport=stale_transport).execute_quoted(
            "video", "video-v1", request, QUOTE_ID
        )

    quote_json = json.dumps(QUOTE).replace(
        '"estimated_quota": 1449000',
        '"estimated_quota": 1, "estimated_quota": 1449000',
    )
    with pytest.raises(InvalidNewApiResponse):
        NewApiClient(
            settings,
            transport=SequenceTransport(
                [httpx.Response(200, content=quote_json.encode("utf-8"))]
            ),
        ).quote("video", request)

    task_transport = SequenceTransport(
        [
            httpx.Response(
                400,
                content=(
                    b'{"code":"other","code":"task_not_exist",'
                    b'"message":"task_not_exist","data":null}'
                ),
            )
        ]
    )
    with pytest.raises(NewApiCallError):
        NewApiClient(settings, transport=task_transport).get_video_task(
            "video-v1", TASK_ID
        )


def test_rate_limit_and_explicit_failures_are_typed_and_sanitized(settings):
    sentinels = [
        "video-secret",
        "private prompt sentinel",
        QUOTE_ID,
        "https://provider-result.example/private.mp4",
    ]
    transport = SequenceTransport(
        [
            httpx.Response(429, text="slow down"),
            httpx.Response(500, json={"error": {"message": sentinels[1:]}}),
        ]
    )
    client = NewApiClient(settings, transport=transport)
    request = PreparedNewApiRequest.json(
        "POST", "/v1/videos", {"model": "m", "prompt": sentinels[1]}
    )

    with pytest.raises(NewApiRateLimited):
        client.quote("video", request)
    with pytest.raises(NewApiCallError) as caught:
        client.execute_quoted("video", "video-v1", request, QUOTE_ID)

    rendered = repr(caught.value)
    assert all(sentinel not in rendered for sentinel in sentinels)


def test_connect_failure_is_explicit_but_read_after_send_is_ambiguous(settings):
    request = PreparedNewApiRequest.json(
        "POST", "/v1/videos", {"model": "m", "prompt": "private prompt"}
    )
    connect_transport = SequenceTransport(
        [httpx.ConnectError("connect failed before send")]
    )
    with pytest.raises(NewApiCallError):
        NewApiClient(settings, transport=connect_transport).execute_quoted(
            "video", "video-v1", request, QUOTE_ID
        )

    read_transport = SequenceTransport(
        [
            httpx.Response(
                200,
                stream=ChunksThenError(
                    [b'{"id":"'],
                    httpx.ReadError("disconnect after private prompt was sent"),
                ),
            )
        ]
    )
    with pytest.raises(AmbiguousNewApiResult) as caught:
        NewApiClient(settings, transport=read_transport).execute_quoted(
            "video", "video-v1", request, QUOTE_ID
        )
    assert "private prompt" not in repr(caught.value)


def test_quote_response_is_bounded_by_actual_stream_bytes_not_metadata(settings):
    transport = SequenceTransport(
        [
            httpx.Response(
                200,
                headers={"Content-Length": "1"},
                stream=ChunksThenError(
                    [b"x" * 200_000, b"y" * 100_000],
                    AssertionError("client read beyond response byte limit"),
                ),
            )
        ]
    )

    with pytest.raises(InvalidNewApiResponse) as caught:
        NewApiClient(settings, transport=transport).quote(
            "video",
            PreparedNewApiRequest.json("POST", "/v1/videos", {"model": "m"}),
        )

    assert not isinstance(caught.value, AssertionError)
    assert "client read beyond" not in repr(caught.value)


def test_execution_error_body_uses_small_control_response_bound(settings):
    transport = SequenceTransport(
        [
            httpx.Response(
                409,
                headers={"Content-Length": "1"},
                stream=ChunksThenError(
                    [b"x" * 200_000, b"y" * 100_000],
                    AssertionError("client read beyond error byte limit"),
                ),
            )
        ]
    )

    with pytest.raises(NewApiCallError) as caught:
        NewApiClient(settings, transport=transport).execute_quoted(
            "video",
            "video-v1",
            PreparedNewApiRequest.json("POST", "/v1/videos", {"model": "m"}),
            QUOTE_ID,
        )

    assert "client read beyond" not in repr(caught.value)


def test_malformed_provider_response_exception_redacts_sensitive_payload(settings):
    sentinels = [
        "video-secret",
        "private prompt sentinel",
        QUOTE_ID,
        "https://provider-result.example/private.mp4",
    ]
    payload = {
        **QUOTE,
        "estimated_quota": "wrong-type",
        "prompt": sentinels[1],
        "result_url": sentinels[3],
        "token": sentinels[0],
    }
    client = NewApiClient(
        settings,
        transport=SequenceTransport([httpx.Response(200, json=payload)]),
    )

    with pytest.raises(InvalidNewApiResponse) as caught:
        client.quote(
            "video",
            PreparedNewApiRequest.json(
                "POST", "/v1/videos", {"model": "m", "prompt": sentinels[1]}
            ),
        )

    rendered = repr(caught.value)
    assert all(sentinel not in rendered for sentinel in sentinels)


def test_historical_quote_and_receipt_reads_use_original_retired_alias(
    rotated_settings,
):
    transport = SequenceTransport(
        [
            httpx.Response(
                200,
                json=quote_status_payload(
                    status="accepted",
                    reference_type="task",
                    reference_id=TASK_ID,
                    consumed_at=2,
                ),
            ),
            httpx.Response(200, json=receipt_payload()),
            httpx.Response(
                200,
                json=receipt_payload(
                    reference_type="request",
                    reference_id=REQUEST_ID,
                ),
            ),
        ]
    )
    client = NewApiClient(rotated_settings, transport=transport)

    status = client.get_quote_status("video", "video-v1", QUOTE_ID)
    task_receipt = client.get_task_receipt("video", "video-v1", TASK_ID)
    request_receipt = client.get_request_receipt(
        "text", "text-v1", REQUEST_ID
    )

    assert status.reference_id == task_receipt.reference_id == TASK_ID
    assert request_receipt.reference_id == REQUEST_ID
    assert [request.url.path for request in transport.requests] == [
        f"/api/usage/quote/{QUOTE_ID}",
        f"/api/usage/receipt/task/{TASK_ID}",
        f"/api/usage/receipt/request/{REQUEST_ID}",
    ]
    assert [request.headers["Authorization"] for request in transport.requests] == [
        "Bearer old-video",
        "Bearer old-video",
        "Bearer old-text",
    ]


def test_video_task_read_uses_original_alias_and_relative_route(rotated_settings):
    transport = SequenceTransport(
        [httpx.Response(200, json={"id": TASK_ID, "status": "completed"})]
    )

    status = NewApiClient(
        rotated_settings, transport=transport
    ).get_video_task("video-v1", TASK_ID)

    assert status.id == TASK_ID
    assert transport.requests[0].url.path == f"/v1/videos/{TASK_ID}"
    assert transport.requests[0].headers["Authorization"] == "Bearer old-video"


@pytest.mark.parametrize(
    ("status_code", "payload", "error_type"),
    [
        (
            400,
            {"code": "task_not_exist", "message": "task_not_exist", "data": None},
            ProviderTaskNotFound,
        ),
        (404, None, ProviderTaskNotFound),
        (
            400,
            {"code": "other", "message": "task_not_exist", "data": None},
            NewApiCallError,
        ),
        (400, {"code": "task_not_exist"}, NewApiCallError),
        (
            400,
            {
                "code": "task_not_exist",
                "message": "task_not_exist",
                "data": None,
                "url": "https://private-result.example/video.mp4",
            },
            NewApiCallError,
        ),
    ],
)
def test_video_task_not_found_mapping_requires_exact_safe_contract(
    settings, status_code, payload, error_type
):
    response = (
        httpx.Response(status_code)
        if payload is None
        else httpx.Response(status_code, json=payload)
    )
    client = NewApiClient(settings, transport=SequenceTransport([response]))

    with pytest.raises(error_type) as caught:
        client.get_video_task("video-v1", TASK_ID)

    assert "private-result" not in repr(caught.value)


def test_video_content_download_streams_relative_route_and_atomically_replaces(
    rotated_settings, tmp_path
):
    transport = SequenceTransport(
        [
            httpx.Response(
                200,
                headers={"Content-Length": "1"},
                stream=httpx.ByteStream(b"video-bytes"),
            )
        ]
    )
    destination = tmp_path / "recovered.mp4"
    destination.write_bytes(b"old-video")

    NewApiClient(rotated_settings, transport=transport).download_video_content(
        "video-v1", TASK_ID, destination
    )

    assert destination.read_bytes() == b"video-bytes"
    assert transport.requests[0].url.path == f"/v1/videos/{TASK_ID}/content"
    assert transport.requests[0].headers["Authorization"] == "Bearer old-video"
    assert list(tmp_path.glob(f".{destination.name}.*.tmp")) == []


def test_video_content_download_uses_configured_https_fallback_after_proxy_5xx(
    settings, tmp_path
):
    configured = settings.model_copy(
        update={"newapi_video_download_host": "media.example"}
    )
    transport = SequenceTransport(
        [
            httpx.Response(502, json={"error": {"type": "server_error"}}),
            httpx.Response(200, stream=httpx.ByteStream(b"fallback-video")),
        ]
    )
    destination = tmp_path / "recovered.mp4"

    NewApiClient(configured, transport=transport).download_video_content(
        "video-v1",
        TASK_ID,
        destination,
        fallback_url="https://media.example/generated/recovered.mp4",
    )

    assert destination.read_bytes() == b"fallback-video"
    assert transport.requests[0].url.path == f"/v1/videos/{TASK_ID}/content"
    assert transport.requests[0].headers["Authorization"] == "Bearer video-secret"
    assert str(transport.requests[1].url) == (
        "https://media.example/generated/recovered.mp4"
    )
    assert "Authorization" not in transport.requests[1].headers


@pytest.mark.parametrize(
    "fallback_url",
    [
        "http://media.example/generated/video.mp4",
        "https://other.example/generated/video.mp4",
        "https://user:password@media.example/generated/video.mp4",
        "https://media.example:444/generated/video.mp4",
        "https://media.example/generated/video.bin",
        "https://media.example/generated/video.mp4?token=secret",
        "https://media.example/generated/video.mp4#fragment",
        "/generated/video.mp4",
    ],
)
def test_video_content_download_rejects_unsafe_fallback_urls(
    settings, tmp_path, fallback_url
):
    configured = settings.model_copy(
        update={"newapi_video_download_host": "media.example"}
    )
    transport = SequenceTransport([httpx.Response(502)])

    with pytest.raises(NewApiCallError, match="request failed"):
        NewApiClient(configured, transport=transport).download_video_content(
            "video-v1",
            TASK_ID,
            tmp_path / "video.mp4",
            fallback_url=fallback_url,
        )

    assert len(transport.requests) == 1


def test_video_content_download_does_not_follow_fallback_redirects(
    settings, tmp_path
):
    configured = settings.model_copy(
        update={"newapi_video_download_host": "media.example"}
    )
    transport = SequenceTransport(
        [
            httpx.Response(502),
            httpx.Response(302, headers={"Location": "https://other.example/video.mp4"}),
        ]
    )

    with pytest.raises(NewApiCallError, match="request failed"):
        NewApiClient(configured, transport=transport).download_video_content(
            "video-v1",
            TASK_ID,
            tmp_path / "video.mp4",
            fallback_url="https://media.example/generated/video.mp4",
        )

    assert len(transport.requests) == 2


@pytest.mark.parametrize("failure_mode", ["oversized", "disconnect"])
def test_video_content_download_cleans_partial_and_preserves_destination(
    settings, tmp_path, failure_mode
):
    limited = settings.model_copy(update={"billing_max_video_bytes": 5})
    if failure_mode == "oversized":
        stream = ChunksThenError(
            [b"123", b"456"],
            AssertionError("read beyond video byte limit"),
        )
        error_type = InvalidNewApiResponse
    else:
        stream = ChunksThenError(
            [b"123"],
            httpx.ReadError("disconnect with private result URL"),
        )
        error_type = NewApiCallError
    transport = SequenceTransport(
        [
            httpx.Response(
                200,
                headers={"Content-Length": "1"},
                stream=stream,
            )
        ]
    )
    destination = tmp_path / "video.mp4"
    destination.write_bytes(b"existing")

    with pytest.raises(error_type) as caught:
        NewApiClient(limited, transport=transport).download_video_content(
            "video-v1", TASK_ID, destination
        )

    assert destination.read_bytes() == b"existing"
    assert list(tmp_path.glob(f".{destination.name}.*.tmp")) == []
    assert "private result" not in repr(caught.value)
    assert "read beyond" not in repr(caught.value)
