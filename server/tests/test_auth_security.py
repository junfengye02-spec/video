import re
import smtplib
from pathlib import Path

import pytest
from pydantic import ValidationError

from server.app.auth.mailer import (
    MemoryMailer,
    RecipientDomainUnavailable,
    SmtpMailer,
    ensure_recipient_domain,
)
from server.app.auth.security import (
    hash_password,
    normalize_email,
    random_token,
    verify_password,
)
from server.app.core.config import AppSettings


ROOT_DIR = Path(__file__).resolve().parents[2]


class RecordingSmtp:
    instances = []

    def __init__(self, host, port, **kwargs):
        self.host = host
        self.port = port
        self.kwargs = kwargs
        self.ehlo_calls = 0
        self.starttls_context = None
        self.login_args = None
        self.messages = []
        self.send_message_result = None
        type(self).instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def ehlo(self):
        self.ehlo_calls += 1

    def starttls(self, *, context):
        self.starttls_context = context

    def login(self, username, password):
        self.login_args = (username, password)

    def send_message(self, message):
        self.messages.append(message)
        return self.send_message_result


def test_password_uses_argon2id_and_email_is_normalized():
    encoded = hash_password("correct horse")

    assert encoded.startswith("$argon2id$")
    assert verify_password(encoded, "correct horse") is True
    assert verify_password(encoded, "wrong horse") is False
    assert normalize_email("  Person@Example.COM ") == "person@example.com"


@pytest.mark.parametrize("length", [8, 64])
def test_password_accepts_inclusive_length_boundaries(length):
    password = "x" * length

    assert verify_password(hash_password(password), password) is True


@pytest.mark.parametrize("length", [7, 65])
def test_password_rejects_lengths_outside_bounds(length):
    with pytest.raises(ValueError, match="password must be 8-64 characters"):
        hash_password("x" * length)


def test_malformed_argon2_hash_is_not_a_match():
    assert verify_password("not-an-argon2-hash", "correct horse") is False


def test_random_token_is_url_safe_and_not_reused():
    first = random_token()
    second = random_token()

    assert first != second
    assert len(first) >= 43
    assert re.fullmatch(r"[A-Za-z0-9_-]+", first)


def test_smtp_settings_are_explicit_and_password_repr_is_redacted():
    settings = AppSettings(
        _env_file=None,
        auth_hmac_secret="x" * 32,
        smtp_host="smtp.example.com",
        smtp_port=465,
        smtp_from_address="no-reply@example.com",
        smtp_username="mailer",
        smtp_password="unrelated-smtp-secret",
        smtp_tls_mode="ssl",
    )

    assert settings.smtp_host == "smtp.example.com"
    assert settings.smtp_port == 465
    assert settings.smtp_from_address == "no-reply@example.com"
    assert settings.smtp_tls_mode == "ssl"
    assert "unrelated-smtp-secret" not in repr(settings)


def test_smtp_settings_reject_plaintext_mode():
    with pytest.raises(ValidationError):
        AppSettings(
            _env_file=None,
            auth_hmac_secret="x" * 32,
            smtp_tls_mode="plain",
        )


def test_recipient_domain_rejects_explicit_null_mx(monkeypatch):
    class NullMxRecord:
        exchange = "."

    class NullMxResolver:
        timeout = 0.0
        lifetime = 0.0

        def resolve(self, domain, record_type):
            assert domain == "example.com"
            assert record_type == "MX"
            return [NullMxRecord()]

    monkeypatch.setattr(
        "server.app.auth.mailer.dns.resolver.Resolver",
        NullMxResolver,
    )

    with pytest.raises(RecipientDomainUnavailable, match="does not accept mail"):
        ensure_recipient_domain("person@example.com")


def test_smtp_ssl_sends_verification_with_optional_login(monkeypatch, caplog):
    RecordingSmtp.instances.clear()
    monkeypatch.setattr("server.app.auth.mailer.smtplib.SMTP_SSL", RecordingSmtp)
    settings = AppSettings(
        _env_file=None,
        auth_hmac_secret="unrelated-auth-secret-xxxxxxxxxx",
        smtp_host="smtp.example.com",
        smtp_port=465,
        smtp_from_address="no-reply@example.com",
        smtp_username="mailer",
        smtp_password="unrelated-smtp-secret",
        smtp_tls_mode="ssl",
    )

    SmtpMailer(settings).send_verification(" Person@Example.COM ", "123456")

    smtp = RecordingSmtp.instances[0]
    message = smtp.messages[0]
    rendered = message.as_string()
    assert (smtp.host, smtp.port) == ("smtp.example.com", 465)
    assert smtp.login_args == ("mailer", "unrelated-smtp-secret")
    assert smtp.starttls_context is None
    assert message["From"] == "mise studio <no-reply@example.com>"
    assert message["To"] == "person@example.com"
    assert message["Subject"] == "mise studio registration code"
    assert message["Date"]
    assert message["Message-ID"]
    assert message["Reply-To"] == "no-reply@example.com"
    assert message["Auto-Submitted"] == "auto-generated"
    assert "mise studio" in message.get_content()
    assert "registration" in message.get_content().lower()
    assert "123456" in message.get_content()
    assert "10 minutes" in message.get_content()
    assert "ignore" in message.get_content().lower()
    assert "unrelated-smtp-secret" not in rendered
    assert "unrelated-auth-secret" not in rendered
    assert "123456" not in caplog.text


def test_smtp_starttls_sends_password_reset_without_login(monkeypatch):
    RecordingSmtp.instances.clear()
    monkeypatch.setattr("server.app.auth.mailer.smtplib.SMTP", RecordingSmtp)
    settings = AppSettings(
        _env_file=None,
        auth_hmac_secret="x" * 32,
        smtp_host="smtp.example.com",
        smtp_port=587,
        smtp_from_address="no-reply@example.com",
        smtp_username=None,
        smtp_password=None,
        smtp_tls_mode="starttls",
    )

    SmtpMailer(settings).send_password_reset("person@example.com", "654321")

    smtp = RecordingSmtp.instances[0]
    message = smtp.messages[0]
    assert smtp.ehlo_calls == 2
    assert smtp.starttls_context is not None
    assert smtp.login_args is None
    assert "password reset" in message.get_content().lower()
    assert "654321" in message.get_content()


def test_smtp_rejects_partial_recipient_refusal(monkeypatch):
    RecordingSmtp.instances.clear()
    monkeypatch.setattr("server.app.auth.mailer.smtplib.SMTP_SSL", RecordingSmtp)
    settings = AppSettings(
        _env_file=None,
        auth_hmac_secret="x" * 32,
        smtp_host="smtp.example.com",
        smtp_port=465,
        smtp_from_address="no-reply@example.com",
        smtp_username="mailer",
        smtp_password="smtp-password",
        smtp_tls_mode="ssl",
    )
    class RefusingSmtp(RecordingSmtp):
        def __init__(self, host, port, **kwargs):
            super().__init__(host, port, **kwargs)
            self.send_message_result = {"person@example.com": (550, "mailbox unavailable")}

    monkeypatch.setattr("server.app.auth.mailer.smtplib.SMTP_SSL", RefusingSmtp)

    with pytest.raises(smtplib.SMTPRecipientsRefused):
        SmtpMailer(settings).send_verification("person@example.com", "123456")


def test_memory_mailer_records_purpose_email_and_code():
    mailer = MemoryMailer()

    mailer.send_verification("person@example.com", "123456")
    mailer.send_password_reset("person@example.com", "654321")

    assert mailer.messages == [
        ("register", "person@example.com", "123456"),
        ("reset", "person@example.com", "654321"),
    ]


def test_env_example_lists_smtp_contract_without_a_password():
    env_text = (ROOT_DIR / ".env.example").read_text(encoding="utf-8")

    assert "SMTP_HOST=" in env_text
    assert "SMTP_PORT=587" in env_text
    assert "SMTP_FROM_ADDRESS=" in env_text
    assert "SMTP_USERNAME=" in env_text
    assert "SMTP_PASSWORD=" in env_text
    assert "SMTP_TLS_MODE=starttls" in env_text
    assert "SMTP_PASSWORD=unrelated-smtp-secret" not in env_text
