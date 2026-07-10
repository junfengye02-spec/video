from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field


Email = Annotated[EmailStr, Field(max_length=320)]
Password = Annotated[str, Field(min_length=8, max_length=64)]
VerificationCode = Annotated[str, Field(pattern=r"^\d{6}$")]


class AuthSchema(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EmailRequest(AuthSchema):
    email: Email


class RegisterRequest(AuthSchema):
    email: Email
    password: Password
    code: VerificationCode
    role: str | None = None


class LoginRequest(AuthSchema):
    email: Email
    password: Password


class PasswordResetConfirmRequest(AuthSchema):
    email: Email
    code: VerificationCode
    new_password: Password


class UserResponse(AuthSchema):
    id: str
    email: Email
    role: Literal["user", "admin"]


class AuthResponse(AuthSchema):
    user: UserResponse
    csrf_token: str


class MeResponse(AuthSchema):
    user: UserResponse


class CsrfResponse(AuthSchema):
    csrf_token: str


class DetailResponse(AuthSchema):
    detail: str
