import ipaddress
import json
import re
from collections.abc import Mapping
from functools import lru_cache
from typing import Annotated, Literal
from urllib.parse import urlparse

from pydantic import (
    EmailStr,
    Field,
    SecretStr,
    ValidationError,
    field_validator,
    model_validator,
)
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict
from sqlalchemy.engine import make_url


class AppSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        extra="ignore",
        hide_input_in_errors=True,
        populate_by_name=True,
        env_ignore_empty=True,
    )
    environment: Literal["development", "test", "production"] = "development"
    database_url: str = "postgresql+psycopg://openmontage:openmontage@127.0.0.1:5432/openmontage"
    redis_url: str = "redis://127.0.0.1:6379/4"
    redis_prefix: str = "openmontage:"
    public_origin: str = "http://127.0.0.1:5173"
    session_cookie_name: str = "om_session"
    session_cookie_secure: bool = False
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
    newapi_base_url: str = "http://127.0.0.1:3000"
    newapi_text_token_keys: Annotated[dict[str, SecretStr], NoDecode] = Field(
        default_factory=dict,
        validation_alias="NEWAPI_TEXT_TOKEN_KEYS_JSON",
    )
    newapi_text_current_token_alias: str | None = None
    newapi_text_fixed_group: str = Field(
        default="openmontage-text", min_length=1, max_length=200
    )
    newapi_planning_text_model: str = Field(
        default="gpt-5.5", min_length=1, max_length=200
    )
    newapi_image_token_keys: Annotated[dict[str, SecretStr], NoDecode] = Field(
        default_factory=dict,
        validation_alias="NEWAPI_IMAGE_TOKEN_KEYS_JSON",
    )
    newapi_image_current_token_alias: str | None = None
    newapi_image_fixed_group: str = Field(
        default="openmontage-image", min_length=1, max_length=200
    )
    newapi_video_token_keys: Annotated[dict[str, SecretStr], NoDecode] = Field(
        default_factory=dict,
        validation_alias="NEWAPI_VIDEO_TOKEN_KEYS_JSON",
    )
    newapi_video_current_token_alias: str | None = None
    newapi_video_fixed_group: str = Field(
        default="openmontage-video", min_length=1, max_length=200
    )
    newapi_video_download_host: str | None = None
    billing_reference_recovery_seconds: int = Field(
        default=86_400, gt=0, strict=True
    )
    billing_receipt_deadline_seconds: int = Field(
        default=86_400, gt=0, strict=True
    )
    billing_hold_timeout_seconds: int = Field(default=86_400, gt=0, strict=True)
    billing_quote_stale_retries: int = Field(default=2, gt=0, strict=True)
    billing_max_video_bytes: int = Field(
        default=536_870_912, gt=0, strict=True
    )
    billing_default_multiplier_bps: int | None = Field(default=None, gt=0, strict=True)
    billing_worker_heartbeat_ttl_seconds: int = Field(default=15, gt=0, strict=True)
    generation_units_v2: bool = False

    def __init__(self, **values):
        try:
            super().__init__(**values)
        except ValidationError as exc:
            raise ValidationError.from_exception_data(
                exc.title,
                exc.errors(include_input=False),
                hide_input=True,
            ) from None

    @field_validator(
        "smtp_host",
        "smtp_from_address",
        "smtp_username",
        "smtp_password",
        "epay_pay_address",
        "epay_id",
        "epay_key",
        "newapi_video_download_host",
        mode="before",
    )
    @classmethod
    def empty_optional_values_are_unset(cls, value):
        return None if value == "" else value

    @field_validator(
        "billing_reference_recovery_seconds",
        "billing_receipt_deadline_seconds",
        "billing_hold_timeout_seconds",
        "billing_quote_stale_retries",
        "billing_max_video_bytes",
        "billing_default_multiplier_bps",
        "billing_worker_heartbeat_ttl_seconds",
        mode="before",
    )
    @classmethod
    def parse_positive_integer_settings(cls, value):
        if value is None:
            return None
        if type(value) is int:
            return value
        if type(value) is str and re.fullmatch(r"[1-9][0-9]*", value):
            return int(value)
        raise ValueError("billing safety settings must be positive integers")

    @field_validator(
        "newapi_text_token_keys",
        "newapi_image_token_keys",
        "newapi_video_token_keys",
        mode="before",
    )
    @classmethod
    def parse_newapi_keyring(cls, value):
        if isinstance(value, Mapping):
            return value
        if type(value) is not str:
            raise ValueError("NewAPI token keyrings must be JSON objects")

        def reject_duplicate_aliases(
            pairs: list[tuple[str, object]],
        ) -> dict[str, object]:
            keyring: dict[str, object] = {}
            for alias, secret in pairs:
                if alias in keyring:
                    raise ValueError("duplicate NewAPI token alias")
                keyring[alias] = secret
            return keyring

        try:
            parsed = json.loads(value, object_pairs_hook=reject_duplicate_aliases)
        except (json.JSONDecodeError, ValueError):
            raise ValueError("NewAPI token keyrings must be unique JSON objects") from None
        if type(parsed) is not dict:
            raise ValueError("NewAPI token keyrings must be JSON objects")
        return parsed

    @field_validator("epay_pay_address")
    @classmethod
    def validate_epay_pay_address(cls, value: str | None) -> str | None:
        if value is None:
            return None
        parsed = urlparse(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("epay_pay_address must be an absolute HTTP(S) URL")
        return value

    @field_validator("newapi_base_url")
    @classmethod
    def validate_newapi_base_url(cls, value: str) -> str:
        parsed = urlparse(value)
        try:
            port = parsed.port
        except ValueError as exc:
            raise ValueError("newapi_base_url must be a clean HTTP(S) origin") from exc
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.params
            or parsed.query
            or parsed.fragment
            or (port is not None and not 1 <= port <= 65_535)
        ):
            raise ValueError("newapi_base_url must be a clean HTTP(S) origin")
        return f"{parsed.scheme}://{parsed.netloc}"

    @field_validator("newapi_video_download_host")
    @classmethod
    def validate_newapi_video_download_host(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.lower()
        try:
            ipaddress.ip_address(normalized)
        except ValueError:
            pass
        else:
            raise ValueError("newapi_video_download_host must be a DNS hostname")
        hostname = re.fullmatch(
            r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
            r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?",
            normalized,
        )
        if hostname is None:
            raise ValueError("newapi_video_download_host must be a DNS hostname")
        return normalized

    @model_validator(mode="after")
    def validate_newapi_keyrings(self):
        for kind in ("text", "image", "video"):
            keyring = getattr(self, f"newapi_{kind}_token_keys")
            current_alias = getattr(self, f"newapi_{kind}_current_token_alias")
            if not keyring and current_alias is None:
                continue
            for alias, secret in keyring.items():
                secret_value = secret.get_secret_value()
                if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", alias) is None:
                    raise ValueError("NewAPI token aliases are invalid")
                if not secret_value.strip() or len(secret_value) > 4096:
                    raise ValueError("NewAPI token values are invalid")
            if not current_alias or current_alias not in keyring:
                raise ValueError(
                    "each configured NewAPI keyring requires a current alias"
                )
        return self

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
