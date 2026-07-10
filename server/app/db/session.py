from collections.abc import Generator

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from server.app.core.config import AppSettings, get_settings


def create_engine_and_session_factory(
    settings: AppSettings,
) -> tuple[Engine, sessionmaker[Session]]:
    engine = create_engine(settings.database_url, pool_pre_ping=True)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    return engine, session_factory


settings = get_settings()
engine, SessionLocal = create_engine_and_session_factory(settings)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
