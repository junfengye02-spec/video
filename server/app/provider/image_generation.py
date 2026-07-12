from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
from datetime import datetime
from io import BytesIO

from PIL import Image
from sqlalchemy.orm import Session

from server.app.billing.execution import (
    StagedProviderResult,
    execute_billed_provider_call,
    finalize_billed_sync_result,
    retry_payment_required_quote,
)
from server.app.media_files import MAX_IMAGE_BYTES, media_download_url
from server.app.provider.newapi import PreparedNewApiRequest
from server.app.storage import WorkbenchStore


@dataclass(frozen=True, slots=True)
class ImageGenerationResult:
    job_id: str
    images: tuple[str, ...]


def prepare_image_generation_request(
    model: str, prompt: str, count: int, size: str, quality: str
) -> PreparedNewApiRequest:
    return PreparedNewApiRequest.json(
        "POST",
        "/v1/images/generations",
        {
            "model": model,
            "prompt": prompt,
            "n": count,
            "size": size,
            "quality": quality,
            "response_format": "b64_json",
        },
    )


def _parse_image_payload(response, expected_count: int) -> list[tuple[bytes, str]]:
    try:
        payload = response.json()
        items = payload["data"]
    except Exception:
        raise ValueError("image provider returned an invalid result") from None
    if not isinstance(items, list) or len(items) != expected_count:
        raise ValueError("image provider returned an invalid result")
    parsed: list[tuple[bytes, str]] = []
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("b64_json"), str):
            raise ValueError("image provider returned an invalid result")
        try:
            content = base64.b64decode(item["b64_json"], validate=True)
        except (binascii.Error, ValueError):
            raise ValueError("image provider returned an invalid result") from None
        if not content or len(content) > MAX_IMAGE_BYTES:
            raise ValueError("image provider returned an invalid result")
        try:
            with Image.open(BytesIO(content)) as image:
                image.verify()
                image_format = image.format
        except Exception:
            raise ValueError("image provider returned an invalid result") from None
        suffix = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp"}.get(image_format)
        if suffix is None:
            raise ValueError("image provider returned an unsupported image")
        parsed.append((content, suffix))
    return parsed


def generate_billed_project_image(
    *,
    db: Session,
    newapi,
    settings,
    media_store: WorkbenchStore,
    user_id: str,
    project_id: str,
    prompt: str,
    model: str,
    count: int,
    size: str,
    quality: str,
    billing_job_id: str | None = None,
    now: datetime | None = None,
) -> ImageGenerationResult:
    request = prepare_image_generation_request(model, prompt, count, size, quality)
    call = {
        "db": db,
        "newapi": newapi,
        "settings": settings,
        "artifact_inspector": media_store.inspect_staged_artifact,
        "user_id": user_id,
        "project_id": project_id,
        "capability": "image",
        "operation": "image_generation",
        "request": request,
    }
    if billing_job_id is None:
        context = execute_billed_provider_call(parent_job_id=None, now=now, **call)
    else:
        context = retry_payment_required_quote(job_id=billing_job_id, now=now, **call)

    def persist_hidden(job_id, response):
        images = _parse_image_payload(response, count)
        paths = [
            media_store.write_generated_image(
                project_id=project_id,
                job_id=job_id,
                index=index,
                suffix=suffix,
                content=content,
            )
            for index, (content, suffix) in enumerate(images)
        ]
        artifact = media_store.stage_sync_result(
            project_id=project_id,
            job_id=job_id,
            operation="image_generation",
            capability="image",
            source_reference=context.execution.reference_id,
            content=response.content,
        )
        return StagedProviderResult(
            locator=artifact.locator,
            sha256=artifact.sha256,
            value=tuple(paths),
        )

    staged = finalize_billed_sync_result(
        db=db,
        newapi=newapi,
        settings=settings,
        artifact_inspector=media_store.inspect_staged_artifact,
        context=context,
        persist_hidden=persist_hidden,
        now=now,
    )
    return ImageGenerationResult(
        job_id=context.job_id,
        images=tuple(
            media_download_url(project_id, relative)
            for relative in staged.value
        ),
    )
