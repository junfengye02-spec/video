from __future__ import annotations

import json
from typing import Any, TypeVar

from fastapi import HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError


JsonRequestModel = TypeVar("JsonRequestModel", bound=BaseModel)


def sanitize_validation_errors(errors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            key: value
            for key, value in error.items()
            if key not in {"ctx", "input", "url"}
        }
        for error in errors
    ]


async def redacted_validation_exception_handler(
    request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    del request
    return JSONResponse(
        status_code=422,
        content={"detail": sanitize_validation_errors(exc.errors())},
    )


async def parse_json_request(
    request: Request,
    model: type[JsonRequestModel],
    *,
    max_bytes: int | None = None,
    oversized_detail: str = "Request JSON is too large",
) -> JsonRequestModel:
    raw_body = await _read_request_body(
        request,
        max_bytes=max_bytes,
        oversized_detail=oversized_detail,
    )
    try:
        raw_payload = json.loads(raw_body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise RequestValidationError(
            [
                {
                    "type": "json_invalid",
                    "loc": ("body",),
                    "msg": "JSON decode error",
                }
            ]
        ) from exc
    try:
        return model.model_validate(raw_payload)
    except ValidationError as exc:
        errors = sanitize_validation_errors(exc.errors(include_url=False))
        for error in errors:
            error["loc"] = ("body", *error.get("loc", ()))
        raise RequestValidationError(errors) from exc


async def _read_request_body(
    request: Request,
    *,
    max_bytes: int | None,
    oversized_detail: str,
) -> bytes:
    if max_bytes is None:
        return await request.body()

    content_length = request.headers.get("content-length")
    try:
        declared_length = int(content_length) if content_length is not None else None
    except ValueError:
        declared_length = None
    if declared_length is not None and declared_length >= 0 and declared_length > max_bytes:
        raise HTTPException(status_code=413, detail=oversized_detail)

    body = bytearray()
    async for chunk in request.stream():
        if len(chunk) > max_bytes - len(body):
            raise HTTPException(status_code=413, detail=oversized_detail)
        body.extend(chunk)
    return bytes(body)
