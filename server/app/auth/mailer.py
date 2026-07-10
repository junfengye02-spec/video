import smtplib
import ssl
from email.message import EmailMessage
from typing import Protocol

from server.app.auth.security import normalize_email
from server.app.core.config import AppSettings


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
        message["Subject"] = f"OpenMontage {purpose} code"
        message["From"] = str(self._settings.smtp_from_address)
        message["To"] = normalize_email(email)
        message.set_content(
            f"Your OpenMontage {purpose} code is {code}.\n\n"
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
        client.send_message(message)
