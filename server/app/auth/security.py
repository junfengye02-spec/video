import secrets

from argon2 import PasswordHasher, Type
from argon2.exceptions import InvalidHashError, VerificationError


_hasher = PasswordHasher(
    time_cost=3,
    memory_cost=65536,
    parallelism=2,
    hash_len=32,
    salt_len=16,
    type=Type.ID,
)


def normalize_email(value: str) -> str:
    return value.strip().lower()


def hash_password(password: str) -> str:
    if not 8 <= len(password) <= 64:
        raise ValueError("password must be 8-64 characters")
    return _hasher.hash(password)


def verify_password(encoded: str, password: str) -> bool:
    try:
        return _hasher.verify(encoded, password)
    except (InvalidHashError, VerificationError):
        return False


def random_token(bytes_count: int = 32) -> str:
    return secrets.token_urlsafe(bytes_count)
