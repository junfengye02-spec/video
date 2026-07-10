from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from redis import Redis
from sqlalchemy.orm import Session

from server.app.auth.dependencies import (
    CurrentUser,
    require_csrf,
    require_public_csrf,
    require_user,
)
from server.app.auth.mailer import Mailer, SmtpMailer
from server.app.auth.provisioning import NoopUserProvisioner, UserProvisioner
from server.app.auth.security import normalize_email
from server.app.auth.schemas import (
    AuthResponse,
    CsrfResponse,
    DetailResponse,
    EmailRequest,
    LoginRequest,
    MeResponse,
    PasswordResetConfirmRequest,
    RegisterRequest,
    UserResponse,
)
from server.app.auth.service import (
    AccountUnavailable,
    AuthSession,
    InvalidCredentials,
    InvalidResetCode,
    LoginRateLimited,
    LoginRateLimiter,
    PasswordResetFailed,
    RegistrationConflict,
    SessionIssuanceFailed,
    authenticate_user,
    password_reset_account_exists,
    register_user,
    request_password_reset,
    reset_password,
)
from server.app.auth.sessions import SessionStore
from server.app.auth.verification import (
    InvalidCode,
    RateLimitExceeded,
    ResendTooSoon,
    VerificationStore,
)
from server.app.core.config import AppSettings, get_settings
from server.app.db.session import get_db
from server.app.redis import get_redis


router = APIRouter(prefix="/api/auth", tags=["auth"])


def get_verification_store(
    redis: Redis = Depends(get_redis),
    settings: AppSettings = Depends(get_settings),
) -> VerificationStore:
    return VerificationStore(
        redis,
        prefix=settings.redis_prefix,
        hmac_secret=settings.auth_hmac_secret,
    )


def get_mailer(settings: AppSettings = Depends(get_settings)) -> Mailer:
    try:
        return SmtpMailer(settings)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail="Email delivery is unavailable") from exc


def get_provisioner() -> UserProvisioner:
    return NoopUserProvisioner()


def get_session_store(
    redis: Redis = Depends(get_redis),
    settings: AppSettings = Depends(get_settings),
) -> SessionStore:
    return SessionStore.from_settings(redis, settings)


def get_login_rate_limiter(
    redis: Redis = Depends(get_redis),
    settings: AppSettings = Depends(get_settings),
) -> LoginRateLimiter:
    return LoginRateLimiter(redis, prefix=settings.redis_prefix)


def _source_ip(request: Request) -> str:
    return request.client.host if request.client is not None else "unknown"


def _user_response(user) -> UserResponse:
    return UserResponse(id=user.id, email=user.email, role=user.role)


def _auth_response(result: AuthSession) -> AuthResponse:
    return AuthResponse(
        user=_user_response(result.user),
        csrf_token=result.csrf_token,
    )


def _set_session_cookie(
    response: Response,
    *,
    session_id: str,
    settings: AppSettings,
) -> None:
    response.set_cookie(
        key=settings.session_cookie_name,
        value=session_id,
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite="lax",
        path="/",
    )


def _clear_session_cookie(response: Response, settings: AppSettings) -> None:
    response.delete_cookie(
        key=settings.session_cookie_name,
        path="/",
        secure=settings.session_cookie_secure,
        httponly=True,
        samesite="lax",
    )


@router.get("/csrf", response_model=CsrfResponse)
def csrf_bootstrap(
    request: Request,
    response: Response,
    session_store: SessionStore = Depends(get_session_store),
    settings: AppSettings = Depends(get_settings),
) -> CsrfResponse:
    incoming_session_id = request.cookies.get(settings.session_cookie_name, "")
    record = session_store.get(incoming_session_id)
    if record is None:
        incoming_session_id, record = session_store.create()
        _set_session_cookie(
            response,
            session_id=incoming_session_id,
            settings=settings,
        )
    return CsrfResponse(csrf_token=record.csrf_token)


@router.post(
    "/email-verifications",
    status_code=202,
    response_model=DetailResponse,
    dependencies=[Depends(require_public_csrf)],
)
def send_verification(
    payload: EmailRequest,
    request: Request,
    verification_store: VerificationStore = Depends(get_verification_store),
    mailer: Mailer = Depends(get_mailer),
) -> DetailResponse:
    email = normalize_email(str(payload.email))
    try:
        code = verification_store.issue(
            email,
            purpose="register",
            source_ip=_source_ip(request),
        )
    except (ResendTooSoon, RateLimitExceeded) as exc:
        raise HTTPException(status_code=429, detail="Verification request rate limited") from exc
    mailer.send_verification(email, code)
    return DetailResponse(detail="Verification code sent")


@router.post(
    "/register",
    status_code=201,
    response_model=AuthResponse,
    dependencies=[Depends(require_public_csrf)],
)
def register(
    payload: RegisterRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    verification_store: VerificationStore = Depends(get_verification_store),
    provisioner: UserProvisioner = Depends(get_provisioner),
    session_store: SessionStore = Depends(get_session_store),
    settings: AppSettings = Depends(get_settings),
) -> AuthResponse:
    try:
        result = register_user(
            db=db,
            verification_store=verification_store,
            provisioner=provisioner,
            session_store=session_store,
            incoming_session_id=request.cookies.get(settings.session_cookie_name, ""),
            email=str(payload.email),
            password=payload.password,
            code=payload.code,
        )
    except InvalidCode as exc:
        raise HTTPException(
            status_code=400,
            detail="Invalid or expired verification code",
        ) from exc
    except RegistrationConflict as exc:
        raise HTTPException(
            status_code=409,
            detail="Registration could not be completed",
        ) from exc
    except SessionIssuanceFailed as exc:
        raise HTTPException(status_code=401, detail="Authentication required") from exc
    _set_session_cookie(response, session_id=result.session_id, settings=settings)
    return _auth_response(result)


@router.post(
    "/login",
    response_model=AuthResponse,
    dependencies=[Depends(require_public_csrf)],
)
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    rate_limiter: LoginRateLimiter = Depends(get_login_rate_limiter),
    session_store: SessionStore = Depends(get_session_store),
    settings: AppSettings = Depends(get_settings),
) -> AuthResponse:
    try:
        result = authenticate_user(
            db=db,
            rate_limiter=rate_limiter,
            session_store=session_store,
            incoming_session_id=request.cookies.get(settings.session_cookie_name, ""),
            email=str(payload.email),
            password=payload.password,
            source_ip=_source_ip(request),
        )
    except LoginRateLimited as exc:
        raise HTTPException(status_code=429, detail="Too many login attempts") from exc
    except InvalidCredentials as exc:
        raise HTTPException(
            status_code=401,
            detail="Email or password is incorrect",
        ) from exc
    except AccountUnavailable as exc:
        raise HTTPException(status_code=403, detail="Account unavailable") from exc
    except SessionIssuanceFailed as exc:
        raise HTTPException(status_code=401, detail="Authentication required") from exc
    _set_session_cookie(response, session_id=result.session_id, settings=settings)
    return _auth_response(result)


@router.post(
    "/logout",
    status_code=204,
    dependencies=[Depends(require_csrf)],
)
def logout(
    request: Request,
    response: Response,
    session_store: SessionStore = Depends(get_session_store),
    settings: AppSettings = Depends(get_settings),
) -> None:
    session_store.revoke(request.cookies.get(settings.session_cookie_name, ""))
    _clear_session_cookie(response, settings)


@router.post(
    "/logout-all",
    status_code=204,
    dependencies=[Depends(require_csrf)],
)
def logout_all(
    response: Response,
    current: CurrentUser = Depends(require_user),
    session_store: SessionStore = Depends(get_session_store),
    settings: AppSettings = Depends(get_settings),
) -> None:
    session_store.revoke_all(current.id)
    _clear_session_cookie(response, settings)


@router.get("/me", response_model=MeResponse)
def me(current: CurrentUser = Depends(require_user)) -> MeResponse:
    return MeResponse(
        user=UserResponse(id=current.id, email=current.email, role=current.role)
    )


@router.post(
    "/password-reset/request",
    status_code=202,
    response_model=DetailResponse,
    dependencies=[Depends(require_public_csrf)],
)
def request_password_reset_route(
    payload: EmailRequest,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    verification_store: VerificationStore = Depends(get_verification_store),
    mailer: Mailer = Depends(get_mailer),
) -> DetailResponse:
    email = normalize_email(str(payload.email))
    account_exists = password_reset_account_exists(db=db, email=email)
    background_tasks.add_task(
        request_password_reset,
        verification_store=verification_store,
        mailer=mailer,
        email=email,
        source_ip=_source_ip(request),
        account_exists=account_exists,
    )
    return DetailResponse(detail="If the account can be reset, a code has been sent")


@router.post(
    "/password-reset/confirm",
    status_code=204,
    dependencies=[Depends(require_public_csrf)],
)
def confirm_password_reset(
    payload: PasswordResetConfirmRequest,
    response: Response,
    db: Session = Depends(get_db),
    verification_store: VerificationStore = Depends(get_verification_store),
    session_store: SessionStore = Depends(get_session_store),
    settings: AppSettings = Depends(get_settings),
) -> None:
    try:
        reset_password(
            db=db,
            verification_store=verification_store,
            session_store=session_store,
            email=str(payload.email),
            code=payload.code,
            new_password=payload.new_password,
        )
    except InvalidResetCode as exc:
        raise HTTPException(
            status_code=400,
            detail="Invalid or expired reset code",
        ) from exc
    except PasswordResetFailed as exc:
        raise HTTPException(
            status_code=503,
            detail="Password reset could not be completed",
        ) from exc
    _clear_session_cookie(response, settings)
