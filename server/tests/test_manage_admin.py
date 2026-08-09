import json
from contextlib import nullcontext
from pathlib import Path
import subprocess
import sys

import pytest
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

pytest_plugins = ["server.tests.conftest_auth"]

from server.app.auth.models import AdminAuditLog, User
from server.app.auth.security import hash_password, verify_password
from server.app.auth.service import bootstrap_admin
from server.app.db.base import Base
from server.app.wallet.models import WalletAccount
from server.manage import run_manage


PASSWORD = "correct horse"
ROOT_DIR = Path(__file__).resolve().parents[2]


def _prompt_credentials(monkeypatch, *, password: str, confirmation: str) -> None:
    monkeypatch.setattr("server.manage.input", lambda prompt: "admin@example.com")
    answers = iter([password, confirmation])
    monkeypatch.setattr("server.manage.getpass", lambda prompt: next(answers))


def test_create_admin_prompts_twice_and_writes_non_secret_audit(
    monkeypatch, auth_db, session_store, capsys
):
    prompts: list[str] = []
    passwords = iter([PASSWORD, PASSWORD])
    monkeypatch.setattr("server.manage.input", lambda prompt: " Admin@Example.COM ")
    monkeypatch.setattr(
        "server.manage.getpass",
        lambda prompt: prompts.append(prompt) or next(passwords),
    )

    code = run_manage(
        ["create-admin"],
        db_session=auth_db,
        session_store=session_store,
    )

    captured = capsys.readouterr()
    assert code == 0
    assert len(prompts) == 2
    assert PASSWORD not in captured.out + captured.err
    user = auth_db.scalar(select(User).where(User.email == "admin@example.com"))
    assert user is not None
    assert user.role == "admin"
    assert user.status == "active"
    assert verify_password(user.password_hash, PASSWORD)
    audit = auth_db.scalar(select(AdminAuditLog))
    assert audit is not None
    assert audit.id
    assert audit.admin_user_id == user.id
    assert audit.action == "admin.bootstrap"
    assert audit.object_type == "user"
    assert audit.object_id == user.id
    assert json.loads(audit.before_json) == {"role": None}
    assert json.loads(audit.after_json) == {"role": "admin"}
    assert audit.ip_address is None
    rendered_audit = audit.before_json + audit.after_json
    assert PASSWORD not in rendered_audit
    assert user.password_hash not in rendered_audit
    wallet = auth_db.scalar(
        select(WalletAccount).where(WalletAccount.user_id == user.id)
    )
    assert wallet is not None
    assert wallet.balance_units == 0
    assert wallet.held_units == 0


def test_create_admin_new_user_does_not_depend_on_session_revocation(
    monkeypatch, auth_db, session_store
):
    _prompt_credentials(monkeypatch, password=PASSWORD, confirmation=PASSWORD)

    def fail_revocation(user_id):
        raise RuntimeError("redis unavailable")

    monkeypatch.setattr(session_store, "revoke_all", fail_revocation)

    code = run_manage(
        ["create-admin"],
        db_session=auth_db,
        session_store=session_store,
    )

    assert code == 0
    assert auth_db.scalar(select(func.count()).select_from(User)) == 1
    assert auth_db.scalar(select(func.count()).select_from(AdminAuditLog)) == 1


def test_create_admin_rejects_partial_dependency_injection_before_prompt(
    monkeypatch, auth_db, session_store
):
    monkeypatch.setattr(
        "server.manage.input",
        lambda prompt: pytest.fail("incomplete dependencies must fail before prompting"),
    )

    with pytest.raises(ValueError, match="must be supplied together"):
        run_manage(["create-admin"], db_session=auth_db)
    with pytest.raises(ValueError, match="must be supplied together"):
        run_manage(["create-admin"], session_store=session_store)


def test_create_admin_rejects_password_mismatch_without_db_mutation(
    monkeypatch, auth_db, session_store, capsys
):
    confirmation = "different password"
    _prompt_credentials(
        monkeypatch,
        password=PASSWORD,
        confirmation=confirmation,
    )

    code = run_manage(
        ["create-admin"],
        db_session=auth_db,
        session_store=session_store,
    )

    rendered = capsys.readouterr()
    assert code == 2
    assert auth_db.scalar(select(func.count()).select_from(User)) == 0
    assert auth_db.scalar(select(func.count()).select_from(AdminAuditLog)) == 0
    assert PASSWORD not in rendered.out + rendered.err
    assert confirmation not in rendered.out + rendered.err


@pytest.mark.parametrize("password", ["short7", "x" * 65])
def test_create_admin_rejects_password_outside_8_to_64_characters(
    monkeypatch, auth_db, session_store, capsys, password
):
    _prompt_credentials(monkeypatch, password=password, confirmation=password)

    code = run_manage(
        ["create-admin"],
        db_session=auth_db,
        session_store=session_store,
    )

    rendered = capsys.readouterr()
    assert code == 2
    assert auth_db.scalar(select(func.count()).select_from(User)) == 0
    assert auth_db.scalar(select(func.count()).select_from(AdminAuditLog)) == 0
    assert password not in rendered.out + rendered.err


@pytest.mark.parametrize(
    "argv",
    [
        ["create-admin", "argv-password"],
        ["create-admin", "--password", "argv-password"],
        ["create-admin", "--password-file", "secret-password.txt"],
    ],
)
def test_create_admin_rejects_password_argv_without_prompt_or_secret_echo(
    monkeypatch, auth_db, session_store, capsys, argv
):
    monkeypatch.setattr(
        "server.manage.input",
        lambda prompt: pytest.fail("invalid argv must be rejected before prompting"),
    )
    monkeypatch.setattr(
        "server.manage.getpass",
        lambda prompt: pytest.fail("invalid argv must be rejected before prompting"),
    )

    with pytest.raises(SystemExit) as exc_info:
        run_manage(argv, db_session=auth_db, session_store=session_store)

    rendered = capsys.readouterr()
    assert exc_info.value.code == 2
    assert argv[-1] not in rendered.out + rendered.err
    assert auth_db.scalar(select(func.count()).select_from(User)) == 0
    assert auth_db.scalar(select(func.count()).select_from(AdminAuditLog)) == 0


def test_create_admin_promotes_existing_user_in_place(
    monkeypatch, auth_db, session_store, capsys
):
    old_password = "old password"
    user = User(
        id="existing000000000000000000000001",
        email="admin@example.com",
        password_hash=hash_password(old_password),
        role="user",
        status="disabled",
    )
    auth_db.add(user)
    auth_db.commit()
    old_session_id, _ = session_store.create(user.id)
    events = []
    real_commit = auth_db.commit
    real_revoke_all = session_store.revoke_all

    def record_commit():
        events.append("commit")
        return real_commit()

    def record_revoke_all(user_id):
        events.append(("revoke_all", user_id))
        return real_revoke_all(user_id)

    monkeypatch.setattr(auth_db, "commit", record_commit)
    monkeypatch.setattr(session_store, "revoke_all", record_revoke_all)
    _prompt_credentials(monkeypatch, password=PASSWORD, confirmation=PASSWORD)
    monkeypatch.setattr("server.manage.input", lambda prompt: " Admin@Example.COM ")

    code = run_manage(
        ["create-admin"],
        db_session=auth_db,
        session_store=session_store,
    )

    captured = capsys.readouterr()
    auth_db.expire_all()
    persisted = auth_db.scalar(select(User).where(User.email == "admin@example.com"))
    audits = auth_db.scalars(select(AdminAuditLog)).all()
    assert code == 0
    assert persisted.id == user.id
    assert persisted.role == "admin"
    assert persisted.status == "active"
    assert events == [("revoke_all", user.id), "commit"]
    assert session_store.get(old_session_id) is None
    assert verify_password(persisted.password_hash, PASSWORD)
    assert not verify_password(persisted.password_hash, old_password)
    assert auth_db.scalar(select(func.count()).select_from(User)) == 1
    assert len(audits) == 1
    assert audits[0].id
    assert audits[0].admin_user_id == user.id
    assert audits[0].object_id == user.id
    assert json.loads(audits[0].before_json) == {"role": "user"}
    assert json.loads(audits[0].after_json) == {"role": "admin"}
    rendered = captured.out + captured.err + audits[0].before_json + audits[0].after_json
    assert PASSWORD not in rendered
    assert persisted.password_hash not in rendered


def test_create_admin_rolls_back_user_and_audit_on_commit_failure(
    monkeypatch, auth_db, session_store, capsys
):
    old_password = "old password"
    original_hash = hash_password(old_password)
    user = User(
        id="rollback000000000000000000000001",
        email="admin@example.com",
        password_hash=original_hash,
        role="user",
        status="disabled",
    )
    auth_db.add(user)
    auth_db.commit()
    old_session_id, _ = session_store.create(user.id)
    _prompt_credentials(monkeypatch, password=PASSWORD, confirmation=PASSWORD)

    def fail_commit():
        raise RuntimeError("database-password-leak")

    monkeypatch.setattr(auth_db, "commit", fail_commit)

    code = run_manage(
        ["create-admin"],
        db_session=auth_db,
        session_store=session_store,
    )

    rendered = capsys.readouterr()
    auth_db.expire_all()
    persisted = auth_db.get(User, user.id)
    assert code == 1
    assert persisted.role == "user"
    assert persisted.status == "disabled"
    assert persisted.password_hash == original_hash
    assert auth_db.scalar(select(func.count()).select_from(AdminAuditLog)) == 0
    assert session_store.get(old_session_id) is None
    assert PASSWORD not in rendered.out + rendered.err
    assert "database-password-leak" not in rendered.out + rendered.err


class _NoUserResult:
    def scalar_one_or_none(self):
        return None


def test_create_admin_recovers_from_concurrent_duplicate_by_rereading_locked_row(
    monkeypatch, tmp_path, session_store
):
    engine = create_engine(f"sqlite+pysqlite:///{tmp_path / 'bootstrap.db'}")
    Base.metadata.create_all(engine)
    competitor_id = "competitor0000000000000000000001"
    competitor_session_id = None
    statements = []
    with Session(engine, expire_on_commit=False) as db:
        real_execute = db.execute

        def insert_competitor_after_missing_read(statement, *args, **kwargs):
            nonlocal competitor_session_id
            statements.append(statement)
            if len(statements) == 1:
                with Session(engine) as competitor_db:
                    competitor_db.add(
                        User(
                            id=competitor_id,
                            email="admin@example.com",
                            password_hash=hash_password("competitor password"),
                            role="admin",
                            status="active",
                        )
                    )
                    competitor_db.commit()
                competitor_session_id, _ = session_store.create(competitor_id)
                return _NoUserResult()
            return real_execute(statement, *args, **kwargs)

        monkeypatch.setattr(db, "execute", insert_competitor_after_missing_read)

        user = bootstrap_admin(
            db=db,
            session_store=session_store,
            email=" Admin@Example.COM ",
            password=PASSWORD,
        )

        db.expire_all()
        users = db.scalars(select(User)).all()
        audits = db.scalars(select(AdminAuditLog)).all()
        assert user.id == competitor_id
        assert len(statements) == 2
        assert all(statement._for_update_arg is not None for statement in statements)
        assert len(users) == 1
        assert users[0].id == competitor_id
        assert verify_password(users[0].password_hash, PASSWORD)
        assert session_store.get(competitor_session_id) is None
        assert len(audits) == 1
        assert audits[0].admin_user_id == competitor_id
        assert audits[0].object_id == competitor_id
        assert json.loads(audits[0].before_json) == {"role": "admin"}
        assert json.loads(audits[0].after_json) == {"role": "admin"}
    engine.dispose()


def test_create_admin_revocation_failure_rolls_back_promotion_and_audit(
    monkeypatch, auth_db, session_store, capsys
):
    old_password = "old password"
    original_hash = hash_password(old_password)
    user = User(
        id="revoke0000000000000000000000001",
        email="admin@example.com",
        password_hash=original_hash,
        role="user",
        status="disabled",
    )
    auth_db.add(user)
    auth_db.commit()
    old_session_id, _ = session_store.create(user.id)
    _prompt_credentials(monkeypatch, password=PASSWORD, confirmation=PASSWORD)

    def fail_revocation(user_id):
        raise RuntimeError("redis-password-leak")

    monkeypatch.setattr(session_store, "revoke_all", fail_revocation)

    code = run_manage(
        ["create-admin"],
        db_session=auth_db,
        session_store=session_store,
    )

    rendered = capsys.readouterr()
    auth_db.expire_all()
    persisted = auth_db.get(User, user.id)
    assert code == 1
    assert persisted.role == "user"
    assert persisted.status == "disabled"
    assert persisted.password_hash == original_hash
    assert auth_db.scalar(select(func.count()).select_from(AdminAuditLog)) == 0
    assert session_store.get(old_session_id) is not None
    assert "redis-password-leak" not in rendered.out + rendered.err
    assert PASSWORD not in rendered.out + rendered.err


def test_create_admin_rollback_failure_preserves_generic_service_error(
    monkeypatch, auth_db, session_store
):
    from server.app.auth.service import AdminBootstrapFailed

    user = User(
        id="cleanup000000000000000000000000",
        email="admin@example.com",
        password_hash=hash_password("old password"),
        role="user",
        status="active",
    )
    auth_db.add(user)
    auth_db.commit()

    def fail_commit():
        raise RuntimeError("database-password-leak")

    def fail_rollback():
        raise RuntimeError("rollback-password-leak")

    monkeypatch.setattr(auth_db, "commit", fail_commit)
    monkeypatch.setattr(auth_db, "rollback", fail_rollback)

    with pytest.raises(AdminBootstrapFailed) as exc_info:
        bootstrap_admin(
            db=auth_db,
            session_store=session_store,
            email=user.email,
            password=PASSWORD,
        )

    assert str(exc_info.value) == "administrator bootstrap could not be completed"
    assert str(exc_info.value.__cause__) == "database-password-leak"
    assert "rollback-password-leak" not in str(exc_info.value)


def test_module_command_uses_canonical_session_store_for_promotion(
    monkeypatch,
    auth_db,
    auth_redis,
    auth_settings,
    session_store,
):
    user = User(
        id="canonical00000000000000000000001",
        email="admin@example.com",
        password_hash=hash_password("old password"),
        role="user",
        status="active",
    )
    auth_db.add(user)
    auth_db.commit()
    old_session_id, _ = session_store.create(user.id)
    _prompt_credentials(monkeypatch, password=PASSWORD, confirmation=PASSWORD)
    monkeypatch.setattr(
        "server.app.db.session.SessionLocal",
        lambda: nullcontext(auth_db),
    )
    monkeypatch.setattr(
        "server.app.core.config.get_settings",
        lambda: auth_settings,
    )
    monkeypatch.setattr("server.app.redis.get_redis", lambda: auth_redis)

    code = run_manage(["create-admin"])

    assert code == 0
    assert session_store.get(old_session_id) is None


def test_set_role_locks_and_audits_before_revoking_target_sessions(
    monkeypatch, auth_db, session_store
):
    from server.app.auth.dependencies import CurrentUser
    from server.app.auth.service import set_role

    actor = User(
        id="actor00000000000000000000000001",
        email="actor@example.com",
        password_hash=hash_password("actor password"),
        role="admin",
        status="active",
    )
    target = User(
        id="target0000000000000000000000001",
        email="target@example.com",
        password_hash=hash_password("target password"),
        role="user",
        status="active",
    )
    auth_db.add_all([actor, target])
    auth_db.commit()
    target_session_id, _ = session_store.create(target.id)
    events = []
    statements = []
    real_execute = auth_db.execute
    real_commit = auth_db.commit
    real_revoke_all = session_store.revoke_all

    def record_execute(statement, *args, **kwargs):
        statements.append(statement)
        return real_execute(statement, *args, **kwargs)

    def record_commit():
        events.append("commit")
        return real_commit()

    def record_revoke_all(user_id):
        events.append(("revoke_all", user_id))
        return real_revoke_all(user_id)

    monkeypatch.setattr(auth_db, "execute", record_execute)
    monkeypatch.setattr(auth_db, "commit", record_commit)
    monkeypatch.setattr(session_store, "revoke_all", record_revoke_all)

    changed = set_role(
        db=auth_db,
        session_store=session_store,
        current_user=CurrentUser(id=actor.id, email=actor.email, role="admin"),
        target_user_id=target.id,
        role="admin",
    )

    assert len(statements) == 1
    assert statements[0]._for_update_arg is not None
    auth_db.expire_all()
    audit = auth_db.scalar(select(AdminAuditLog))
    assert changed.id == target.id
    assert auth_db.get(User, target.id).role == "admin"
    assert events == ["commit", ("revoke_all", target.id)]
    assert session_store.get(target_session_id) is None
    assert audit.id
    assert audit.admin_user_id == actor.id
    assert audit.action == "admin.set_role"
    assert audit.object_type == "user"
    assert audit.object_id == target.id
    assert json.loads(audit.before_json) == {"role": "user"}
    assert json.loads(audit.after_json) == {"role": "admin"}
    assert audit.ip_address is None
    rendered_audit = audit.before_json + audit.after_json
    assert "target password" not in rendered_audit
    assert target.password_hash not in rendered_audit


def _insert_role_change_users(auth_db):
    actor = User(
        id="a" * 32,
        email="actor@example.com",
        password_hash=hash_password("actor password"),
        role="admin",
        status="active",
    )
    target = User(
        id="t" * 32,
        email="target@example.com",
        password_hash=hash_password("target password"),
        role="user",
        status="active",
    )
    auth_db.add_all([actor, target])
    auth_db.commit()
    return actor, target


@pytest.mark.parametrize("actor_role", ["user", "ADMIN"])
def test_set_role_rejects_any_actor_without_exact_admin_role(
    auth_db, session_store, actor_role
):
    from server.app.auth.dependencies import CurrentUser
    from server.app.auth.service import RoleChangeRejected, set_role

    actor, target = _insert_role_change_users(auth_db)

    with pytest.raises(RoleChangeRejected) as exc_info:
        set_role(
            db=auth_db,
            session_store=session_store,
            current_user=CurrentUser(
                id=actor.id,
                email=actor.email,
                role=actor_role,
            ),
            target_user_id=target.id,
            role="admin",
        )

    auth_db.expire_all()
    assert str(exc_info.value) == "role change is not permitted"
    assert auth_db.get(User, target.id).role == "user"
    assert auth_db.scalar(select(func.count()).select_from(AdminAuditLog)) == 0


def test_set_role_rejects_invalid_role_without_mutation_or_audit(
    auth_db, session_store
):
    from server.app.auth.dependencies import CurrentUser
    from server.app.auth.service import RoleChangeRejected, set_role

    actor, target = _insert_role_change_users(auth_db)
    invalid_role = "password=superadmin"

    with pytest.raises(RoleChangeRejected) as exc_info:
        set_role(
            db=auth_db,
            session_store=session_store,
            current_user=CurrentUser(id=actor.id, email=actor.email, role="admin"),
            target_user_id=target.id,
            role=invalid_role,
        )

    auth_db.expire_all()
    assert str(exc_info.value) == "role change is not permitted"
    assert invalid_role not in str(exc_info.value)
    assert auth_db.get(User, target.id).role == "user"
    assert auth_db.scalar(select(func.count()).select_from(AdminAuditLog)) == 0


@pytest.mark.parametrize("target_user_id", ["", "missing-password-target"])
def test_set_role_rejects_invalid_target_without_mutation_or_audit(
    auth_db, session_store, target_user_id
):
    from server.app.auth.dependencies import CurrentUser
    from server.app.auth.service import RoleChangeRejected, set_role

    actor, target = _insert_role_change_users(auth_db)

    with pytest.raises(RoleChangeRejected) as exc_info:
        set_role(
            db=auth_db,
            session_store=session_store,
            current_user=CurrentUser(id=actor.id, email=actor.email, role="admin"),
            target_user_id=target_user_id,
            role="admin",
        )

    auth_db.expire_all()
    assert str(exc_info.value) == "role change is not permitted"
    if target_user_id:
        assert target_user_id not in str(exc_info.value)
    assert auth_db.get(User, target.id).role == "user"
    assert auth_db.scalar(select(func.count()).select_from(AdminAuditLog)) == 0


def test_set_role_noop_does_not_audit_but_revokes_target_sessions(
    auth_db, session_store
):
    from server.app.auth.dependencies import CurrentUser
    from server.app.auth.service import set_role

    actor, target = _insert_role_change_users(auth_db)
    target_session_id, _ = session_store.create(target.id)

    unchanged = set_role(
        db=auth_db,
        session_store=session_store,
        current_user=CurrentUser(id=actor.id, email=actor.email, role="admin"),
        target_user_id=target.id,
        role="user",
    )

    assert unchanged.id == target.id
    assert auth_db.scalar(select(func.count()).select_from(AdminAuditLog)) == 0
    assert session_store.get(target_session_id) is None


def test_set_role_commit_failure_rolls_back_role_and_audit(
    monkeypatch, auth_db, session_store
):
    from server.app.auth.dependencies import CurrentUser
    from server.app.auth.service import RoleChangeFailed, set_role

    actor, target = _insert_role_change_users(auth_db)
    target_session_id, _ = session_store.create(target.id)

    def fail_commit():
        raise RuntimeError("database-password-leak")

    monkeypatch.setattr(auth_db, "commit", fail_commit)

    with pytest.raises(RoleChangeFailed) as exc_info:
        set_role(
            db=auth_db,
            session_store=session_store,
            current_user=CurrentUser(id=actor.id, email=actor.email, role="admin"),
            target_user_id=target.id,
            role="admin",
        )

    auth_db.expire_all()
    assert str(exc_info.value) == "role change could not be completed"
    assert "database-password-leak" not in str(exc_info.value)
    assert auth_db.get(User, target.id).role == "user"
    assert auth_db.scalar(select(func.count()).select_from(AdminAuditLog)) == 0
    assert session_store.get(target_session_id) is not None


def test_set_role_revocation_failure_keeps_committed_role_and_audit(
    monkeypatch, auth_db, session_store
):
    from server.app.auth.dependencies import CurrentUser
    from server.app.auth.service import RoleChangeFailed, set_role

    actor, target = _insert_role_change_users(auth_db)
    target_session_id, _ = session_store.create(target.id)

    def fail_revocation(user_id):
        raise RuntimeError("redis-password-leak")

    monkeypatch.setattr(session_store, "revoke_all", fail_revocation)

    with pytest.raises(RoleChangeFailed) as exc_info:
        set_role(
            db=auth_db,
            session_store=session_store,
            current_user=CurrentUser(id=actor.id, email=actor.email, role="admin"),
            target_user_id=target.id,
            role="admin",
        )

    auth_db.expire_all()
    assert str(exc_info.value) == "role change could not be completed"
    assert "redis-password-leak" not in str(exc_info.value)
    assert auth_db.get(User, target.id).role == "admin"
    assert auth_db.scalar(select(func.count()).select_from(AdminAuditLog)) == 1
    assert session_store.get(target_session_id) is not None

    monkeypatch.undo()
    unchanged = set_role(
        db=auth_db,
        session_store=session_store,
        current_user=CurrentUser(id=actor.id, email=actor.email, role="admin"),
        target_user_id=target.id,
        role="admin",
    )

    assert unchanged.id == target.id
    assert auth_db.scalar(select(func.count()).select_from(AdminAuditLog)) == 1
    assert session_store.get(target_session_id) is None


def test_set_role_database_failure_is_generic_and_does_not_revoke(
    monkeypatch, auth_db, session_store
):
    from server.app.auth.dependencies import CurrentUser
    from server.app.auth.service import RoleChangeFailed, set_role

    actor, target = _insert_role_change_users(auth_db)
    target_session_id, _ = session_store.create(target.id)

    def fail_query(statement):
        raise RuntimeError("database-password-leak")

    monkeypatch.setattr(auth_db, "execute", fail_query)

    with pytest.raises(RoleChangeFailed) as exc_info:
        set_role(
            db=auth_db,
            session_store=session_store,
            current_user=CurrentUser(id=actor.id, email=actor.email, role="admin"),
            target_user_id=target.id,
            role="admin",
        )

    assert str(exc_info.value) == "role change could not be completed"
    assert "database-password-leak" not in str(exc_info.value)
    assert session_store.get(target_session_id) is not None


def test_set_role_rollback_failure_preserves_generic_service_error(
    monkeypatch, auth_db, session_store
):
    from server.app.auth.dependencies import CurrentUser
    from server.app.auth.service import RoleChangeFailed, set_role

    actor, target = _insert_role_change_users(auth_db)

    def fail_query(statement):
        raise RuntimeError("database-password-leak")

    def fail_rollback():
        raise RuntimeError("rollback-password-leak")

    monkeypatch.setattr(auth_db, "execute", fail_query)
    monkeypatch.setattr(auth_db, "rollback", fail_rollback)

    with pytest.raises(RoleChangeFailed) as exc_info:
        set_role(
            db=auth_db,
            session_store=session_store,
            current_user=CurrentUser(id=actor.id, email=actor.email, role="admin"),
            target_user_id=target.id,
            role="admin",
        )

    assert str(exc_info.value) == "role change could not be completed"
    assert str(exc_info.value.__cause__) == "database-password-leak"
    assert "rollback-password-leak" not in str(exc_info.value)


def test_module_cli_rejects_password_argv_with_nonzero_secret_safe_output():
    secret = "subprocess-password-secret"

    result = subprocess.run(
        [sys.executable, "-m", "server.manage", "create-admin", secret],
        cwd=ROOT_DIR,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 2
    assert "invalid arguments" in result.stderr
    assert secret not in result.stdout + result.stderr


def test_audit_ids_are_unique_across_bootstrap_and_role_changes(
    auth_db, session_store
):
    from server.app.auth.dependencies import CurrentUser
    from server.app.auth.service import set_role

    first_admin = bootstrap_admin(
        db=auth_db,
        session_store=session_store,
        email="first-admin@example.com",
        password=PASSWORD,
    )
    second_admin = bootstrap_admin(
        db=auth_db,
        session_store=session_store,
        email="second-admin@example.com",
        password=PASSWORD,
    )
    target = User(
        id="u" * 32,
        email="role-target@example.com",
        password_hash=hash_password(PASSWORD),
        role="user",
        status="active",
    )
    auth_db.add(target)
    auth_db.commit()
    set_role(
        db=auth_db,
        session_store=session_store,
        current_user=CurrentUser(
            id=first_admin.id,
            email=first_admin.email,
            role="admin",
        ),
        target_user_id=target.id,
        role="admin",
    )
    set_role(
        db=auth_db,
        session_store=session_store,
        current_user=CurrentUser(
            id=second_admin.id,
            email=second_admin.email,
            role="admin",
        ),
        target_user_id=target.id,
        role="user",
    )

    audit_ids = auth_db.scalars(select(AdminAuditLog.id)).all()
    assert len(audit_ids) == 4
    assert len(set(audit_ids)) == len(audit_ids)
    assert all(len(audit_id) == 32 for audit_id in audit_ids)


def test_public_registration_cannot_create_admin(auth_client, auth_db, mailer):
    bootstrap = auth_client.get("/api/auth/csrf")
    auth_client.headers.update(
        {
            "Origin": "https://studio.example.com",
            "X-CSRF-Token": bootstrap.json()["csrf_token"],
        }
    )
    verification = auth_client.post(
        "/api/auth/email-verifications",
        json={"email": "public-user@example.com"},
    )
    assert verification.status_code == 202

    response = auth_client.post(
        "/api/auth/register",
        json={
            "email": "public-user@example.com",
            "password": PASSWORD,
            "code": mailer.messages[-1][2],
            "role": "admin",
        },
    )

    assert response.status_code == 201
    assert response.json()["user"]["role"] == "user"
    user = auth_db.scalar(
        select(User).where(User.email == "public-user@example.com")
    )
    assert user.role == "user"
