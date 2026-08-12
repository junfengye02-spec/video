from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from server.app.auth.dependencies import CurrentUser, require_admin, require_csrf
from server.app.db.session import get_db
from server.app.provider.dependencies import get_newapi_client
from server.app.provider.newapi import (
    InvalidNewApiResponse,
    NewApiCallError,
    NewApiClient,
)
from server.app.video_model_settings.models import VideoModelDurationSetting
from server.app.video_model_settings.service import (
    VideoModelDurationConflict,
    VideoModelDurationService,
)


router = APIRouter(prefix="/api/admin", tags=["admin-video-models"])


class UpdateVideoModelDurationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    call_duration_seconds: float = Field(gt=0)
    expected_version: int = Field(ge=0)
    reason: str = Field(min_length=1, max_length=500)

    @field_validator("reason")
    @classmethod
    def strip_reason(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("reason is required")
        return value


class DeleteVideoModelDurationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_version: int = Field(ge=1)
    reason: str = Field(min_length=1, max_length=500)

    @field_validator("reason")
    @classmethod
    def strip_reason(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("reason is required")
        return value


class VideoModelDurationSettingResponse(BaseModel):
    provider: str
    model_id: str
    configuration_status: Literal["configured", "unconfigured"]
    call_duration_seconds: float | None
    version: int | None
    profile_revision: str | None
    updated_by: str | None
    updated_at: datetime | None


class AdminVideoModelDurationItem(VideoModelDurationSettingResponse):
    catalog_status: Literal["available", "missing_from_catalog"]


class AdminVideoModelDurationListResponse(BaseModel):
    provider: Literal["newapi"] = "newapi"
    catalog_refresh_status: Literal["ok", "failed"]
    catalog_error_code: str | None = None
    models: list[AdminVideoModelDurationItem]


def _require_admin_csrf(current: CurrentUser = Depends(require_csrf)) -> CurrentUser:
    if current.role != "admin":
        raise HTTPException(status_code=403, detail="Administrator access required")
    return current


def _setting_response(
    service: VideoModelDurationService,
    setting: VideoModelDurationSetting | None,
    *,
    provider: str,
    model_id: str,
) -> VideoModelDurationSettingResponse:
    if setting is None:
        return VideoModelDurationSettingResponse(
            provider=provider,
            model_id=model_id,
            configuration_status="unconfigured",
            call_duration_seconds=None,
            version=None,
            profile_revision=None,
            updated_by=None,
            updated_at=None,
        )
    return VideoModelDurationSettingResponse(
        provider=setting.provider,
        model_id=setting.model_id,
        configuration_status="configured",
        call_duration_seconds=setting.call_duration_seconds,
        version=setting.version,
        profile_revision=service.effective_profile_revision(
            setting.model_id,
            "text_to_video",
            setting.provider,
        ),
        updated_by=setting.updated_by,
        updated_at=setting.updated_at,
    )


@router.get(
    "/video-model-duration-settings",
    response_model=AdminVideoModelDurationListResponse,
)
def list_video_model_duration_settings(
    _current: CurrentUser = Depends(require_admin),
    db: Session = Depends(get_db),
    newapi: NewApiClient = Depends(get_newapi_client),
) -> AdminVideoModelDurationListResponse:
    service = VideoModelDurationService(db)
    settings = service.list(provider="newapi")
    settings_by_id = {setting.model_id: setting for setting in settings}
    try:
        catalog_ids = set(newapi.list_models("video"))
        catalog_refresh_status: Literal["ok", "failed"] = "ok"
        catalog_error_code = None
    except (InvalidNewApiResponse, NewApiCallError):
        catalog_ids = set()
        catalog_refresh_status = "failed"
        catalog_error_code = "provider_model_catalog_unavailable"

    items: list[AdminVideoModelDurationItem] = []
    for model_id in sorted(catalog_ids | settings_by_id.keys(), key=str.casefold):
        base = _setting_response(
            service,
            settings_by_id.get(model_id),
            provider="newapi",
            model_id=model_id,
        )
        items.append(
            AdminVideoModelDurationItem(
                **base.model_dump(),
                catalog_status=(
                    "available" if model_id in catalog_ids else "missing_from_catalog"
                ),
            )
        )
    return AdminVideoModelDurationListResponse(
        catalog_refresh_status=catalog_refresh_status,
        catalog_error_code=catalog_error_code,
        models=items,
    )


@router.put(
    "/video-model-duration-settings/{model_id:path}",
    response_model=VideoModelDurationSettingResponse,
)
def update_video_model_duration_setting(
    model_id: str,
    body: UpdateVideoModelDurationRequest,
    current: CurrentUser = Depends(_require_admin_csrf),
    db: Session = Depends(get_db),
) -> VideoModelDurationSettingResponse:
    service = VideoModelDurationService(db)
    try:
        setting = service.update(
            provider="newapi",
            model_id=model_id,
            call_duration_seconds=body.call_duration_seconds,
            expected_version=body.expected_version,
            updated_by=current.id,
            reason=body.reason,
        )
        db.commit()
        db.refresh(setting)
        return _setting_response(
            service,
            setting,
            provider=setting.provider,
            model_id=setting.model_id,
        )
    except VideoModelDurationConflict as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={
                "code": "video_model_duration_version_conflict",
                "expected_version": body.expected_version,
                "current_version": exc.current_version,
            },
        ) from None
    except ValueError as exc:
        db.rollback()
        raise HTTPException(
            status_code=422,
            detail={"code": "video_model_duration_invalid", "message": str(exc)},
        ) from None
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(
            status_code=503,
            detail={"code": "video_model_duration_settings_unavailable"},
        ) from exc


@router.delete(
    "/video-model-duration-settings/{model_id:path}",
    status_code=204,
)
def delete_video_model_duration_setting(
    model_id: str,
    body: DeleteVideoModelDurationRequest,
    current: CurrentUser = Depends(_require_admin_csrf),
    db: Session = Depends(get_db),
    newapi: NewApiClient = Depends(get_newapi_client),
) -> None:
    service = VideoModelDurationService(db)
    existing = service.get(provider="newapi", model_id=model_id)
    if existing is None:
        raise HTTPException(status_code=404, detail={"code": "video_model_not_found"})
    if existing.version != body.expected_version:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "video_model_duration_version_conflict",
                "expected_version": body.expected_version,
                "current_version": existing.version,
            },
        )
    try:
        catalog_ids = set(newapi.list_models("video"))
    except (InvalidNewApiResponse, NewApiCallError) as exc:
        raise HTTPException(
            status_code=503,
            detail={"code": "provider_model_catalog_unavailable"},
        ) from exc
    if model_id in catalog_ids:
        raise HTTPException(
            status_code=409,
            detail={"code": "video_model_still_in_catalog"},
        )

    try:
        service.delete(
            provider="newapi",
            model_id=model_id,
            expected_version=body.expected_version,
            updated_by=current.id,
            reason=body.reason,
        )
        db.commit()
    except VideoModelDurationConflict as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail={
                "code": "video_model_duration_version_conflict",
                "expected_version": body.expected_version,
                "current_version": exc.current_version,
            },
        ) from None
    except ValueError as exc:
        db.rollback()
        raise HTTPException(
            status_code=422,
            detail={"code": "video_model_duration_invalid", "message": str(exc)},
        ) from None
    except SQLAlchemyError as exc:
        db.rollback()
        raise HTTPException(
            status_code=503,
            detail={"code": "video_model_duration_settings_unavailable"},
        ) from exc
