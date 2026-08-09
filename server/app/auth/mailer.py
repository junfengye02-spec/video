import smtplib
import ssl
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import Protocol

import dns.exception
import dns.resolver

from server.app.auth.security import normalize_email
from server.app.core.config import AppSettings


MAIL_BRAND_NAME = "mise studio"


class RecipientDomainUnavailable(ValueError):
    """Raised when an address domain is known not to accept email."""


def ensure_recipient_domain(email: str) -> None:
    """Reject domains that have neither MX nor address records.

    DNS outages are treated as unknown rather than invalid so a transient
    resolver failure does not block otherwise valid registrations.
    """
    normalized = normalize_email(email)
    domain = normalized.rsplit("@", 1)[-1].rstrip(".")
    resolver = dns.resolver.Resolver()
    resolver.timeout = 2.0
    resolver.lifetime = 3.0

    try:
        mx_records = resolver.resolve(domain, "MX")
        if any(str(record.exchange).rstrip(".") for record in mx_records):
            return
        raise RecipientDomainUnavailable("recipient domain does not accept mail")
    except dns.resolver.NXDOMAIN as exc:
        raise RecipientDomainUnavailable("recipient domain does not exist") from exc
    except dns.resolver.NoAnswer:
        pass
    except (dns.resolver.LifetimeTimeout, dns.resolver.NoNameservers, dns.exception.DNSException):
        return

    for record_type in ("A", "AAAA"):
        try:
            resolver.resolve(domain, record_type)
            return
        except dns.resolver.NXDOMAIN as exc:
            raise RecipientDomainUnavailable("recipient domain does not exist") from exc
        except dns.resolver.NoAnswer:
            continue
        except (dns.resolver.LifetimeTimeout, dns.resolver.NoNameservers, dns.exception.DNSException):
            return

    raise RecipientDomainUnavailable("recipient domain has no mail or address records")


class Mailer(Protocol):
    def send_verification(self, email: str, code: str) -> None: ...

    def send_password_reset(self, email: str, code: str) -> None: ...


class MemoryMailer:
    def __init__(self):
        self.messages: list[tuple[str, str, str]] = []

    def send_verification(self, email: str, code: str) -> None:
        self.messages.append(("register", email, code))

    def send_password_reset(self, email: str, code: str) -> None:
        self.messages.append(("reset", email, code))


class SmtpMailer:
    def __init__(self, settings: AppSettings):
        if not settings.smtp_host:
            raise ValueError("smtp_host is required")
        if not settings.smtp_from_address:
            raise ValueError("smtp_from_address is required")
        if bool(settings.smtp_username) != bool(settings.smtp_password):
            raise ValueError("smtp_username and smtp_password must be configured together")
        self._settings = settings

    def send_verification(self, email: str, code: str) -> None:
        self._send(email, code, purpose="registration")

    def send_password_reset(self, email: str, code: str) -> None:
        self._send(email, code, purpose="password reset")

    def _send(self, email: str, code: str, *, purpose: str) -> None:
        message = EmailMessage()
        message["Subject"] = f"{MAIL_BRAND_NAME} {purpose} code"
        message["Date"] = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S %z")
        message["Message-ID"] = make_msgid()
        message["From"] = formataddr(
            (MAIL_BRAND_NAME, str(self._settings.smtp_from_address))
        )
        message["To"] = normalize_email(email)
        message["Reply-To"] = str(self._settings.smtp_from_address)
        message["Auto-Submitted"] = "auto-generated"
        message["X-Auto-Response-Suppress"] = "All"
        message.set_content(
            f"Your {MAIL_BRAND_NAME} {purpose} code is {code}.\n\n"
            "This code expires in 10 minutes.\n"
            "If you did not request this, ignore this email."
        )

        context = ssl.create_default_context()
        if self._settings.smtp_tls_mode == "ssl":
            with smtplib.SMTP_SSL(
                self._settings.smtp_host,
                self._settings.smtp_port,
                timeout=10,
                context=context,
            ) as client:
                self._authenticate_and_send(client, message)
            return

        with smtplib.SMTP(
            self._settings.smtp_host,
            self._settings.smtp_port,
            timeout=10,
        ) as client:
            client.ehlo()
            client.starttls(context=context)
            client.ehlo()
            self._authenticate_and_send(client, message)

    def _authenticate_and_send(self, client, message: EmailMessage) -> None:
        if self._settings.smtp_username and self._settings.smtp_password:
            client.login(
                self._settings.smtp_username,
                self._settings.smtp_password.get_secret_value(),
            )
        refused = client.send_message(message)
        if refused:
            raise smtplib.SMTPRecipientsRefused(refused)
