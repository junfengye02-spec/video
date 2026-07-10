from typing import Protocol

from sqlalchemy.orm import Session


class UserProvisioner(Protocol):
    def provision(self, db: Session, user_id: str) -> None: ...


class NoopUserProvisioner:
    def provision(self, db: Session, user_id: str) -> None:
        return None
