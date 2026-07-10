from __future__ import annotations

import argparse
import sys
from builtins import input
from getpass import getpass

from sqlalchemy.orm import Session

from server.app.auth.security import normalize_email
from server.app.auth.service import bootstrap_admin
from server.app.auth.sessions import SessionStore


class _ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(2, f"{self.prog}: error: invalid arguments\n")


def _parser() -> argparse.ArgumentParser:
    parser = _ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("create-admin")
    return parser


def _run_command(
    args: argparse.Namespace,
    db: Session,
    session_store: SessionStore,
) -> int:
    if args.command == "create-admin":
        email = normalize_email(input("Admin email: "))
        password = getpass("Password: ")
        confirmation = getpass("Confirm password: ")
        if password != confirmation:
            print("Passwords do not match.", file=sys.stderr)
            return 2
        if not 8 <= len(password) <= 64:
            print("Password must be 8-64 characters.", file=sys.stderr)
            return 2
        try:
            bootstrap_admin(
                db=db,
                session_store=session_store,
                email=email,
                password=password,
            )
        except Exception:
            print("Administrator bootstrap could not be completed.", file=sys.stderr)
            return 1
        print("Administrator account is ready.")
        return 0
    return 2


def run_manage(
    argv: list[str] | None = None,
    *,
    db_session: Session | None = None,
    session_store: SessionStore | None = None,
) -> int:
    args = _parser().parse_args(argv)
    if db_session is not None or session_store is not None:
        if db_session is None or session_store is None:
            raise ValueError("database session and session store must be supplied together")
        return _run_command(args, db_session, session_store)

    from server.app.core.config import get_settings
    from server.app.db.session import SessionLocal
    from server.app.redis import get_redis

    settings = get_settings()
    session_store = SessionStore.from_settings(get_redis(), settings)
    with SessionLocal() as db:
        return _run_command(args, db, session_store)


def main(argv: list[str] | None = None) -> int:
    return run_manage(argv)


if __name__ == "__main__":
    raise SystemExit(main())
