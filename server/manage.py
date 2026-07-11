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
    commands.add_parser("list-unowned-projects")
    assign = commands.add_parser("assign-project")
    assign.add_argument("--project-id", required=True)
    assign.add_argument("--owner-email", required=True)
    reconcile = commands.add_parser("reconcile-billing")
    reconcile.add_argument("--once", action="store_true", required=True)
    return parser


def _run_command(
    args: argparse.Namespace,
    db: Session,
    session_store: SessionStore | None,
    *,
    billing_client=None,
    billing_settings=None,
    media_store=None,
) -> int:
    if args.command == "create-admin":
        if session_store is None:
            raise ValueError("create-admin requires a session store")
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
    if args.command == "list-unowned-projects":
        project_ids = db.scalars(
            select(ProjectRecord.id)
            .where(ProjectRecord.owner_user_id.is_(None))
            .order_by(ProjectRecord.id)
        ).all()
        for project_id in project_ids:
            print(project_id)
        return 0
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
    if args.command == "reconcile-billing":
        if billing_client is None or billing_settings is None or media_store is None:
            raise ValueError("billing reconciliation dependencies are unavailable")
        from datetime import datetime, timezone

        from server.app.billing.reconciliation import reconcile_due_jobs

        reconcile_due_jobs(
            db,
            billing_client,
            datetime.now(timezone.utc),
            100,
            settings=billing_settings,
            media_store=media_store,
        )
        return 0
    return 2


def run_manage(
    argv: list[str] | None = None,
    *,
    db_session: Session | None = None,
    session_store: SessionStore | None = None,
    billing_client=None,
    media_store=None,
    settings=None,
) -> int:
    args = _parser().parse_args(argv)
    if db_session is not None:
        if args.command != "reconcile-billing" and session_store is None:
            raise ValueError("database session and session store must be supplied together")
        return _run_command(
            args,
            db_session,
            session_store,
            billing_client=billing_client,
            billing_settings=settings,
            media_store=media_store,
        )
    if session_store is not None:
        raise ValueError("database session and session store must be supplied together")
    if billing_client is not None or media_store is not None:
        raise ValueError("injected dependencies require a database session")

    from server.app.core.config import get_settings
    from server.app.db.session import SessionLocal

    settings = settings or get_settings()
    if args.command == "reconcile-billing":
        from server.app.provider.newapi import NewApiClient
        from server.app.settings import DEFAULT_PROJECTS_ROOT
        from server.app.storage import WorkbenchStore

        client = NewApiClient(settings)
        try:
            with SessionLocal() as db:
                return _run_command(
                    args,
                    db,
                    None,
                    billing_client=client,
                    billing_settings=settings,
                    media_store=WorkbenchStore(projects_root=DEFAULT_PROJECTS_ROOT),
                )
        finally:
            client.close()

    from server.app.redis import get_redis

    resolved_session_store = SessionStore.from_settings(get_redis(), settings)
    with SessionLocal() as db:
        return _run_command(args, db, resolved_session_store)


def main(argv: list[str] | None = None) -> int:
    return run_manage(argv)


if __name__ == "__main__":
    raise SystemExit(main())
