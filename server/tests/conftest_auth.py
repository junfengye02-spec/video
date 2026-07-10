import importlib
import os

import fakeredis
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

os.environ.setdefault("AUTH_HMAC_SECRET", "x" * 32)

from server.app.auth.mailer import MemoryMailer
from server.app.auth.models import User
from server.app.auth.provisioning import UserProvisioner
from server.app.auth.sessions import SessionStore
from server.app.auth.verification import VerificationStore
from server.app.core.config import AppSettings, get_settings
from server.app.db.base import Base
from server.app.db.session import get_db
from server.app.main import create_app
from server.app.redis import get_redis


AUTH_ORIGIN = "https://studio.example.com"
AUTH_PREFIX = "test-auth:"


class RecordingProvisioner(UserProvisioner):
    def __init__(self) -> None:
        self.calls: list[tuple[Session, str]] = []
        self.users_were_persistent: list[bool] = []
        self.fail = False

    def provision(self, db: Session, user_id: str) -> None:
        self.calls.append((db, user_id))
        self.users_were_persistent.append(
            any(
                isinstance(instance, User) and instance.id == user_id
                for instance in db.identity_map.values()
            )
        )
        if self.fail:
            raise RuntimeError("provisioning failed")


@pytest.fixture
def auth_settings() -> AppSettings:
    return AppSettings(
        _env_file=None,
        environment="test",
        database_url="sqlite+pysqlite:///:memory:",
        redis_url="redis://unused/0",
        redis_prefix=AUTH_PREFIX,
        public_origin=AUTH_ORIGIN,
        session_cookie_name="om_session",
        session_cookie_secure=True,
        session_idle_seconds=60,
        session_absolute_seconds=300,
        auth_hmac_secret="x" * 32,
    )


@pytest.fixture
def auth_redis():
    return fakeredis.FakeRedis(decode_responses=True)


@pytest.fixture
def auth_db():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as db:
        yield db
    engine.dispose()


@pytest.fixture
def mailer() -> MemoryMailer:
    return MemoryMailer()


@pytest.fixture
def provisioner() -> RecordingProvisioner:
    return RecordingProvisioner()


@pytest.fixture
def verification_store(auth_redis, auth_settings) -> VerificationStore:
    return VerificationStore(
        auth_redis,
        prefix=auth_settings.redis_prefix,
        hmac_secret=auth_settings.auth_hmac_secret,
    )


@pytest.fixture
def session_store(auth_redis, auth_settings) -> SessionStore:
    return SessionStore.from_settings(auth_redis, auth_settings)


@pytest.fixture
def auth_app(
    tmp_path,
    auth_db,
    auth_redis,
    auth_settings,
    mailer,
    provisioner,
    verification_store,
):
    app = create_app(
        db_path=tmp_path / "workbench.db",
        projects_root=tmp_path / "projects",
    )
    app.dependency_overrides[get_db] = lambda: auth_db
    app.dependency_overrides[get_redis] = lambda: auth_redis
    app.dependency_overrides[get_settings] = lambda: auth_settings

    try:
        auth_router = importlib.import_module("server.app.auth.router")
    except ModuleNotFoundError as exc:
        if exc.name != "server.app.auth.router":
            raise
    else:
        app.dependency_overrides[auth_router.get_mailer] = lambda: mailer
        app.dependency_overrides[auth_router.get_provisioner] = lambda: provisioner
        app.dependency_overrides[auth_router.get_verification_store] = (
            lambda: verification_store
        )
    return app


@pytest.fixture
def auth_client(auth_app):
    with TestClient(
        auth_app,
        base_url=AUTH_ORIGIN,
        raise_server_exceptions=False,
    ) as client:
        yield client
