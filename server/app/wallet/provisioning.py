from __future__ import annotations

import uuid

from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from server.app.auth.provisioning import UserProvisioner
from server.app.wallet.models import WalletAccount


class WalletProvisioner(UserProvisioner):
    def provision(self, db: Session, user_id: str) -> None:
        dialect_name = db.get_bind().dialect.name
        if dialect_name == "postgresql":
            insert_statement = postgresql_insert(WalletAccount)
        elif dialect_name == "sqlite":
            insert_statement = sqlite_insert(WalletAccount)
        else:
            raise RuntimeError(
                f"unsupported wallet database dialect: {dialect_name}"
            )

        db.execute(
            insert_statement.values(
                id=uuid.uuid4().hex,
                user_id=user_id,
                balance_units=0,
                held_units=0,
                version=0,
            ).on_conflict_do_nothing(index_elements=[WalletAccount.user_id])
        )
