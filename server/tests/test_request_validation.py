from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from server.app.projects.schemas import MAX_IMPORT_ARTIFACT_BYTES, ProjectImportRequest
from server.app.request_validation import parse_json_request


def _instrumented_request(
    chunks: list[bytes],
    *,
    content_length: str | None,
) -> tuple[Request, list[int]]:
    receive_calls: list[int] = []
    remaining = list(chunks)

    async def receive():
        receive_calls.append(len(receive_calls) + 1)
        chunk = remaining.pop(0)
        return {
            "type": "http.request",
            "body": chunk,
            "more_body": bool(remaining),
        }

    headers = []
    if content_length is not None:
        headers.append((b"content-length", content_length.encode("ascii")))
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/projects/import",
            "headers": headers,
        },
        receive,
    )
    return request, receive_calls


def _parse_capped(request: Request):
    return asyncio.run(
        parse_json_request(
            request,
            ProjectImportRequest,
            max_bytes=MAX_IMPORT_ARTIFACT_BYTES,
            oversized_detail="Imported project JSON is too large",
        )
    )


def test_import_rejects_oversized_content_length_without_reading_stream():
    request, receive_calls = _instrumented_request(
        [b"must-not-be-read"],
        content_length=str(MAX_IMPORT_ARTIFACT_BYTES + 1),
    )

    with pytest.raises(HTTPException) as exc_info:
        _parse_capped(request)

    assert exc_info.value.status_code == 413
    assert receive_calls == []


@pytest.mark.parametrize("content_length", [None, "malformed", "-1", "1"])
def test_import_stream_stops_immediately_after_overflow_chunk(content_length):
    request, receive_calls = _instrumented_request(
        [
            b"x" * MAX_IMPORT_ARTIFACT_BYTES,
            b"overflow",
            b"must-not-be-read",
        ],
        content_length=content_length,
    )

    with pytest.raises(HTTPException) as exc_info:
        _parse_capped(request)

    assert exc_info.value.status_code == 413
    assert receive_calls == [1, 2]
