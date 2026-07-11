from pathlib import Path

import pytest
import yaml
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from server.app.auth.models import User
from server.app.core.config import AppSettings
from server.app.db.base import Base


ROOT_DIR = Path(__file__).resolve().parents[2]


def _production_settings(**overrides):
    values = {
        "_env_file": None,
        "environment": "production",
        "database_url": "postgresql+psycopg://studio:prod-db-password@db/openmontage",
        "redis_url": "redis://redis:6379/7",
        "redis_prefix": "openmontage:prod:",
        "public_origin": "https://studio.example.com",
        "session_cookie_secure": True,
        "session_idle_seconds": 3600,
        "session_absolute_seconds": 86400,
        "auth_hmac_secret": "x" * 32,
        "smtp_host": "smtp.example.com",
        "smtp_from_address": "noreply@example.com",
        "smtp_username": "mailer",
        "smtp_password": "smtp-password",
    }
    values.update(overrides)
    return values


def test_env_example_does_not_supply_an_auth_secret(monkeypatch):
    monkeypatch.delenv("AUTH_HMAC_SECRET", raising=False)

    with pytest.raises(ValidationError) as exc_info:
        AppSettings(_env_file=ROOT_DIR / ".env.example")

    assert ("auth_hmac_secret",) in [error["loc"] for error in exc_info.value.errors()]


def test_local_infrastructure_ports_bind_to_loopback():
    compose = yaml.safe_load(
        (ROOT_DIR / "deploy" / "docker-compose.infrastructure.yml").read_text(encoding="utf-8")
    )

    assert compose["services"]["postgres"]["ports"] == ["127.0.0.1:5432:5432"]
    assert compose["services"]["redis"]["ports"] == ["127.0.0.1:6379:6379"]


def test_missing_auth_hmac_secret_is_rejected(monkeypatch):
    monkeypatch.delenv("AUTH_HMAC_SECRET", raising=False)

    with pytest.raises(ValidationError):
        AppSettings(_env_file=None)


def test_short_auth_hmac_secret_is_rejected():
    with pytest.raises(ValidationError):
        AppSettings(_env_file=None, auth_hmac_secret="short")


def test_production_rejects_insecure_cookie():
    with pytest.raises(ValidationError, match="production cookies must be secure"):
        AppSettings(**_production_settings(session_cookie_secure=False))


def test_production_rejects_non_https_public_origin():
    with pytest.raises(ValidationError, match="production public_origin must use https"):
        AppSettings(**_production_settings(public_origin="http://studio.example.com"))


@pytest.mark.parametrize(
    "database_url",
    [
        "postgresql+psycopg://openmontage:openmontage@127.0.0.1:5432/openmontage",
        "sqlite+pysqlite:///openmontage.db",
        "postgresql://studio:prod-db-password@db/openmontage",
    ],
)
def test_production_rejects_default_or_non_psycopg_database(database_url):
    with pytest.raises(ValidationError, match="dedicated PostgreSQL psycopg URL"):
        AppSettings(**_production_settings(database_url=database_url))


def test_production_rejects_omitted_database_url(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    values = _production_settings()
    values.pop("database_url")

    with pytest.raises(ValidationError, match="database_url must be explicitly supplied"):
        AppSettings(**values)


def test_production_rejects_shared_redis_database_without_prefix():
    with pytest.raises(ValidationError, match="Redis isolation"):
        AppSettings(
            **_production_settings(redis_url="redis://redis:6379/0", redis_prefix="")
        )


@pytest.mark.parametrize(
    ("redis_url", "redis_prefix"),
    [
        ("redis://redis:6379/7", ""),
        ("redis://redis:6379/0", "openmontage:prod:"),
    ],
)
def test_production_accepts_either_redis_isolation_method(redis_url, redis_prefix):
    settings = AppSettings(
        **_production_settings(redis_url=redis_url, redis_prefix=redis_prefix)
    )

    assert settings.environment == "production"


@pytest.mark.parametrize(
    ("idle", "absolute"),
    [(0, 60), (-1, 60), (61, 60), (60, 0)],
)
def test_session_lifetimes_must_be_positive_and_coherent(idle, absolute):
    with pytest.raises(ValidationError):
        AppSettings(
            **_production_settings(
                session_idle_seconds=idle,
                session_absolute_seconds=absolute,
            )
        )


@pytest.mark.parametrize(
    "missing_field",
    ["smtp_host", "smtp_from_address", "smtp_username", "smtp_password"],
)
def test_production_requires_complete_smtp_configuration(missing_field):
    with pytest.raises(ValidationError, match="production SMTP settings are required"):
        AppSettings(**_production_settings(**{missing_field: None}))


def test_valid_production_settings_are_accepted():
    settings = AppSettings(**_production_settings())

    assert settings.environment == "production"


def test_normalized_email_is_unique():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add(User(id="u1", email="a@example.com", password_hash="hash", role="user", status="active"))
        db.commit()
        db.add(User(id="u2", email="a@example.com", password_hash="hash", role="user", status="active"))
        with pytest.raises(IntegrityError):
            db.commit()
