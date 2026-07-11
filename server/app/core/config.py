from functools import lru_cache
from typing import Literal
from urllib.parse import urlparse

from pydantic import EmailStr, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url


class AppSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    environment: Literal["development", "test", "production"] = "development"
    database_url: str = "postgresql+psycopg://openmontage:openmontage@127.0.0.1:5432/openmontage"
    redis_url: str = "redis://127.0.0.1:6379/4"
    redis_prefix: str = "openmontage:"
    public_origin: str = "http://127.0.0.1:5173"
    session_cookie_name: str = "om_session"
    session_cookie_secure: bool = True
    session_idle_seconds: int = Field(default=7 * 24 * 60 * 60, gt=0)
    session_absolute_seconds: int = Field(default=30 * 24 * 60 * 60, gt=0)
    auth_hmac_secret: str = Field(min_length=32)
    smtp_host: str | None = None
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_from_address: EmailStr | None = None
    smtp_username: str | None = None
    smtp_password: SecretStr | None = None
    smtp_tls_mode: Literal["ssl", "starttls"] = "starttls"
    epay_pay_address: str | None = None
    epay_id: str | None = None
    epay_key: SecretStr | None = None

    @field_validator(
        "smtp_host",
        "smtp_from_address",
        "smtp_username",
        "smtp_password",
        "epay_pay_address",
        "epay_id",
        "epay_key",
        mode="before",
    )
    @classmethod
    def empty_optional_values_are_unset(cls, value):
        return None if value == "" else value

    @field_validator("epay_pay_address")
    @classmethod
    def validate_epay_pay_address(cls, value: str | None) -> str | None:
        if value is None:
            return None
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("epay_pay_address must be an absolute HTTP(S) URL")
        return value

    @model_validator(mode="after")
    def validate_production(self):
        if self.session_idle_seconds > self.session_absolute_seconds:
            raise ValueError("session idle lifetime cannot exceed absolute lifetime")
        epay_values = (self.epay_pay_address, self.epay_id, self.epay_key)
        if any(value is not None for value in epay_values) and any(
            value is None for value in epay_values
        ):
            raise ValueError(
                "epay_pay_address, epay_id, and epay_key must be configured together"
            )
        if self.environment != "production":
            return self

        issues: list[str] = []
        if not self.session_cookie_secure:
            issues.append("production cookies must be secure")
        if not self.public_origin.startswith("https://"):
            issues.append("production public_origin must use https")

        if "database_url" not in self.model_fields_set:
            issues.append("production database_url must be explicitly supplied")
        try:
            database = make_url(self.database_url)
        except Exception:
            database = None
        if (
            database is None
            or database.drivername != "postgresql+psycopg"
            or database.host in {None, "127.0.0.1", "localhost"}
            or (database.username, database.password) == ("openmontage", "openmontage")
        ):
            issues.append("production requires a dedicated PostgreSQL psycopg URL")

        redis = urlparse(self.redis_url)
        try:
            redis_db = int(redis.path.lstrip("/") or "0")
        except ValueError:
            redis_db = -1
        redis_prefix = self.redis_prefix.strip().lower()
        has_dedicated_prefix = redis_prefix.startswith("openmontage:")
        if redis.scheme not in {"redis", "rediss"} or redis_db < 0:
            issues.append("production Redis URL is invalid")
        elif redis_db == 0 and not has_dedicated_prefix:
            issues.append("production Redis isolation requires a nonzero DB or OpenMontage prefix")

        smtp_values = (
            self.smtp_host,
            self.smtp_from_address,
            self.smtp_username,
            self.smtp_password,
        )
        if any(value is None for value in smtp_values):
            issues.append("production SMTP settings are required")

        if issues:
            raise ValueError("; ".join(issues))
        return self


@lru_cache
def get_settings() -> AppSettings:
    return AppSettings()
