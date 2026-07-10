from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from typing import TYPE_CHECKING

from redis import Redis
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from server.app.auth.mailer import Mailer
from server.app.auth.models import AdminAuditLog, User
from server.app.auth.provisioning import UserProvisioner
from server.app.auth.security import hash_password, normalize_email, verify_password
from server.app.auth.sessions import SessionStore
from server.app.auth.verification import InvalidCode, VerificationStore

if TYPE_CHECKING:
    from server.app.auth.dependencies import CurrentUser


LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_EMAIL_LIMIT = 10
LOGIN_IP_LIMIT = 30


_LOGIN_RATE_SCRIPT = """
local email_count = tonumber(redis.call('GET', KEYS[1]) or '0')
local ip_count = tonumber(redis.call('GET', KEYS[2]) or '0')
if email_count >= tonumber(ARGV[1]) then
    return 1
end
if ip_count >= tonumber(ARGV[2]) then
    return 2
end

email_count = redis.call('INCR', KEYS[1])
if email_count == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[3])
end
ip_count = redis.call('INCR', KEYS[2])
if ip_count == 1 then
    redis.call('EXPIRE', KEYS[2], ARGV[3])
end
return 0
"""


_DUMMY_PASSWORD_HASH = hash_password("openmontage-dummy-password")


class AuthServiceError(Exception):
    pass


class InvalidCredentials(AuthServiceError):
    pass


class AccountUnavailable(AuthServiceError):
    pass


class RegistrationConflict(AuthServiceError):
    pass


class InvalidResetCode(AuthServiceError):
    pass


class PasswordResetFailed(AuthServiceError):
    pass


class SessionIssuanceFailed(AuthServiceError):
    pass


class AdminBootstrapFailed(AuthServiceError):
    def __init__(self):
        super().__init__("administrator bootstrap could not be completed")


class RoleChangeRejected(AuthServiceError):
    def __init__(self):
        super().__init__("role change is not permitted")


class RoleChangeFailed(AuthServiceError):
    def __init__(self):
        super().__init__("role change could not be completed")


class LoginRateLimited(AuthServiceError):
    def __init__(self, scope: str):
        self.scope = scope
        super().__init__("too many login attempts")


@dataclass(frozen=True, slots=True)
class AuthSession:
    user: User
    session_id: str
    csrf_token: str


class LoginRateLimiter:
    def __init__(self, redis: Redis, *, prefix: str):
        self._redis = redis
        self._prefix = prefix

    def consume(self, email: str, source_ip: str) -> None:
        result = int(
            self._redis.eval(
                _LOGIN_RATE_SCRIPT,
                2,
                self._email_key(email),
                self._ip_key(source_ip),
                LOGIN_EMAIL_LIMIT,
                LOGIN_IP_LIMIT,
                LOGIN_WINDOW_SECONDS,
            )
        )
        if result == 1:
            raise LoginRateLimited("email")
        if result == 2:
            raise LoginRateLimited("ip")

    def clear_email(self, email: str) -> None:
        self._redis.delete(self._email_key(email))

    def _email_key(self, email: str) -> str:
        return f"{self._prefix}login:rate:email:{email}"

    def _ip_key(self, source_ip: str) -> str:
        return f"{self._prefix}login:rate:ip:{source_ip}"


def _role_json(role: str | None) -> str:
    return json.dumps({"role": role}, sort_keys=True, separators=(",", ":"))


def _admin_audit_log(
    *,
    actor_id: str,
    action: str,
    target_id: str,
    before_role: str | None,
    after_role: str,
) -> AdminAuditLog:
    return AdminAuditLog(
        id=uuid.uuid4().hex,
        admin_user_id=actor_id,
        action=action,
        object_type="user",
        object_id=target_id,
        before_json=_role_json(before_role),
        after_json=_role_json(after_role),
        ip_address=None,
    )


def _rollback_quietly(db: Session) -> bool:
    try:
        db.rollback()
    except Exception:
        return False
    return True


def bootstrap_admin(
    *,
    db: Session,
    session_store: SessionStore,
    email: str,
    password: str,
) -> User:
    normalized_email = normalize_email(email)
    password_hash = hash_password(password)
    for attempt in range(2):
        try:
            user = db.execute(
                select(User)
                .where(User.email == normalized_email)
                .with_for_update()
            ).scalar_one_or_none()
            existing_user = user is not None
            before_role = user.role if user is not None else None
            if user is None:
                user = User(
                    id=uuid.uuid4().hex,
                    email=normalized_email,
                    password_hash=password_hash,
                    role="admin",
                    status="active",
                )
                db.add(user)
            else:
                user.password_hash = password_hash
                user.role = "admin"
                user.status = "active"
            db.add(
                _admin_audit_log(
                    actor_id=user.id,
                    action="admin.bootstrap",
                    target_id=user.id,
                    before_role=before_role,
                    after_role="admin",
                )
            )
            if existing_user:
                session_store.revoke_all(user.id)
            db.commit()
            return user
        except IntegrityError as exc:
            rollback_succeeded = _rollback_quietly(db)
            if attempt == 1 or not rollback_succeeded:
                raise AdminBootstrapFailed from exc
        except Exception as exc:
            _rollback_quietly(db)
            raise AdminBootstrapFailed from exc
    raise AdminBootstrapFailed


def set_role(
    *,
    db: Session,
    session_store: SessionStore,
    current_user: CurrentUser,
    target_user_id: str,
    role: str,
) -> User:
    actor_id = getattr(current_user, "id", None)
    if (
        getattr(current_user, "role", None) != "admin"
        or not isinstance(actor_id, str)
        or not actor_id
    ):
        raise RoleChangeRejected
    if role not in {"user", "admin"}:
        raise RoleChangeRejected
    if not isinstance(target_user_id, str) or not target_user_id:
        raise RoleChangeRejected

    try:
        target = db.execute(
            select(User).where(User.id == target_user_id).with_for_update()
        ).scalar_one_or_none()
        if target is None:
            if not _rollback_quietly(db):
                raise RoleChangeFailed from None
            raise RoleChangeRejected
        if target.role == role:
            if not _rollback_quietly(db):
                raise RoleChangeFailed from None
        else:
            before_role = target.role
            target.role = role
            db.add(
                _admin_audit_log(
                    actor_id=actor_id,
                    action="admin.set_role",
                    target_id=target.id,
                    before_role=before_role,
                    after_role=role,
                )
            )
            db.commit()
    except (RoleChangeRejected, RoleChangeFailed):
        raise
    except Exception as exc:
        _rollback_quietly(db)
        raise RoleChangeFailed from exc

    try:
        session_store.revoke_all(target_user_id)
    except Exception as exc:
        raise RoleChangeFailed from exc
    return target


def register_user(
    *,
    db: Session,
    verification_store: VerificationStore,
    provisioner: UserProvisioner,
    session_store: SessionStore,
    incoming_session_id: str,
    email: str,
    password: str,
    code: str,
) -> AuthSession:
    normalized_email = normalize_email(email)
    verification_store.consume(normalized_email, code, purpose="register")
    user = User(
        id=uuid.uuid4().hex,
        email=normalized_email,
        password_hash=hash_password(password),
        role="user",
        status="active",
    )
    try:
        db.add(user)
        db.flush()
        provisioner.provision(db, user.id)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise RegistrationConflict from exc
    except Exception:
        db.rollback()
        raise

    rotated = session_store.rotate(incoming_session_id, user.id)
    if rotated is None:
        raise SessionIssuanceFailed
    session_id, record = rotated
    return AuthSession(user=user, session_id=session_id, csrf_token=record.csrf_token)


def authenticate_user(
    *,
    db: Session,
    rate_limiter: LoginRateLimiter,
    session_store: SessionStore,
    incoming_session_id: str,
    email: str,
    password: str,
    source_ip: str,
) -> AuthSession:
    normalized_email = normalize_email(email)
    rate_limiter.consume(normalized_email, source_ip)
    user = db.execute(
        select(User).where(User.email == normalized_email).with_for_update()
    ).scalar_one_or_none()
    encoded = user.password_hash if user is not None else _DUMMY_PASSWORD_HASH
    password_matches = verify_password(encoded, password)
    if user is None or not password_matches:
        db.rollback()
        raise InvalidCredentials
    if user.status != "active":
        db.rollback()
        raise AccountUnavailable

    rotated = session_store.rotate(incoming_session_id, user.id)
    if rotated is None:
        db.rollback()
        raise SessionIssuanceFailed
    session_id, record = rotated
    try:
        db.commit()
    except Exception:
        session_store.revoke(session_id)
        db.rollback()
        raise
    rate_limiter.clear_email(normalized_email)
    return AuthSession(user=user, session_id=session_id, csrf_token=record.csrf_token)


def password_reset_account_exists(
    *,
    db: Session,
    email: str,
) -> bool:
    normalized_email = normalize_email(email)
    user_id = db.scalar(select(User.id).where(User.email == normalized_email))
    db.rollback()
    return user_id is not None


def request_password_reset(
    *,
    verification_store: VerificationStore,
    mailer: Mailer,
    email: str,
    source_ip: str,
    account_exists: bool,
) -> None:
    try:
        code = verification_store.issue(
            email,
            purpose="reset",
            source_ip=source_ip,
        )
        if account_exists:
            mailer.send_password_reset(email, code)
    except Exception:
        return


def reset_password(
    *,
    db: Session,
    verification_store: VerificationStore,
    session_store: SessionStore,
    email: str,
    code: str,
    new_password: str,
) -> None:
    normalized_email = normalize_email(email)
    user = db.execute(
        select(User).where(User.email == normalized_email).with_for_update()
    ).scalar_one_or_none()
    try:
        verification_store.consume(normalized_email, code, purpose="reset")
    except InvalidCode as exc:
        db.rollback()
        raise InvalidResetCode from exc
    if user is None:
        db.rollback()
        raise InvalidResetCode

    user.password_hash = hash_password(new_password)
    try:
        session_store.revoke_all(user.id)
        db.commit()
    except Exception as exc:
        db.rollback()
        raise PasswordResetFailed from exc
