from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal, Mapping
from urllib.parse import quote as url_quote

import httpx
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from server.app.core.config import AppSettings


TokenKind = Literal["text", "image", "video"]
_MAX_CONTROL_RESPONSE_BYTES = 256 * 1024
_MAX_EXECUTION_RESPONSE_BYTES = 64 * 1024 * 1024


class NewApiError(RuntimeError):
    pass


class InvalidNewApiResponse(NewApiError):
    pass


class AmbiguousNewApiResult(InvalidNewApiResponse):
    pass


class QuoteStale(NewApiError):
    pass


class QuoteNotFound(NewApiError):
    pass


class ReceiptNotFound(NewApiError):
    pass


class ProviderTaskNotFound(NewApiError):
    pass


class NewApiRateLimited(NewApiError):
    pass


class NewApiCallError(NewApiError):
    pass


def _reject_duplicate_json_names(pairs: list[tuple[str, object]]) -> dict[str, object]:
    parsed: dict[str, object] = {}
    for name, value in pairs:
        if name in parsed:
            raise ValueError("duplicate JSON name")
        parsed[name] = value
    return parsed


def _load_unique_json(content: bytes) -> object:
    return json.loads(content, object_pairs_hook=_reject_duplicate_json_names)


def _validate_json_model(
    model_type: type[_StrictNewApiModel], content: bytes
) -> _StrictNewApiModel:
    _load_unique_json(content)
    return model_type.model_validate_json(content)


_RELAY_PATHS = frozenset(
    {
        "/v1/chat/completions",
        "/v1/responses",
        "/v1/images/generations",
        "/v1/videos",
    }
)
_CAPABILITY_PATHS = {
    "text": frozenset({"/v1/chat/completions", "/v1/responses"}),
    "image": frozenset({"/v1/images/generations"}),
    "video": frozenset({"/v1/videos"}),
}


def _validate_relay_path(path: str) -> str:
    if type(path) is not str or path not in _RELAY_PATHS:
        raise ValueError("unsupported NewAPI relay path")
    return path


def _validate_capability_path(kind: TokenKind, path: str) -> None:
    if kind not in _CAPABILITY_PATHS or path not in _CAPABILITY_PATHS[kind]:
        raise ValueError("NewAPI request capability does not match relay path")


@dataclass(frozen=True, slots=True)
class PreparedNewApiRequest:
    method: Literal["POST"]
    path: str
    content: bytes = field(repr=False)
    content_type: str

    def __post_init__(self) -> None:
        if self.method != "POST":
            raise ValueError("NewAPI relay requests must use POST")
        _validate_relay_path(self.path)
        if type(self.content) is not bytes:
            raise ValueError("NewAPI request content must be immutable bytes")
        if self.content_type != "application/json":
            raise ValueError("unsupported NewAPI request content type")

    @classmethod
    def json(
        cls,
        method: Literal["POST"],
        path: str,
        body: Mapping[str, object],
    ) -> "PreparedNewApiRequest":
        return cls(
            method=method,
            path=_validate_relay_path(path),
            content=json.dumps(
                body,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            ).encode("utf-8"),
            content_type="application/json",
        )


class _StrictNewApiModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        strict=True,
        hide_input_in_errors=True,
    )


class UsageQuote(_StrictNewApiModel):
    quote_id: str = Field(
        min_length=35,
        max_length=35,
        pattern=r"^uq_[A-Za-z0-9]{32}$",
        repr=False,
        exclude=True,
    )
    status: Literal["quoted"]
    model: str = Field(min_length=1, max_length=200)
    fixed_group: str = Field(min_length=1, max_length=200)
    relay_format: str = Field(min_length=1, max_length=100)
    estimated_quota: int = Field(ge=0)
    quota_per_unit: Decimal = Field(gt=0)
    cost_currency: Literal["USD"]
    estimated_cost_amount_micro: int = Field(ge=0)
    pricing_version: str = Field(min_length=1, max_length=200)
    billing_fingerprint: str = Field(min_length=1, max_length=200)
    other_ratios: dict[str, Decimal]
    expires_at: int = Field(gt=0)

    @field_validator("quota_per_unit", mode="before")
    @classmethod
    def require_numeric_quota_per_unit(cls, value: object) -> object:
        if type(value) not in {int, float, Decimal}:
            raise ValueError("quota_per_unit must be a JSON number")
        return value if type(value) is Decimal else Decimal(str(value))

    @field_validator("other_ratios", mode="before")
    @classmethod
    def require_numeric_other_ratios(cls, value: object) -> object:
        if type(value) is not dict or any(
            type(ratio) not in {int, float, Decimal}
            for ratio in value.values()
        ):
            raise ValueError("other_ratios must contain JSON numbers")
        return {
            name: ratio if type(ratio) is Decimal else Decimal(str(ratio))
            for name, ratio in value.items()
        }

    @field_validator("other_ratios")
    @classmethod
    def validate_other_ratios(
        cls, ratios: dict[str, Decimal]
    ) -> dict[str, Decimal]:
        for name, value in ratios.items():
            if (
                not name
                or len(name) > 100
                or not value.is_finite()
                or value <= 0
            ):
                raise ValueError("invalid NewAPI quote ratio")
        return ratios


class UsageQuoteStatus(_StrictNewApiModel):
    quote_id: str = Field(
        min_length=35,
        max_length=35,
        pattern=r"^uq_[A-Za-z0-9]{32}$",
        repr=False,
        exclude=True,
    )
    status: Literal["quoted", "consuming", "accepted", "failed", "expired"]
    reference_type: Literal["request", "task"] | None = None
    reference_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=200,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
    )
    created_at: int = Field(ge=0)
    expires_at: int = Field(gt=0)
    consumed_at: int | None = Field(default=None, gt=0)
    updated_at: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_reference_state(self) -> "UsageQuoteStatus":
        if (self.reference_type is None) != (self.reference_id is None):
            raise ValueError("quote reference must be complete")
        if self.status in {"consuming", "accepted"} and self.reference_id is None:
            raise ValueError("consumed quote must expose its reference")
        if self.status in {"quoted", "expired"} and self.reference_id is not None:
            raise ValueError("unconsumed quote cannot expose a reference")
        return self


class UsageReceipt(_StrictNewApiModel):
    reference_type: Literal["request", "task"]
    reference_id: str = Field(
        min_length=1,
        max_length=200,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
    )
    status: Literal[
        "pending",
        "settled",
        "refunded",
        "refund_pending",
        "not_chargeable",
    ]
    model: str = Field(max_length=200)
    quota: int = Field(ge=0)
    refunded_quota: int = Field(ge=0)
    quota_per_unit: Decimal = Field(ge=0)
    pricing_version: str = Field(max_length=200)
    cost_currency: Literal["USD"]
    cost_amount_micro: int = Field(ge=0)
    settled_at: int | None = Field(default=None, ge=0)

    @field_validator("quota_per_unit", mode="before")
    @classmethod
    def require_numeric_quota_per_unit(cls, value: object) -> object:
        if type(value) not in {int, float, Decimal}:
            raise ValueError("quota_per_unit must be a JSON number")
        return value if type(value) is Decimal else Decimal(str(value))


class _VideoTaskError(_StrictNewApiModel):
    message: str = Field(min_length=1, max_length=500)
    code: str = Field(min_length=1, max_length=100)


class VideoTaskStatus(_StrictNewApiModel):
    id: str = Field(
        min_length=1,
        max_length=200,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
    )
    task_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=200,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
    )
    object: Literal["video"] | None = None
    model: str | None = Field(default=None, max_length=200)
    status: Literal["queued", "in_progress", "completed", "failed", "unknown"]
    progress: int | None = Field(default=None, ge=0, le=100)
    created_at: int | None = Field(default=None, ge=0)
    completed_at: int | None = Field(default=None, ge=0)
    expires_at: int | None = Field(default=None, ge=0)
    seconds: str | None = Field(default=None, max_length=50)
    size: str | None = Field(default=None, max_length=50)
    remixed_from_video_id: str | None = Field(default=None, max_length=200)
    error: _VideoTaskError | None = None
    metadata: dict[str, Any] | None = Field(
        default=None,
        repr=False,
        exclude=True,
    )

    @model_validator(mode="after")
    def validate_legacy_task_id(self) -> "VideoTaskStatus":
        if self.task_id is not None and self.task_id != self.id:
            raise ValueError("video task identifiers do not match")
        return self


@dataclass(frozen=True, slots=True)
class TokenScopedQuote:
    token_alias: str
    quote: UsageQuote


@dataclass(frozen=True, slots=True)
class QuotedExecutionResult:
    reference_type: Literal["request", "task"]
    reference_id: str
    response: httpx.Response = field(repr=False)


def _validate_quote_id(quote_id: str) -> str:
    if (
        type(quote_id) is not str
        or len(quote_id) != 35
        or not quote_id.startswith("uq_")
        or not quote_id[3:].isalnum()
        or not quote_id[3:].isascii()
    ):
        raise ValueError("invalid NewAPI quote identifier")
    return quote_id


def _validate_reference_id(reference_id: object) -> str:
    if type(reference_id) is not str or not 1 <= len(reference_id) <= 200:
        raise ValueError("invalid NewAPI reference")
    if not reference_id[0].isalnum() or not reference_id[0].isascii():
        raise ValueError("invalid NewAPI reference")
    if any(
        not (character.isascii() and (character.isalnum() or character in "._:-"))
        for character in reference_id
    ):
        raise ValueError("invalid NewAPI reference")
    return reference_id


def _has_quote_stale_contract(response: httpx.Response) -> bool:
    try:
        payload = _load_unique_json(response.content)
    except Exception:
        return False
    if type(payload) is not dict or set(payload) != {"error"}:
        return False
    error = payload["error"]
    if type(error) is not dict or not set(error).issubset(
        {"code", "message", "type"}
    ):
        return False
    if error.get("code") != "quote_stale":
        return False
    if "message" in error and type(error["message"]) is not str:
        return False
    if "type" in error and error["type"] != "new_api_error":
        return False
    return True


def _has_task_not_found_contract(response: httpx.Response) -> bool:
    try:
        payload = _load_unique_json(response.content)
    except Exception:
        return False
    return payload == {
        "code": "task_not_exist",
        "message": "task_not_exist",
        "data": None,
    }


class NewApiClient:
    def __init__(
        self,
        settings: AppSettings,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base_url = settings.newapi_base_url
        self._keyrings = {
            "text": settings.newapi_text_token_keys,
            "image": settings.newapi_image_token_keys,
            "video": settings.newapi_video_token_keys,
        }
        self._current_aliases = {
            "text": settings.newapi_text_current_token_alias,
            "image": settings.newapi_image_current_token_alias,
            "video": settings.newapi_video_current_token_alias,
        }
        self._max_video_bytes = settings.billing_max_video_bytes
        self._client = httpx.Client(timeout=30, transport=transport)

    def quote(
        self,
        kind: TokenKind,
        request: PreparedNewApiRequest,
        token_alias: str | None = None,
    ) -> TokenScopedQuote:
        _validate_capability_path(kind, request.path)
        alias = (
            self._current_aliases[kind]
            if token_alias is None
            else token_alias
        )
        response = self._send_raw(
            kind,
            alias,
            request,
            {"X-OneAPI-Quote-Only": "1"},
            max_bytes=_MAX_CONTROL_RESPONSE_BYTES,
            ambiguous_on_invalid_success=False,
        )
        try:
            quote = _validate_json_model(UsageQuote, response.content)
        except Exception:
            raise InvalidNewApiResponse("invalid NewAPI response") from None
        if (kind == "video") != (quote.relay_format == "task"):
            raise InvalidNewApiResponse("invalid NewAPI response")
        return TokenScopedQuote(token_alias=alias, quote=quote)

    def execute_quoted(
        self,
        kind: TokenKind,
        token_alias: str,
        request: PreparedNewApiRequest,
        quote_id: str,
    ) -> QuotedExecutionResult:
        _validate_capability_path(kind, request.path)
        response = self._send_raw(
            kind,
            token_alias,
            request,
            {"X-OneAPI-Usage-Quote": _validate_quote_id(quote_id)},
            max_bytes=_MAX_EXECUTION_RESPONSE_BYTES,
            ambiguous_on_invalid_success=True,
        )
        try:
            if kind == "video":
                payload = _load_unique_json(response.content)
                if type(payload) is not dict:
                    raise ValueError("invalid video response")
                reference_type = "task"
                reference_id = _validate_reference_id(payload.get("id"))
            else:
                reference_type = "request"
                reference_id = _validate_reference_id(
                    response.headers.get("X-Oneapi-Request-Id")
                )
        except Exception:
            raise AmbiguousNewApiResult("ambiguous NewAPI result") from None
        return QuotedExecutionResult(reference_type, reference_id, response)

    def get_quote_status(
        self,
        kind: TokenKind,
        token_alias: str,
        quote_id: str,
    ) -> UsageQuoteStatus:
        expected_quote_id = _validate_quote_id(quote_id)
        status = self._get_model(
            kind,
            token_alias,
            f"/api/usage/quote/{url_quote(expected_quote_id, safe='')}",
            UsageQuoteStatus,
            QuoteNotFound,
        )
        if status.quote_id != expected_quote_id:
            raise InvalidNewApiResponse("invalid NewAPI response")
        expected_reference_type = "task" if kind == "video" else "request"
        if (
            status.reference_type is not None
            and status.reference_type != expected_reference_type
        ):
            raise InvalidNewApiResponse("invalid NewAPI response")
        return status

    def get_task_receipt(
        self,
        kind: TokenKind,
        token_alias: str,
        task_id: str,
    ) -> UsageReceipt:
        expected_task_id = _validate_reference_id(task_id)
        receipt = self._get_model(
            kind,
            token_alias,
            f"/api/usage/receipt/task/{url_quote(expected_task_id, safe='')}",
            UsageReceipt,
            ReceiptNotFound,
        )
        if (
            receipt.reference_type != "task"
            or receipt.reference_id != expected_task_id
        ):
            raise InvalidNewApiResponse("invalid NewAPI response")
        return receipt

    def get_request_receipt(
        self,
        kind: TokenKind,
        token_alias: str,
        request_id: str,
    ) -> UsageReceipt:
        expected_request_id = _validate_reference_id(request_id)
        receipt = self._get_model(
            kind,
            token_alias,
            f"/api/usage/receipt/request/{url_quote(expected_request_id, safe='')}",
            UsageReceipt,
            ReceiptNotFound,
        )
        if (
            receipt.reference_type != "request"
            or receipt.reference_id != expected_request_id
        ):
            raise InvalidNewApiResponse("invalid NewAPI response")
        return receipt

    def get_video_task(
        self,
        token_alias: str,
        task_id: str,
    ) -> VideoTaskStatus:
        expected_task_id = _validate_reference_id(task_id)
        response = self._get_raw(
            "video",
            token_alias,
            f"/v1/videos/{url_quote(expected_task_id, safe='')}",
            ProviderTaskNotFound,
            allow_task_not_found_400=True,
        )
        try:
            status = _validate_json_model(VideoTaskStatus, response.content)
        except Exception:
            raise InvalidNewApiResponse("invalid NewAPI response") from None
        if status.id != expected_task_id:
            raise InvalidNewApiResponse("invalid NewAPI response")
        return status

    def download_video_content(
        self,
        token_alias: str,
        task_id: str,
        destination: Path,
    ) -> None:
        expected_task_id = _validate_reference_id(task_id)
        token = self._keyrings["video"].get(token_alias)
        if token is None:
            raise NewApiCallError("NewAPI capability token is unavailable")
        destination = Path(destination)
        if not destination.name or not destination.parent.is_dir():
            raise ValueError("video destination directory is invalid")

        response: httpx.Response | None = None
        temporary_path: Path | None = None
        try:
            provider_request = self._client.build_request(
                "GET",
                (
                    self._base_url
                    + f"/v1/videos/{url_quote(expected_task_id, safe='')}/content"
                ),
                headers={"Authorization": f"Bearer {token.get_secret_value()}"},
            )
            response = self._client.send(provider_request, stream=True)
        except httpx.TransportError:
            raise NewApiCallError("NewAPI read failed") from None

        try:
            if response.status_code == 404:
                raise ProviderTaskNotFound("NewAPI resource was not found")
            if response.status_code == 429:
                raise NewApiRateLimited("NewAPI rate limited")
            if response.status_code != 200:
                raise NewApiCallError("NewAPI request failed")

            try:
                with tempfile.NamedTemporaryFile(
                    mode="wb",
                    dir=destination.parent,
                    prefix=f".{destination.name}.",
                    suffix=".tmp",
                    delete=False,
                ) as temporary:
                    temporary_path = Path(temporary.name)
                    written = 0
                    for chunk in response.iter_bytes():
                        if written + len(chunk) > self._max_video_bytes:
                            raise InvalidNewApiResponse("invalid NewAPI response")
                        temporary.write(chunk)
                        written += len(chunk)
                    temporary.flush()
                    os.fsync(temporary.fileno())
                os.replace(temporary_path, destination)
                temporary_path = None
            except NewApiError:
                raise
            except httpx.TransportError:
                raise NewApiCallError("NewAPI read failed") from None
            except OSError:
                raise NewApiCallError("video content staging failed") from None
        finally:
            response.close()
            if temporary_path is not None:
                try:
                    temporary_path.unlink(missing_ok=True)
                except OSError:
                    pass

    def _get_model(
        self,
        kind: TokenKind,
        token_alias: str,
        path: str,
        model_type: type[_StrictNewApiModel],
        not_found: type[NewApiError],
    ) -> _StrictNewApiModel:
        response = self._get_raw(kind, token_alias, path, not_found)
        try:
            return _validate_json_model(model_type, response.content)
        except Exception:
            raise InvalidNewApiResponse("invalid NewAPI response") from None

    def _get_raw(
        self,
        kind: TokenKind,
        token_alias: str,
        path: str,
        not_found: type[NewApiError],
        *,
        allow_task_not_found_400: bool = False,
    ) -> httpx.Response:
        token = self._keyrings.get(kind, {}).get(token_alias)
        if token is None:
            raise NewApiCallError("NewAPI capability token is unavailable")
        response: httpx.Response | None = None
        try:
            provider_request = self._client.build_request(
                "GET",
                self._base_url + path,
                headers={"Authorization": f"Bearer {token.get_secret_value()}"},
            )
            response = self._client.send(provider_request, stream=True)
        except httpx.TransportError:
            raise NewApiCallError("NewAPI read failed") from None

        try:
            if response.status_code == 404:
                raise not_found("NewAPI resource was not found")
            if response.status_code == 429:
                raise NewApiRateLimited("NewAPI rate limited")
            if response.status_code != 200 and not (
                allow_task_not_found_400 and response.status_code == 400
            ):
                raise NewApiCallError("NewAPI request failed")
            content = bytearray()
            try:
                for chunk in response.iter_bytes():
                    if len(content) + len(chunk) > _MAX_CONTROL_RESPONSE_BYTES:
                        raise InvalidNewApiResponse("invalid NewAPI response")
                    content.extend(chunk)
            except NewApiError:
                raise
            except httpx.TransportError:
                raise NewApiCallError("NewAPI read failed") from None
            safe_headers = {
                name: value
                for name, value in response.headers.items()
                if name.lower()
                not in {"content-encoding", "content-length", "transfer-encoding"}
            }
            bounded = httpx.Response(
                response.status_code,
                headers=safe_headers,
                content=bytes(content),
            )
            if bounded.status_code == 400:
                if _has_task_not_found_contract(bounded):
                    raise ProviderTaskNotFound("NewAPI resource was not found")
                raise NewApiCallError("NewAPI request failed")
            return bounded
        finally:
            response.close()

    def _send_raw(
        self,
        kind: TokenKind,
        token_alias: str | None,
        request: PreparedNewApiRequest,
        control_headers: Mapping[str, str],
        *,
        max_bytes: int,
        ambiguous_on_invalid_success: bool,
    ) -> httpx.Response:
        if token_alias is None:
            raise NewApiCallError("NewAPI capability is not configured")
        token = self._keyrings[kind].get(token_alias)
        if token is None:
            raise NewApiCallError("NewAPI capability token is unavailable")
        response: httpx.Response | None = None
        try:
            provider_request = self._client.build_request(
                request.method,
                self._base_url + request.path,
                content=request.content,
                headers={
                    "Authorization": f"Bearer {token.get_secret_value()}",
                    "Content-Type": request.content_type,
                    **control_headers,
                },
            )
            response = self._client.send(provider_request, stream=True)
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout):
            raise NewApiCallError("NewAPI connection failed") from None
        except httpx.TransportError:
            raise AmbiguousNewApiResult("ambiguous NewAPI result") from None

        try:
            if response.status_code == 429:
                raise NewApiRateLimited("NewAPI rate limited")
            if response.status_code not in {200, 409}:
                raise NewApiCallError("NewAPI request failed")

            content = bytearray()
            response_max_bytes = (
                max_bytes
                if response.status_code == 200
                else min(max_bytes, _MAX_CONTROL_RESPONSE_BYTES)
            )
            try:
                for chunk in response.iter_bytes():
                    if len(content) + len(chunk) > response_max_bytes:
                        if response.status_code != 200:
                            raise NewApiCallError("NewAPI request failed")
                        if ambiguous_on_invalid_success and response.status_code == 200:
                            raise AmbiguousNewApiResult(
                                "ambiguous NewAPI result"
                            )
                        raise InvalidNewApiResponse("invalid NewAPI response")
                    content.extend(chunk)
            except NewApiError:
                raise
            except httpx.TransportError:
                if response.status_code == 200:
                    raise AmbiguousNewApiResult(
                        "ambiguous NewAPI result"
                    ) from None
                raise NewApiCallError("NewAPI request failed") from None

            safe_headers = {
                name: value
                for name, value in response.headers.items()
                if name.lower()
                not in {"content-encoding", "content-length", "transfer-encoding"}
            }
            bounded = httpx.Response(
                response.status_code,
                headers=safe_headers,
                content=bytes(content),
            )
            if bounded.status_code == 409:
                if _has_quote_stale_contract(bounded):
                    raise QuoteStale("NewAPI quote is stale")
                raise NewApiCallError("NewAPI request failed")
            return bounded
        finally:
            response.close()
