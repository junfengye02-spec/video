from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from server.app.auth.provisioning import UserProvisioner
from server.app.wallet.models import WalletAccount


class WalletProvisioner(UserProvisioner):
    def provision(self, db: Session, user_id: str) -> None:
        db.add(
            WalletAccount(
                id=uuid.uuid4().hex,
                user_id=user_id,
                balance_units=0,
                held_units=0,
                version=0,
            )
        )
