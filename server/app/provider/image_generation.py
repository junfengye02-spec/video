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
from server.app.billing.models import GenerationJob
from server.app.media_files import MAX_IMAGE_BYTES, media_download_url
from server.app.provider.newapi import PreparedNewApiRequest
from server.app.storage import WorkbenchStore


@dataclass(frozen=True, slots=True)
class ImageGenerationResult:
    job_id: str
    images: tuple[str, ...]
    paths: tuple[str, ...]


def prepare_image_generation_request(
    model: str, prompt: str, count: int, size: str, quality: str
) -> PreparedNewApiRequest:
    is_gpt_image = model.startswith("gpt-image-")
    provider_quality = "medium" if is_gpt_image and quality == "standard" else quality
    payload = {
        "model": model,
        "prompt": prompt,
        "n": count,
        "size": size,
        "quality": provider_quality,
    }
    if not is_gpt_image:
        payload["response_format"] = "b64_json"
    return PreparedNewApiRequest.json(
        "POST",
        "/v1/images/generations",
        payload,
    )


def _parse_image_payload(
    response,
    expected_count: int,
    *,
    image_client=None,
) -> list[tuple[bytes, str]]:
    try:
        payload = response.json()
        items = payload["data"]
    except Exception:
        raise ValueError("image provider returned an invalid result") from None
    if not isinstance(items, list) or len(items) != expected_count:
        raise ValueError("image provider returned an invalid result")
    parsed: list[tuple[bytes, str]] = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("image provider returned an invalid result")
        encoded = item.get("b64_json")
        image_url = item.get("url")
        if isinstance(encoded, str):
            if encoded.startswith("data:"):
                try:
                    header, encoded = encoded.split(",", 1)
                except ValueError:
                    raise ValueError(
                        "image provider returned an invalid result"
                    ) from None
                if header.lower() not in {
                    "data:image/png;base64",
                    "data:image/jpeg;base64",
                    "data:image/webp;base64",
                }:
                    raise ValueError("image provider returned an invalid result")
            try:
                content = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError):
                raise ValueError("image provider returned an invalid result") from None
        elif isinstance(image_url, str):
            downloader = getattr(image_client, "download_image_content", None)
            if not callable(downloader):
                raise ValueError("image provider returned an invalid result")
            content = downloader(image_url, max_bytes=MAX_IMAGE_BYTES)
        else:
            raise ValueError("image provider returned an invalid result")
        if not isinstance(content, bytes):
            raise ValueError("image provider returned an invalid result")
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
    settlement_key: str | None = None,
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
    stable_job_id = billing_job_id or settlement_key
    existing = db.get(GenerationJob, stable_job_id) if stable_job_id else None
    if existing is not None:
        if (
            existing.user_id != user_id
            or existing.project_id != project_id
            or not existing.chargeable
            or existing.capability != "image"
            or existing.operation != "image_generation"
        ):
            raise ValueError("Image billing job does not match the task")
        if existing.status == "billed" and existing.result_visible:
            paths = _recover_generated_paths(media_store, project_id, existing.id, count)
            return ImageGenerationResult(
                job_id=existing.id,
                images=tuple(media_download_url(project_id, path) for path in paths),
                paths=tuple(paths),
            )
        if existing.status != "payment_required_quote":
            from server.app.billing.execution import ProviderResultPending

            raise ProviderResultPending("image billing result is not ready", existing.id)
        context = retry_payment_required_quote(
            job_id=existing.id,
            now=now,
            **call,
        )
    elif billing_job_id is None:
        context = execute_billed_provider_call(
            parent_job_id=None,
            now=now,
            job_id=settlement_key,
            **call,
        )
    else:
        context = retry_payment_required_quote(job_id=billing_job_id, now=now, **call)

    def persist_hidden(job_id, response):
        images = _parse_image_payload(response, count, image_client=newapi)
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
        paths=tuple(staged.value),
    )


def _recover_generated_paths(
    media_store: WorkbenchStore,
    project_id: str,
    job_id: str,
    count: int,
) -> list[str]:
    paths: list[str] = []
    for index in range(count):
        matched = next(
            (
                media_store.project_dir(project_id)
                / "assets"
                / "images"
                / "generated"
                / f"{job_id}-{index}{suffix}"
                for suffix in (".png", ".jpg", ".webp")
                if (
                    media_store.project_dir(project_id)
                    / "assets"
                    / "images"
                    / "generated"
                    / f"{job_id}-{index}{suffix}"
                ).is_file()
            ),
            None,
        )
        if matched is None:
            from server.app.billing.execution import ProviderResultUnavailable

            raise ProviderResultUnavailable("generated image result is unavailable")
        paths.append(str(matched.relative_to(media_store.project_dir(project_id))))
    return paths
