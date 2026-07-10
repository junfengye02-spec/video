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
