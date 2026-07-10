# OpenMontage Independent Auth And Project Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an OpenMontage-owned email/password account system with verified registration, secure server sessions, password reset, administrator bootstrap, and server-enforced project/media ownership.

**Architecture:** Keep authentication inside the existing FastAPI application as focused `auth`, `db`, and `projects` modules. PostgreSQL stores users and project metadata, Redis stores hashed one-time codes, rate limits, and opaque server sessions, while project artifacts remain on the existing filesystem. The stable boundary exported to the billing plan is `CurrentUser`, `require_user`, `require_admin`, and a transaction-local `UserProvisioner` hook.

**Tech Stack:** Python 3.10+, FastAPI, Pydantic 2, SQLAlchemy 2, Alembic, PostgreSQL 16, Redis 7, psycopg 3, argon2-cffi, React 18, TypeScript 5.6, React Router 6, Vitest, pytest.

## Global Constraints

- OpenMontage users, sessions, projects, and roles are independent from NewAPI; no NewAPI user, session, access token, or database is used.
- Production uses a dedicated PostgreSQL database and a dedicated Redis database number or `openmontage:` key prefix.
- Registration is email plus password and requires a six-digit email verification code.
- Normalize email with `trim + lowercase`; passwords are 8-64 characters and hashed with Argon2id.
- Verification codes expire after 10 minutes, cannot be resent to one email within 60 seconds, allow at most 5 failed attempts, and are stored only as an HMAC/hash in Redis.
- Verification sends are limited to 5 per normalized email per hour, 30 per source IP per hour, and 300 globally per minute.
- Login attempts are limited to 10 per normalized email per 15 minutes and 30 per source IP per 15 minutes; success clears the email bucket.
- Sessions are opaque random server-side sessions with idle and absolute expiry; cookies are `HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/`.
- Every state-changing route validates same-origin `Origin` and `X-CSRF-Token`; login rotates the session identifier.
- Public registration always creates role `user`; the first administrator is created only by an interactive server command.
- Existing unowned projects are never exposed or automatically claimed by a new user.
- Authentication migrations use revisions `001-009`; billing owns `010-019`.
- Do not expose verification codes, reset tokens, session identifiers, password hashes, NewAPI keys, or provider keys in responses or logs.
- Wait for `docs/superpowers/plans/2026-07-10-openmontage-frontend-optimization.md` to finish before editing `web/src/App.tsx`, shared shell navigation, or shared route wiring.

## Public Interfaces

```python
# server/app/auth/dependencies.py
@dataclass(frozen=True, slots=True)
class CurrentUser:
    id: str
    email: str
    role: Literal["user", "admin"]

def require_user(request: Request, db: Session = Depends(get_db), redis: Redis = Depends(get_redis)) -> CurrentUser: ...
def require_admin(current: CurrentUser = Depends(require_user)) -> CurrentUser: ...
def require_csrf(request: Request, current: CurrentUser = Depends(require_user), redis: Redis = Depends(get_redis)) -> CurrentUser: ...
def require_public_csrf(request: Request, redis: Redis = Depends(get_redis)) -> None: ...

# server/app/auth/provisioning.py
class UserProvisioner(Protocol):
    def provision(self, db: Session, user_id: str) -> None: ...
```

The wallet plan implements `UserProvisioner` and creates `wallet_accounts` in the same PostgreSQL transaction as registration. Until that plan is merged, `NoopUserProvisioner` keeps the authentication subsystem independently testable.

## File Structure

### Create

- `alembic.ini` - Alembic entry point.
- `server/alembic/env.py` - loads SQLAlchemy metadata and production database URL.
- `server/alembic/versions/001_auth_users.py` - users and admin audit foundation.
- `server/alembic/versions/002_owned_projects_nullable.py` - PostgreSQL project metadata with nullable legacy ownership.
- `server/alembic/versions/003_owned_projects_not_null.py` - second-phase ownership constraint after migration audit.
- `server/app/core/config.py` - validated environment settings.
- `server/app/db/base.py` - SQLAlchemy declarative base and timestamp helpers.
- `server/app/db/session.py` - engine/session dependencies.
- `server/app/redis.py` - namespaced Redis dependency.
- `server/app/auth/models.py` - `User` and `AdminAuditLog` tables.
- `server/app/auth/schemas.py` - request/response schemas.
- `server/app/auth/security.py` - Argon2id hashing and secure token helpers.
- `server/app/auth/verification.py` - atomic verification/reset-code storage and rate limits.
- `server/app/auth/mailer.py` - SMTP adapter and test protocol.
- `server/app/auth/sessions.py` - Redis session lifecycle.
- `server/app/auth/dependencies.py` - `CurrentUser`, authentication, administrator, origin, and CSRF dependencies.
- `server/app/auth/provisioning.py` - registration hook consumed by billing.
- `server/app/auth/service.py` - registration, login, logout, and password reset transactions.
- `server/app/auth/router.py` - `/api/auth/*` routes.
- `server/app/projects/models.py` - SQLAlchemy project metadata.
- `server/app/projects/schemas.py` - owner-safe project import schema that excludes trusted IDs and server paths.
- `server/app/projects/repository.py` - owner-scoped project access.
- `server/app/projects/legacy_migration.py` - explicit SQLite-to-PostgreSQL metadata migration.
- `server/manage.py` - interactive `create-admin` and legacy project commands.
- `server/tests/conftest_auth.py` - SQLAlchemy, fakeredis, mailer, and authenticated-client fixtures.
- `server/tests/test_auth_security.py` - password/token invariants.
- `server/tests/test_auth_verification.py` - code TTL, attempts, reuse, and limits.
- `server/tests/test_auth_api.py` - auth API and cookie/CSRF behavior.
- `server/tests/test_project_ownership.py` - horizontal authorization coverage.
- `server/tests/test_manage_admin.py` - administrator bootstrap behavior.
- `web/src/auth/types.ts` - browser auth contract.
- `web/src/auth/api.ts` - credentialed auth requests and CSRF handling.
- `web/src/auth/AuthProvider.tsx` - current-user bootstrap and auth actions.
- `web/src/auth/RequireAuth.tsx` - protected route outlet.
- `web/src/pages/LoginPage.tsx` - login form.
- `web/src/pages/RegisterPage.tsx` - verification plus registration form.
- `web/src/pages/ForgotPasswordPage.tsx` - reset request form.
- `web/src/pages/ResetPasswordPage.tsx` - reset confirmation form.
- `web/src/auth/AuthProvider.test.tsx` - bootstrap/session tests.
- `web/src/pages/AuthPages.test.tsx` - form and generic-error tests.
- `deploy/docker-compose.infrastructure.yml` - local PostgreSQL and Redis only.

### Modify

- `requirements.txt` - production auth/database dependencies.
- `requirements-dev.txt` - fakeredis and migration test dependencies.
- `.env.example` - database, Redis, cookie, origin, HMAC, and SMTP settings without secrets.
- `server/app/settings.py` - compatibility exports backed by `AppSettings`.
- `server/app/models.py` - add `owner_user_id` to the public project response.
- `server/app/storage.py` - keep filesystem artifact responsibilities and delegate project metadata to `ProjectRepository`.
- `server/app/main.py` - install dependencies/router and protect every project/media/event endpoint.
- `server/tests/test_api.py` - use authenticated fixtures and assert owner isolation.
- `web/src/api/client.ts` - credentials, CSRF token, and consistent 401 handling.
- `web/src/api/client.test.ts` - credential and CSRF request contract.
- `web/src/app/routes.ts` - auth routes after the frontend optimization plan lands.
- `web/src/App.tsx` - mount provider and protected/public route groups after the frontend optimization plan lands.
- `web/src/components/shell/AppShell.tsx` - account/logout UI after the frontend optimization plan lands.
- `web/src/i18n.ts` - Chinese and English auth copy.
- `web/src/localdb/exportProject.ts` - re-home imported backups to a new owner-scoped server project ID.
- `web/src/localdb/exportProject.test.ts` - imported legacy IDs are never trusted by the server.
- `README.md` - deployment and administrator bootstrap instructions.

---

### Task 1: PostgreSQL, Redis, Settings, And Migration Foundation

**Files:**
- Create: `server/app/core/config.py`
- Create: `server/app/db/base.py`
- Create: `server/app/db/session.py`
- Create: `server/app/redis.py`
- Create: `server/app/auth/models.py`
- Create: `server/alembic/env.py`
- Create: `server/alembic/versions/001_auth_users.py`
- Create: `alembic.ini`
- Create: `deploy/docker-compose.infrastructure.yml`
- Modify: `requirements.txt`
- Modify: `requirements-dev.txt`
- Modify: `.env.example`
- Test: `server/tests/test_auth_database.py`

**Interfaces:**
- Produces: `AppSettings`, `Base`, `create_engine_and_session_factory(settings)`, `get_db()`, `get_redis()`, `User`, and migration revision `001`.
- Consumes: no auth or billing modules.

- [ ] **Step 1: Write failing database and settings tests**

```python
# server/tests/test_auth_database.py
import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from server.app.auth.models import User
from server.app.core.config import AppSettings
from server.app.db.base import Base


def test_production_rejects_insecure_cookie_and_missing_secrets():
    with pytest.raises(ValidationError):
        AppSettings(
            environment="production",
            database_url="postgresql+psycopg://openmontage:test@db/openmontage",
            redis_url="redis://redis:6379/4",
            public_origin="https://studio.example.com",
            session_cookie_secure=False,
            auth_hmac_secret="short",
        )


def test_normalized_email_is_unique():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add(User(id="u1", email="a@example.com", password_hash="hash", role="user", status="active"))
        db.commit()
        db.add(User(id="u2", email="a@example.com", password_hash="hash", role="user", status="active"))
        with pytest.raises(Exception):
            db.commit()
```

- [ ] **Step 2: Run the focused test and confirm the missing modules fail**

Run: `python -m pytest server/tests/test_auth_database.py -v`

Expected: FAIL with `ModuleNotFoundError: No module named 'server.app.core'`.

- [ ] **Step 3: Add dependencies, validated settings, database base/session, and Redis namespace**

```text
# append to requirements.txt
fastapi>=0.115,<1
uvicorn[standard]>=0.30,<1
sqlalchemy>=2.0,<3
alembic>=1.13,<2
psycopg[binary]>=3.2,<4
redis>=5.2,<6
pydantic-settings>=2.7,<3
argon2-cffi>=23.1,<24
email-validator>=2.2,<3
```

```python
# server/app/core/config.py
from functools import lru_cache
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class AppSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    environment: Literal["development", "test", "production"] = "development"
    database_url: str = "postgresql+psycopg://openmontage:openmontage@127.0.0.1:5432/openmontage"
    redis_url: str = "redis://127.0.0.1:6379/4"
    redis_prefix: str = "openmontage:"
    public_origin: str = "http://127.0.0.1:5173"
    session_cookie_name: str = "om_session"
    session_cookie_secure: bool = True
    session_idle_seconds: int = 7 * 24 * 60 * 60
    session_absolute_seconds: int = 30 * 24 * 60 * 60
    auth_hmac_secret: str = Field(min_length=32)

    @model_validator(mode="after")
    def validate_production(self):
        if self.environment == "production" and not self.session_cookie_secure:
            raise ValueError("production cookies must be secure")
        if self.environment == "production" and not self.public_origin.startswith("https://"):
            raise ValueError("production public_origin must use https")
        return self


@lru_cache
def get_settings() -> AppSettings:
    return AppSettings()
```

```python
# server/app/db/base.py
from datetime import UTC, datetime
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(UTC), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(default=lambda: datetime.now(UTC), onupdate=lambda: datetime.now(UTC), nullable=False)
```

```python
# server/app/auth/models.py
from sqlalchemy import Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column
from server.app.db.base import Base, TimestampMixin


class User(TimestampMixin, Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="user")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    __table_args__ = (Index("uq_users_email", "email", unique=True),)


class AdminAuditLog(Base):
    __tablename__ = "admin_audit_logs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    admin_user_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    object_type: Mapped[str] = mapped_column(String(64), nullable=False)
    object_id: Mapped[str] = mapped_column(String(64), nullable=False)
    before_json: Mapped[str | None] = mapped_column(Text)
    after_json: Mapped[str | None] = mapped_column(Text)
    ip_address: Mapped[str | None] = mapped_column(String(64))
```

Implement `server/app/db/session.py` with one SQLAlchemy engine, `sessionmaker(expire_on_commit=False)`, a yielding `get_db`, and `server/app/redis.py` with `redis.Redis.from_url(..., decode_responses=True)` plus a `redis_key(*parts)` helper that prepends `settings.redis_prefix`.

- [ ] **Step 4: Add Alembic revision `001`, local infrastructure, and run verification**

The `001_auth_users.py` upgrade creates `users` and `admin_audit_logs` with the same names, lengths, nullability, and indexes as the ORM models; downgrade drops audit logs first, then users. `deploy/docker-compose.infrastructure.yml` defines `postgres:16-alpine` on `5432`, `redis:7-alpine` on `6379`, named volumes, and health checks.

Run: `docker compose -f deploy/docker-compose.infrastructure.yml up -d`

Run: `python -m alembic upgrade 001`

Run: `python -m pytest server/tests/test_auth_database.py -v`

Expected: migration succeeds and both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add requirements.txt requirements-dev.txt .env.example alembic.ini deploy/docker-compose.infrastructure.yml server/alembic server/app/core server/app/db server/app/redis.py server/app/auth/models.py server/tests/test_auth_database.py
git commit -m "feat(auth): add database and redis foundation"
```

### Task 2: Password Security, Verification Codes, And SMTP

**Files:**
- Create: `server/app/auth/security.py`
- Create: `server/app/auth/verification.py`
- Create: `server/app/auth/mailer.py`
- Create: `server/tests/test_auth_security.py`
- Create: `server/tests/test_auth_verification.py`
- Modify: `server/app/core/config.py`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `AppSettings`, `redis_key`.
- Produces: `normalize_email(str) -> str`, `hash_password(str) -> str`, `verify_password(hash, password) -> bool`, `VerificationStore.issue/consume`, and `Mailer.send_verification/send_password_reset`.

- [ ] **Step 1: Write security and one-time-code tests**

```python
# server/tests/test_auth_security.py
from server.app.auth.security import hash_password, normalize_email, verify_password


def test_password_uses_argon2id_and_email_is_normalized():
    encoded = hash_password("correct horse")
    assert encoded.startswith("$argon2id$")
    assert verify_password(encoded, "correct horse") is True
    assert verify_password(encoded, "wrong horse") is False
    assert normalize_email("  Person@Example.COM ") == "person@example.com"
```

```python
# server/tests/test_auth_verification.py
import fakeredis
import pytest
from server.app.auth.verification import InvalidCode, VerificationStore


def test_code_is_single_use_and_limited_to_five_attempts():
    redis = fakeredis.FakeRedis(decode_responses=True)
    store = VerificationStore(redis, prefix="test:", hmac_secret=b"x" * 32)
    code = store.issue("person@example.com", purpose="register", now=100)
    assert redis.get("test:verification:register:person@example.com") != code
    for _ in range(4):
        with pytest.raises(InvalidCode):
            store.consume("person@example.com", "000000", purpose="register", now=101)
    store.consume("person@example.com", code, purpose="register", now=102)
    with pytest.raises(InvalidCode):
        store.consume("person@example.com", code, purpose="register", now=103)
```

- [ ] **Step 2: Run tests and confirm they fail before implementation**

Run: `python -m pytest server/tests/test_auth_security.py server/tests/test_auth_verification.py -v`

Expected: FAIL because the security and verification modules do not exist.

- [ ] **Step 3: Implement Argon2id, HMAC codes, atomic consumption, and mail protocol**

```python
# server/app/auth/security.py
import secrets
from argon2 import PasswordHasher, Type
from argon2.exceptions import VerifyMismatchError

_hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=2, hash_len=32, salt_len=16, type=Type.ID)


def normalize_email(value: str) -> str:
    return value.strip().lower()


def hash_password(password: str) -> str:
    if not 8 <= len(password) <= 64:
        raise ValueError("password must be 8-64 characters")
    return _hasher.hash(password)


def verify_password(encoded: str, password: str) -> bool:
    try:
        return _hasher.verify(encoded, password)
    except VerifyMismatchError:
        return False


def random_token(bytes_count: int = 32) -> str:
    return secrets.token_urlsafe(bytes_count)
```

`VerificationStore.issue()` uses `secrets.randbelow(1_000_000)` formatted to six digits, stores `HMAC-SHA256(secret, purpose + ':' + email + ':' + code)` with TTL 600, and sets email resend key TTL 60 with `SET NX`. One Redis Lua script enforces 5/email/hour, 30/IP/hour, and 300/global/minute counters before issuing. `consume()` uses a second Lua script to compare the hash, increment attempts, delete at 5 failures, and delete immediately on success, so two concurrent confirmations cannot both succeed.

```python
# server/app/auth/mailer.py
from typing import Protocol


class Mailer(Protocol):
    def send_verification(self, email: str, code: str) -> None: ...
    def send_password_reset(self, email: str, code: str) -> None: ...


class MemoryMailer:
    def __init__(self): self.messages: list[tuple[str, str, str]] = []
    def send_verification(self, email: str, code: str) -> None: self.messages.append(("register", email, code))
    def send_password_reset(self, email: str, code: str) -> None: self.messages.append(("reset", email, code))
```

Add `SmtpMailer` using `smtplib.SMTP_SSL` or STARTTLS from settings; message bodies contain only the code, purpose, 10-minute expiry, and ignore warning. Do not log the code.

- [ ] **Step 4: Run the focused tests**

Run: `python -m pytest server/tests/test_auth_security.py server/tests/test_auth_verification.py -v`

Expected: PASS, including the stored-value-not-plaintext assertion and one-time consumption.

- [ ] **Step 5: Commit**

```bash
git add .env.example server/app/core/config.py server/app/auth/security.py server/app/auth/verification.py server/app/auth/mailer.py server/tests/test_auth_security.py server/tests/test_auth_verification.py
git commit -m "feat(auth): add secure email verification"
```

### Task 3: Opaque Sessions, CSRF, And Stable CurrentUser Dependencies

**Files:**
- Create: `server/app/auth/sessions.py`
- Create: `server/app/auth/dependencies.py`
- Create: `server/app/auth/provisioning.py`
- Test: `server/tests/test_auth_sessions.py`

**Interfaces:**
- Consumes: `User`, `AppSettings`, Redis.
- Produces: `SessionRecord(user_id: str | None, csrf_token: str, created_at: int, last_seen_at: int, absolute_expires_at: int)`, `SessionStore.from_settings/create/get/rotate/revoke/revoke_all`, anonymous CSRF sessions, `CurrentUser`, `require_user`, `require_admin`, `require_csrf`, `require_public_csrf`, `UserProvisioner`, and `NoopUserProvisioner`.

- [ ] **Step 1: Write session rotation, idle expiry, origin, and CSRF tests**

```python
# server/tests/test_auth_sessions.py
import fakeredis
from server.app.auth.sessions import SessionStore


def test_rotation_revokes_old_session_and_preserves_user():
    redis = fakeredis.FakeRedis(decode_responses=True)
    store = SessionStore(redis, prefix="test:", idle_seconds=60, absolute_seconds=300)
    old_id, old = store.create("u1", now=100)
    new_id, new = store.rotate(old_id, now=101)
    assert old.user_id == new.user_id == "u1"
    assert new_id != old_id
    assert store.get(old_id, now=102) is None
    assert store.get(new_id, now=102).csrf_token == new.csrf_token


def test_idle_expiry_never_extends_past_absolute_expiry():
    redis = fakeredis.FakeRedis(decode_responses=True)
    store = SessionStore(redis, prefix="test:", idle_seconds=60, absolute_seconds=120)
    session_id, _ = store.create("u1", now=100)
    assert store.get(session_id, now=159) is not None
    assert store.get(session_id, now=221) is None
```

- [ ] **Step 2: Run the tests and verify the session module is missing**

Run: `python -m pytest server/tests/test_auth_sessions.py -v`

Expected: FAIL with `ModuleNotFoundError`.

- [ ] **Step 3: Implement namespaced sessions and request dependencies**

```python
# server/app/auth/dependencies.py
import secrets
from dataclasses import dataclass
from typing import Literal
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


def validate_origin(request: Request, expected_origin: str) -> None:
    if request.method not in {"GET", "HEAD", "OPTIONS"} and request.headers.get("origin") != expected_origin:
        raise HTTPException(status_code=403, detail="Invalid request origin")


def require_csrf(
    request: Request,
    current: CurrentUser = Depends(require_user),
    redis: Redis = Depends(get_redis),
    settings: AppSettings = Depends(get_settings),
) -> CurrentUser:
    validate_origin(request, settings.public_origin)
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
    validate_origin(request, settings.public_origin)
    record = load_session(request, redis, settings)
    supplied = request.headers.get("X-CSRF-Token", "")
    if not supplied or not secrets.compare_digest(supplied, record.csrf_token):
        raise HTTPException(status_code=403, detail="Invalid CSRF token")
```

`SessionStore.create(user_id=None)` creates the anonymous session used only to bootstrap CSRF before login/registration; it cannot satisfy `require_user`. `SessionStore.rotate(session_id, user_id=None)` preserves the prior user when the argument is omitted and binds the authenticated user when login/registration passes `user_id=current_user.id`. `require_user` hashes the cookie value before using it in a Redis key, loads `SessionRecord`, rejects an anonymous record, loads the active `User` by primary key, and returns `CurrentUser`. Authenticated and public CSRF dependencies first call `validate_origin`, then use `secrets.compare_digest` against the current session token. Missing/invalid sessions return 401; invalid CSRF/origin returns 403; banned users revoke all sessions and return 403.

```python
# server/app/auth/provisioning.py
from typing import Protocol
from sqlalchemy.orm import Session


class UserProvisioner(Protocol):
    def provision(self, db: Session, user_id: str) -> None: ...


class NoopUserProvisioner:
    def provision(self, db: Session, user_id: str) -> None:
        return None
```

- [ ] **Step 4: Run the session tests**

Run: `python -m pytest server/tests/test_auth_sessions.py -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app/auth/sessions.py server/app/auth/dependencies.py server/app/auth/provisioning.py server/tests/test_auth_sessions.py
git commit -m "feat(auth): add server sessions and csrf"
```

### Task 4: Registration, Login, Logout, Me, And Password Reset API

**Files:**
- Create: `server/app/auth/schemas.py`
- Create: `server/app/auth/service.py`
- Create: `server/app/auth/router.py`
- Create: `server/tests/conftest_auth.py`
- Create: `server/tests/test_auth_api.py`
- Modify: `server/app/main.py`

**Interfaces:**
- Consumes: Tasks 1-3 plus `UserProvisioner.provision(db, user_id)`.
- Produces: all `/api/auth/*` endpoints, anonymous `GET /api/auth/csrf`, and response shape `{user: {id,email,role}, csrf_token}`.

- [ ] **Step 1: Write complete route contract tests**

```python
# server/tests/test_auth_api.py
def test_register_requires_code_and_ignores_requested_role(auth_client, verification_store, mailer):
    auth_client.post("/api/auth/email-verifications", json={"email": "Person@Example.com"})
    code = mailer.messages[-1][2]
    response = auth_client.post("/api/auth/register", json={
        "email": " Person@Example.com ", "password": "correct horse", "code": code, "role": "admin"
    })
    assert response.status_code == 201
    assert response.json()["user"]["email"] == "person@example.com"
    assert response.json()["user"]["role"] == "user"
    assert response.cookies["om_session"]
    assert response.json()["csrf_token"]


def test_login_error_does_not_reveal_account_existence(auth_client):
    missing = auth_client.post("/api/auth/login", json={"email": "none@example.com", "password": "wrong-pass"})
    existing = auth_client.post("/api/auth/login", json={"email": "person@example.com", "password": "wrong-pass"})
    assert missing.status_code == existing.status_code == 401
    assert missing.json() == existing.json() == {"detail": "Email or password is incorrect"}


def test_password_reset_revokes_all_existing_sessions(auth_client, registered_user, mailer):
    before = auth_client.get("/api/auth/me")
    assert before.status_code == 200
    auth_client.post("/api/auth/password-reset/request", json={"email": registered_user.email})
    code = mailer.messages[-1][2]
    reset = auth_client.post("/api/auth/password-reset/confirm", json={
        "email": registered_user.email, "code": code, "new_password": "new secure password"
    })
    assert reset.status_code == 204
    assert auth_client.get("/api/auth/me").status_code == 401
```

- [ ] **Step 2: Run route tests and confirm 404 responses**

Run: `python -m pytest server/tests/test_auth_api.py -v`

Expected: FAIL because `/api/auth/*` returns 404.

- [ ] **Step 3: Implement schemas, service transactions, cookie helpers, and router**

```python
# server/app/auth/schemas.py
from typing import Literal
from pydantic import BaseModel, EmailStr, Field


class EmailRequest(BaseModel):
    email: EmailStr


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=64)
    code: str = Field(pattern=r"^\d{6}$")
    role: str | None = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=64)


class UserResponse(BaseModel):
    id: str
    email: EmailStr
    role: Literal["user", "admin"]
```

The registration service consumes the verification code before insertion, inserts `User(role="user")`, calls `provisioner.provision(db, user.id)` before `db.commit()`, creates the session only after commit, and rotates any incoming session. Login atomically enforces 10/email/15-minute and 30/IP/15-minute Redis buckets, uses one dummy Argon2 hash when the email does not exist so the error path has equivalent work, and clears the email bucket on success. Reset always returns the same request response, consumes purpose `reset`, replaces the Argon2id hash, commits, and revokes all sessions.

```python
# server/app/auth/router.py (route surface)
router = APIRouter(prefix="/api/auth", tags=["auth"])
router.get("/csrf")(csrf_bootstrap)
router.post("/email-verifications", status_code=202, dependencies=[Depends(require_public_csrf)])(send_verification)
router.post("/register", status_code=201, dependencies=[Depends(require_public_csrf)])(register)
router.post("/login", dependencies=[Depends(require_public_csrf)])(login)
router.post("/logout", status_code=204, dependencies=[Depends(require_csrf)])(logout)
router.post("/logout-all", status_code=204, dependencies=[Depends(require_csrf)])(logout_all)
router.get("/me")(me)
router.post("/password-reset/request", status_code=202, dependencies=[Depends(require_public_csrf)])(request_password_reset)
router.post("/password-reset/confirm", status_code=204, dependencies=[Depends(require_public_csrf)])(confirm_password_reset)
```

Set cookies with `httponly=True`, `secure=settings.session_cookie_secure`, `samesite="lax"`, `path="/"`, and no readable auth data. Include the auth router once in `create_app`.

- [ ] **Step 4: Run auth API tests**

Run: `python -m pytest server/tests/test_auth_api.py -v`

Expected: PASS for registration, duplicate email, session rotation, generic login errors, logout, logout-all, reset enumeration resistance, reset one-time use, cookie flags, origin, and CSRF.

- [ ] **Step 5: Commit**

```bash
git add server/app/auth/schemas.py server/app/auth/service.py server/app/auth/router.py server/tests/conftest_auth.py server/tests/test_auth_api.py server/app/main.py
git commit -m "feat(auth): add account api"
```

### Task 5: Interactive Administrator Bootstrap And Role Auditing

**Files:**
- Create: `server/manage.py`
- Create: `server/tests/test_manage_admin.py`
- Modify: `server/app/auth/service.py`

**Interfaces:**
- Consumes: `normalize_email`, `hash_password`, SQLAlchemy session.
- Produces: `python -m server.manage create-admin` and audited `set-role` service callable only by an existing admin.

- [ ] **Step 1: Write CLI tests**

```python
# server/tests/test_manage_admin.py
def test_create_admin_reads_password_from_getpass_and_never_argv(monkeypatch, db_session, capsys):
    monkeypatch.setattr("server.manage.getpass", lambda prompt: "correct horse")
    monkeypatch.setattr("server.manage.input", lambda prompt: "admin@example.com")
    code = run_manage(["create-admin"], db_session=db_session)
    assert code == 0
    assert "correct horse" not in capsys.readouterr().out
    user = db_session.query(User).filter_by(email="admin@example.com").one()
    assert user.role == "admin"


def test_public_registration_cannot_create_admin(auth_client, verification_code):
    response = auth_client.post("/api/auth/register", json={
        "email": "user@example.com", "password": "correct horse", "code": verification_code, "role": "admin"
    })
    assert response.json()["user"]["role"] == "user"
```

- [ ] **Step 2: Run CLI tests**

Run: `python -m pytest server/tests/test_manage_admin.py -v`

Expected: FAIL because `server.manage` does not exist.

- [ ] **Step 3: Implement the command and audited role mutation**

`create-admin` accepts no password flag, prompts email with `input`, prompts twice with `getpass`, rejects non-matching or invalid passwords, creates or promotes the email, and writes `AdminAuditLog(action="admin.bootstrap")`. `set-role` is a service function requiring `CurrentUser.role == "admin"`, records before/after role JSON, and revokes target sessions after commit.

```python
# server/manage.py (entry point)
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("create-admin")
    args = parser.parse_args(argv)
    if args.command == "create-admin":
        email = normalize_email(input("Admin email: "))
        password = getpass("Password: ")
        if password != getpass("Confirm password: "):
            raise SystemExit("Passwords do not match")
        return create_admin(email, password)
    return 2
```

- [ ] **Step 4: Run CLI and auth tests**

Run: `python -m pytest server/tests/test_manage_admin.py server/tests/test_auth_api.py -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/manage.py server/app/auth/service.py server/tests/test_manage_admin.py
git commit -m "feat(auth): add administrator bootstrap"
```

### Task 6: Owner-Scoped PostgreSQL Projects And Two-Phase Legacy Migration

**Files:**
- Create: `server/app/projects/models.py`
- Create: `server/app/projects/schemas.py`
- Create: `server/app/projects/repository.py`
- Create: `server/app/projects/legacy_migration.py`
- Create: `server/alembic/versions/002_owned_projects_nullable.py`
- Create: `server/alembic/versions/003_owned_projects_not_null.py`
- Create: `server/tests/test_project_ownership.py`
- Modify: `server/app/storage.py`
- Modify: `server/app/models.py`
- Modify: `server/app/main.py`
- Modify: `server/manage.py`
- Modify: `server/tests/test_api.py`

**Interfaces:**
- Consumes: `CurrentUser`, `require_user`, `require_csrf`, SQLAlchemy session.
- Produces: `ProjectRepository.create/list/get_owned/require_owned`, owner-safe filesystem access, explicit `migrate-legacy-projects`, and explicit `assign-project` admin commands.

- [ ] **Step 1: Write horizontal-authorization matrix tests**

```python
# server/tests/test_project_ownership.py
import pytest


@pytest.mark.parametrize("method,path_suffix", [
    ("GET", ""),
    ("PATCH", "/continuity"),
    ("POST", "/assets/upload"),
    ("GET", "/media/assets/images/character/a.png"),
    ("PATCH", "/shots/s1"),
    ("POST", "/prompt-optimize"),
    ("POST", "/shots/s1/regenerate"),
    ("POST", "/render"),
    ("GET", "/events"),
])
def test_other_users_project_is_hidden_as_404(method, path_suffix, alice_client, bob_project):
    response = alice_client.request(method, f"/api/projects/{bob_project.id}{path_suffix}")
    assert response.status_code == 404


def test_project_creation_always_sets_current_owner(alice_client, db_session):
    response = alice_client.post("/api/projects", json={"title": "Mine", "project_type": "single_video"})
    project_id = response.json()["project"]["id"]
    assert db_session.get(ProjectRecord, project_id).owner_user_id == alice_client.user.id


def test_unowned_legacy_project_is_not_visible(alice_client, unowned_project):
    assert alice_client.get(f"/api/projects/{unowned_project.id}").status_code == 404


def test_import_ignores_legacy_server_id_and_assigns_current_owner(alice_client, db_session):
    response = alice_client.post("/api/projects/import", json={
        "legacy_project_id": "project-owned-by-someone-else",
        "title": "Imported",
        "project_type": "single_video",
        "series_bible": {"title": "Imported", "characters": [], "assets": []},
        "storyboard": {"shots": []},
        "continuity_plan": {"project_type": "single_video"},
    })
    assert response.status_code == 201
    imported_id = response.json()["project"]["id"]
    assert imported_id != "project-owned-by-someone-else"
    assert db_session.get(ProjectRecord, imported_id).owner_user_id == alice_client.user.id
```

- [ ] **Step 2: Run the ownership tests and observe cross-user access**

Run: `python -m pytest server/tests/test_project_ownership.py -v`

Expected: FAIL because current routes trust only `project_id` and the SQLite store has no owner.

- [ ] **Step 3: Implement project records, owner repository, and artifact-only storage**

```python
# server/app/projects/repository.py
class ProjectRepository:
    def __init__(self, db: Session):
        self.db = db

    def create(self, *, owner_user_id: str, title: str, mode: str, project_type: str) -> ProjectRecord:
        record = ProjectRecord(id=uuid.uuid4().hex, owner_user_id=owner_user_id, title=title, mode=mode, project_type=project_type)
        self.db.add(record)
        self.db.flush()
        return record

    def get_owned(self, project_id: str, owner_user_id: str) -> ProjectRecord | None:
        return self.db.scalar(select(ProjectRecord).where(
            ProjectRecord.id == project_id,
            ProjectRecord.owner_user_id == owner_user_id,
        ))

    def require_owned(self, project_id: str, owner_user_id: str) -> ProjectRecord:
        project = self.get_owned(project_id, owner_user_id)
        if project is None:
            raise HTTPException(status_code=404, detail="Project not found")
        return project
```

`WorkbenchStore` stops opening or initializing SQLite and keeps only `project_dir`, artifact JSON, asset-library, and directory methods. `_project_snapshot` receives an already authorized `ProjectRecord`. Every project-scoped route calls `repository.require_owned(project_id, current.id)` before any filesystem path or event stream is opened. All mutations use `Depends(require_csrf)`; GET endpoints use `Depends(require_user)`.

Add `GET /api/projects` filtered by `owner_user_id`, ordered by `updated_at DESC`. Remove/keep disabled `/api/projects/latest`; never restore a global latest-project query.

Add `POST /api/projects/import` under `require_csrf`. `ProjectImportRequest` treats `legacy_project_id` as informational only, rejects absolute/server media paths and oversized artifact JSON, creates a fresh UUID through `ProjectRepository.create`, assigns the current user, and writes only validated artifact fields. Local media references stay browser-local until uploaded through the already owner-checked media endpoint.

- [ ] **Step 4: Implement the two migration phases and legacy command**

Revision `002` creates PostgreSQL `projects` with nullable `owner_user_id` FK and index. `migrate-legacy-projects --sqlite-path workbench.sqlite3` copies metadata with `owner_user_id=NULL`, never assigns an owner, and prints exact project IDs. `assign-project --project-id ID --owner-email EMAIL` requires an admin operator and writes an audit row. Revision `003` first asserts `SELECT COUNT(*) FROM projects WHERE owner_user_id IS NULL` is zero, then sets the column `NOT NULL`; it aborts with an actionable error otherwise.

Run: `python -m alembic upgrade 002`

Run: `python -m server.manage migrate-legacy-projects --sqlite-path workbench.sqlite3`

Run: `python -m pytest server/tests/test_project_ownership.py server/tests/test_api.py -v`

Expected: all ownership tests PASS; unowned projects return 404.

- [ ] **Step 5: Commit**

```bash
git add server/app/projects server/app/storage.py server/app/models.py server/app/main.py server/manage.py server/alembic/versions/002_owned_projects_nullable.py server/alembic/versions/003_owned_projects_not_null.py server/tests/test_project_ownership.py server/tests/test_api.py
git commit -m "feat(auth): enforce project ownership"
```

### Task 7: Browser Auth Client, Provider, Pages, And Route Guards

**Files:**
- Create: `web/src/auth/types.ts`
- Create: `web/src/auth/api.ts`
- Create: `web/src/auth/AuthProvider.tsx`
- Create: `web/src/auth/RequireAuth.tsx`
- Create: `web/src/auth/AuthProvider.test.tsx`
- Create: `web/src/pages/LoginPage.tsx`
- Create: `web/src/pages/RegisterPage.tsx`
- Create: `web/src/pages/ForgotPasswordPage.tsx`
- Create: `web/src/pages/ResetPasswordPage.tsx`
- Create: `web/src/pages/AuthPages.test.tsx`
- Modify after frontend-plan merge: `web/src/api/client.ts`
- Modify after frontend-plan merge: `web/src/api/client.test.ts`
- Modify after frontend-plan merge: `web/src/app/routes.ts`
- Modify after frontend-plan merge: `web/src/App.tsx`
- Modify after frontend-plan merge: `web/src/components/shell/AppShell.tsx`
- Modify: `web/src/i18n.ts`

**Interfaces:**
- Consumes: auth API from Task 4.
- Produces: `useAuth()`, credentialed JSON client, guarded application routes, login/register/reset pages, account/logout shell actions.

- [ ] **Step 1: Wait for the frontend optimization merge and write provider/page tests**

Confirm first: `git log --oneline -- docs/superpowers/plans/2026-07-10-openmontage-frontend-optimization.md web/src/App.tsx`

Expected: the frontend optimization implementation is present in the branch being integrated; if it is still active in another worktree, implement only the new `web/src/auth/*` and page files, then postpone shared-file wiring until its commit is merged.

```tsx
// web/src/auth/AuthProvider.test.tsx
it("boots from /api/auth/me and exposes the current user", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
    user: { id: "u1", email: "person@example.com", role: "user" }, csrf_token: "csrf"
  }), { status: 200, headers: { "Content-Type": "application/json" } })));
  render(<AuthProvider><Probe /></AuthProvider>);
  expect(await screen.findByText("person@example.com")).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith("/api/auth/me", expect.objectContaining({ credentials: "include" }));
});

it("renders protected children only after authentication", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 401 })));
  render(<MemoryRouter initialEntries={["/projects"]}><AuthProvider><Routes>
    <Route element={<RequireAuth />}><Route path="/projects" element={<div>private</div>} /></Route>
    <Route path="/login" element={<div>login</div>} />
  </Routes></AuthProvider></MemoryRouter>);
  expect(await screen.findByText("login")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run browser tests and confirm missing auth components**

Run: `npm test -- --run src/auth/AuthProvider.test.tsx src/pages/AuthPages.test.tsx`

Working directory: `web`

Expected: FAIL because auth files do not exist.

- [ ] **Step 3: Implement credentialed requests, provider state, pages, and guard**

```ts
// web/src/auth/api.ts
let csrfToken: string | null = null;

export function setCsrfToken(value: string | null) { csrfToken = value; }

export async function authRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(method !== "GET" && method !== "HEAD" && csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string };
    throw new Error(body.detail ?? `Request failed with status ${response.status}`);
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}
```

`AuthProvider` boots from `/api/auth/me`; on 401 it calls `/api/auth/csrf` to create an anonymous CSRF session before rendering public forms. It stores only user and CSRF token in memory, exposes `login`, `register`, and `logout`, and clears state on any later 401 notification from the shared client. Do not store sessions or CSRF tokens in localStorage/IndexedDB. The verification send and password-reset request pages always show neutral success copy. After parsing an `.omproj` backup, call `/api/projects/import`, replace the local snapshot's project ID with the new server ID, and never send the backup's legacy server ID as an ownership claim.

Use normal compact account forms, password manager compatible `autocomplete` values, field-level validation, disabled submit state, and `aria-live` errors. No provider-key UI appears on auth pages.

- [ ] **Step 4: Wire public and protected routes and run frontend verification**

Add routes `/login`, `/register`, `/forgot-password`, `/reset-password`; place `/projects` and every `/projects/:projectId/*` route under `<Route element={<RequireAuth />}>`. Add an account menu and logout command to `AppShell`. Update shared `requestJson` and `requestForm` to `credentials: "include"` and CSRF headers for mutations.

Run: `npm test -- --run`

Run: `npm run build`

Working directory: `web`

Expected: all Vitest tests PASS and TypeScript/Vite build succeeds.

- [ ] **Step 5: Commit**

```bash
git add web/src/auth web/src/pages/LoginPage.tsx web/src/pages/RegisterPage.tsx web/src/pages/ForgotPasswordPage.tsx web/src/pages/ResetPasswordPage.tsx web/src/pages/AuthPages.test.tsx web/src/api/client.ts web/src/api/client.test.ts web/src/app/routes.ts web/src/App.tsx web/src/components/shell/AppShell.tsx web/src/i18n.ts web/src/localdb/exportProject.ts web/src/localdb/exportProject.test.ts
git commit -m "feat(auth): add browser account flow"
```

### Task 8: Security Regression, Migration Gate, And Deployment Documentation

**Files:**
- Create: `server/tests/test_auth_security_regression.py`
- Create: `server/tests/test_auth_postgres.py`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `server/app/main.py`
- Modify: `server/app/settings.py`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: production-ready auth/project deployment gate and the stable contracts required by the billing plan.

- [ ] **Step 1: Write final security and PostgreSQL integration tests**

```python
# server/tests/test_auth_security_regression.py
def test_session_cookie_and_secrets_never_appear_in_json(auth_client, registered_user):
    response = auth_client.post("/api/auth/login", json={"email": registered_user.email, "password": "correct horse"})
    text = response.text
    assert "password_hash" not in text
    assert "om_session" not in text


def test_mutation_rejects_missing_origin_and_csrf(alice_client, alice_project):
    response = alice_client.patch(
        f"/api/projects/{alice_project.id}/continuity",
        headers={"Origin": "https://evil.example"},
        json={"project_type": "single_video"},
    )
    assert response.status_code == 403


def test_media_path_check_happens_after_owner_check(alice_client, bob_project):
    response = alice_client.get(f"/api/projects/{bob_project.id}/media/../../.env")
    assert response.status_code == 404
```

- [ ] **Step 2: Run all backend tests before migration phase two**

Run: `python -m pytest server/tests -v`

Expected: PASS.

- [ ] **Step 3: Exercise PostgreSQL migration and ownership gate**

Run: `python -m alembic upgrade 002`

Run: `python -m server.manage migrate-legacy-projects --sqlite-path workbench.sqlite3`

Run: `python -m server.manage list-unowned-projects`

Expected: command prints every remaining unowned ID; assign or explicitly archive each project.

Run: `python -m alembic upgrade 003`

Expected: succeeds only when the unowned count is zero.

- [ ] **Step 4: Document exact deployment and handoff contract**

Document PostgreSQL/Redis startup, required secrets, HTTPS requirement, proxy forwarding of `Origin` and cookies, `python -m server.manage create-admin`, phase-one/phase-two project migration, rollback, and session revocation. Add a billing handoff section naming only these imports:

```python
from server.app.auth.dependencies import CurrentUser, require_admin, require_csrf, require_user
from server.app.auth.provisioning import UserProvisioner
from server.app.db.session import get_db
```

Run: `rg -n "NEWAPI.*KEY|password|session" README.md .env.example`

Expected: examples contain variable names with empty example assignments only, never live credentials.

- [ ] **Step 5: Commit**

```bash
git add README.md .env.example server/app/main.py server/app/settings.py server/tests/test_auth_security_regression.py server/tests/test_auth_postgres.py
git commit -m "test(auth): harden account and ownership boundaries"
```

## Completion Gate

Run all of the following from `C:\Users\zhuba\Desktop\OpenMontage\videro`:

```bash
python -m pytest server/tests -v
python -m alembic current
python -m alembic check
cd web && npm test -- --run && npm run build
```

Expected: backend tests PASS, Alembic reports revision `003` with no pending model changes, frontend tests PASS, and the production build succeeds. Manually verify that Alice cannot load Bob's project, media, SSE events, or guessed file path; reset revokes all sessions; and no browser storage contains a session or provider key.
