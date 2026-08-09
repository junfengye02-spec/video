import secrets
from dataclasses import dataclass
from typing import Literal
from urllib.parse import urlparse

from fastapi import Depends, HTTPException, Request
from redis import Redis
from sqlalchemy.orm import Session

from server.app.auth.models import User
from server.app.auth.sessions import SessionRecord, SessionStore
from server.app.core.config import AppSettings, get_settings
from server.app.db.session import get_db
from server.app.redis import get_redis


@dataclass(frozen=True, slots=True)
class CurrentUser:
    id: str
    email: str
    role: Literal["user", "admin"]


def load_session(request: Request, redis: Redis, settings: AppSettings) -> SessionRecord:
    session_id = request.cookies.get(settings.session_cookie_name, "")
    record = SessionStore.from_settings(redis, settings).get(session_id)
    if record is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return record


def require_user(
    request: Request,
    db: Session = Depends(get_db),
    redis: Redis = Depends(get_redis),
    settings: AppSettings = Depends(get_settings),
) -> CurrentUser:
    validate_origin(
        request,
        settings.public_origin,
        allow_loopback=settings.environment == "development",
    )
    record = load_session(request, redis, settings)
    if record.user_id is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    user = db.get(User, record.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    if user.status != "active":
        SessionStore.from_settings(redis, settings).revoke_all(user.id)
        raise HTTPException(status_code=403, detail="Account unavailable")
    return CurrentUser(id=user.id, email=user.email, role=user.role)


def require_admin(current: CurrentUser = Depends(require_user)) -> CurrentUser:
    if current.role != "admin":
        raise HTTPException(status_code=403, detail="Administrator access required")
    return current


def _is_loopback_development_origin(origin: str | None) -> bool:
    if not origin:
        return False
    try:
        parsed = urlparse(origin)
        port = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme == "http"
        and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        and port is not None
        and parsed.path == ""
        and not parsed.params
        and not parsed.query
        and not parsed.fragment
        and parsed.username is None
        and parsed.password is None
    )


def validate_origin(
    request: Request,
    expected_origin: str,
    *,
    allow_loopback: bool = False,
) -> None:
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return
    origin = request.headers.get("origin")
    if origin != expected_origin and not (
        allow_loopback and _is_loopback_development_origin(origin)
    ):
        raise HTTPException(status_code=403, detail="Invalid request origin")


def require_csrf(
    request: Request,
    current: CurrentUser = Depends(require_user),
    redis: Redis = Depends(get_redis),
    settings: AppSettings = Depends(get_settings),
) -> CurrentUser:
    validate_origin(
        request,
        settings.public_origin,
        allow_loopback=settings.environment == "development",
    )
    record = load_session(request, redis, settings)
    supplied = request.headers.get("X-CSRF-Token", "")
    if not supplied or not secrets.compare_digest(supplied, record.csrf_token):
        raise HTTPException(status_code=403, detail="Invalid CSRF token")
    return current


def require_public_csrf(
    request: Request,
    redis: Redis = Depends(get_redis),
    settings: AppSettings = Depends(get_settings),
) -> None:
    validate_origin(
        request,
        settings.public_origin,
        allow_loopback=settings.environment == "development",
    )
    record = load_session(request, redis, settings)
    supplied = request.headers.get("X-CSRF-Token", "")
    if not supplied or not secrets.compare_digest(supplied, record.csrf_token):
        raise HTTPException(status_code=403, detail="Invalid CSRF token")
