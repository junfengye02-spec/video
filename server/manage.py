from __future__ import annotations

import argparse
import json
import sys
import uuid
from builtins import input
from getpass import getpass

from sqlalchemy import select
from sqlalchemy.orm import Session

from server.app.auth.models import AdminAuditLog, User
from server.app.auth.security import normalize_email, verify_password
from server.app.auth.service import bootstrap_admin
from server.app.auth.sessions import SessionStore
from server.app.projects.legacy_migration import migrate_legacy_projects
from server.app.projects.models import ProjectRecord


class _ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(2, f"{self.prog}: error: invalid arguments\n")


def _parser() -> argparse.ArgumentParser:
    parser = _ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("create-admin")
    migrate = commands.add_parser("migrate-legacy-projects")
    migrate.add_argument("--sqlite-path", required=True)
    assign = commands.add_parser("assign-project")
    assign.add_argument("--project-id", required=True)
    assign.add_argument("--owner-email", required=True)
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
    if args.command == "migrate-legacy-projects":
        try:
            result = migrate_legacy_projects(db, args.sqlite_path)
        except Exception:
            print("Legacy project migration could not be completed.", file=sys.stderr)
            return 1
        for project_id in result.imported_ids:
            print(f"Imported project ID: {project_id}")
        for project_id in result.skipped_ids:
            print(f"Already migrated project ID: {project_id}")
        for project_id in result.conflict_ids:
            print(f"Conflicting project ID: {project_id}", file=sys.stderr)
        return 1 if result.conflict_ids else 0
    if args.command == "assign-project":
        operator_email = normalize_email(input("Admin operator email: "))
        operator_password = getpass("Admin password: ")
        try:
            operator = db.scalar(
                select(User).where(User.email == operator_email).with_for_update()
            )
            if (
                operator is None
                or operator.role != "admin"
                or operator.status != "active"
                or not verify_password(operator.password_hash, operator_password)
            ):
                db.rollback()
                print("Administrator verification failed.", file=sys.stderr)
                return 1
            owner_email = normalize_email(args.owner_email)
            owner = db.scalar(
                select(User).where(User.email == owner_email).with_for_update()
            )
            project = db.scalar(
                select(ProjectRecord)
                .where(ProjectRecord.id == args.project_id)
                .with_for_update()
            )
            if owner is None or owner.status != "active" or project is None:
                db.rollback()
                print("Project assignment could not be completed.", file=sys.stderr)
                return 1
            if project.owner_user_id is not None:
                db.rollback()
                print("Project assignment could not be completed.", file=sys.stderr)
                return 1
            before_owner_id = project.owner_user_id
            project.owner_user_id = owner.id
            db.add(
                AdminAuditLog(
                    id=uuid.uuid4().hex,
                    admin_user_id=operator.id,
                    action="admin.assign_project",
                    object_type="project",
                    object_id=project.id,
                    before_json=json.dumps(
                        {"owner_user_id": before_owner_id},
                        sort_keys=True,
                        separators=(",", ":"),
                    ),
                    after_json=json.dumps(
                        {"owner_user_id": owner.id},
                        sort_keys=True,
                        separators=(",", ":"),
                    ),
                    ip_address=None,
                )
            )
            db.commit()
        except Exception:
            db.rollback()
            print("Project assignment could not be completed.", file=sys.stderr)
            return 1
        print(f"Assigned project ID: {project.id}")
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
