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
        AppSettings(
            environment="production",
            database_url="postgresql+psycopg://openmontage:test@db/openmontage",
            redis_url="redis://redis:6379/4",
            public_origin="https://studio.example.com",
            session_cookie_secure=False,
            auth_hmac_secret="x" * 32,
        )


def test_production_rejects_non_https_public_origin():
    with pytest.raises(ValidationError, match="production public_origin must use https"):
        AppSettings(
            environment="production",
            database_url="postgresql+psycopg://openmontage:test@db/openmontage",
            redis_url="redis://redis:6379/4",
            public_origin="http://studio.example.com",
            session_cookie_secure=True,
            auth_hmac_secret="x" * 32,
        )


def test_valid_production_settings_are_accepted():
    settings = AppSettings(
        environment="production",
        database_url="postgresql+psycopg://openmontage:test@db/openmontage",
        redis_url="redis://redis:6379/4",
        public_origin="https://studio.example.com",
        session_cookie_secure=True,
        auth_hmac_secret="x" * 32,
    )

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
