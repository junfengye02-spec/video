from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from server.app.assets import models as asset_models  # noqa: F401
from server.app.auth import models as auth_models  # noqa: F401
from server.app.billing import models as billing_models  # noqa: F401
from server.app.core.config import get_settings
from server.app.db.base import Base
from server.app.generation_units import models as generation_unit_models  # noqa: F401
from server.app.payments import models as payment_models  # noqa: F401
from server.app.projects import models as project_models  # noqa: F401
from server.app.tasks import models as task_models  # noqa: F401
from server.app.video_model_settings import models as video_model_setting_models  # noqa: F401
from server.app.wallet import models as wallet_models  # noqa: F401


config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

config.set_main_option("sqlalchemy.url", get_settings().database_url.replace("%", "%%"))
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
