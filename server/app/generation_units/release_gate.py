from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import inspect, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session


GENERATION_UNITS_CONTRACT_VERSION = 2
GENERATION_UNITS_REQUIRED_REVISION = "020"

_REQUIRED_COLUMNS = {
    "video_model_duration_settings": {
        "provider",
        "model_id",
        "call_duration_seconds",
        "version",
    },
    "video_generation_units": {
        "source_segment_ids_json",
        "prompt_segments_json",
        "profile_revision",
        "profile_json",
    },
}


@dataclass(frozen=True)
class GenerationUnitsReleaseStatus:
    ready: bool
    database_revision: str | None
    missing_tables: tuple[str, ...]
    missing_columns: tuple[str, ...]


class GenerationUnitsReleaseGateError(RuntimeError):
    def __init__(self, code: str, **details: Any):
        super().__init__(code)
        self.code = code
        self.details = details


def generation_units_release_status(
    db: Session,
    *,
    allow_unversioned_test_schema: bool = False,
) -> GenerationUnitsReleaseStatus:
    try:
        connection = db.connection()
        database = inspect(connection)
        table_names = set(database.get_table_names())
        missing_tables = tuple(sorted(set(_REQUIRED_COLUMNS) - table_names))
        missing_columns: list[str] = []
        for table_name, required in _REQUIRED_COLUMNS.items():
            if table_name not in table_names:
                continue
            actual = {column["name"] for column in database.get_columns(table_name)}
            missing_columns.extend(
                f"{table_name}.{column_name}"
                for column_name in sorted(required - actual)
            )
        database_revision = None
        if "alembic_version" in table_names:
            database_revision = connection.execute(
                text("SELECT version_num FROM alembic_version")
            ).scalar_one_or_none()
    except (SQLAlchemyError, ValueError) as exc:
        raise GenerationUnitsReleaseGateError(
            "generation_units_schema_unavailable"
        ) from exc

    revision_ready = _revision_at_least_required(database_revision)
    if allow_unversioned_test_schema and database_revision is None:
        revision_ready = True
    return GenerationUnitsReleaseStatus(
        ready=not missing_tables and not missing_columns and revision_ready,
        database_revision=database_revision,
        missing_tables=missing_tables,
        missing_columns=tuple(missing_columns),
    )


def require_generation_units_release(
    db: Session,
    *,
    enabled: bool,
    environment: str,
    client_contract_version: int | None,
) -> GenerationUnitsReleaseStatus:
    if not enabled:
        raise GenerationUnitsReleaseGateError("generation_units_v2_disabled")
    if (
        client_contract_version != GENERATION_UNITS_CONTRACT_VERSION
        and not (environment == "test" and client_contract_version is None)
    ):
        raise GenerationUnitsReleaseGateError(
            "generation_units_contract_incompatible",
            expected_contract_version=GENERATION_UNITS_CONTRACT_VERSION,
            received_contract_version=client_contract_version,
        )
    status = generation_units_release_status(
        db,
        allow_unversioned_test_schema=environment == "test",
    )
    if not status.ready:
        raise GenerationUnitsReleaseGateError(
            "generation_units_schema_not_ready",
            required_database_revision=GENERATION_UNITS_REQUIRED_REVISION,
            database_revision=status.database_revision,
            missing_tables=list(status.missing_tables),
            missing_columns=list(status.missing_columns),
        )
    return status


def _revision_at_least_required(value: str | None) -> bool:
    if value is None:
        return False
    try:
        return int(value) >= int(GENERATION_UNITS_REQUIRED_REVISION)
    except ValueError:
        return value == GENERATION_UNITS_REQUIRED_REVISION


__all__ = [
    "GENERATION_UNITS_CONTRACT_VERSION",
    "GENERATION_UNITS_REQUIRED_REVISION",
    "GenerationUnitsReleaseGateError",
    "GenerationUnitsReleaseStatus",
    "generation_units_release_status",
    "require_generation_units_release",
]
