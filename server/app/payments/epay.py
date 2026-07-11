from __future__ import annotations

import hashlib
import re
import secrets
from collections.abc import Iterable, Mapping
from decimal import Decimal


_SIGNATURE_FIELDS = frozenset({"sign", "sign_type"})
_MONEY_PATTERN = re.compile(r"^(?:0|[1-9][0-9]{0,11})\.[0-9]{2}$")
_CALLBACK_FIELD_LIMITS = {
    "pid": 64,
    "type": 16,
    "out_trade_no": 64,
    "trade_no": 191,
    "name": 255,
    "money": 32,
    "trade_status": 32,
    "param": 255,
    "sign": 64,
    "sign_type": 16,
}
MAX_EPAY_CALLBACK_BYTES = 4_096
_ASCII_HEX_DIGITS = frozenset(b"0123456789abcdefABCDEF")


def canonical_epay_string(fields: Mapping[str, str]) -> str:
    return "&".join(
        f"{key}={value}"
        for key, value in sorted(fields.items())
        if key not in _SIGNATURE_FIELDS and value != ""
    )


def sign_epay(fields: Mapping[str, str], merchant_key: str) -> str:
    payload = (canonical_epay_string(fields) + merchant_key).encode("utf-8")
    return hashlib.md5(payload, usedforsecurity=False).hexdigest()


def verify_epay(fields: Mapping[str, str], merchant_key: str) -> bool:
    provided = fields.get("sign", "").lower()
    expected = sign_epay(fields, merchant_key)
    return secrets.compare_digest(provided, expected)


def parse_epay_money_to_fen(value: str) -> int | None:
    if _MONEY_PATTERN.fullmatch(value) is None:
        return None
    amount = Decimal(value)
    if amount <= 0:
        return None
    return int(amount * 100)


def valid_urlencoded_percent_escapes(raw: bytes) -> bool:
    position = 0
    while True:
        marker = raw.find(b"%", position)
        if marker < 0:
            return True
        if marker + 2 >= len(raw):
            return False
        if (
            raw[marker + 1] not in _ASCII_HEX_DIGITS
            or raw[marker + 2] not in _ASCII_HEX_DIGITS
        ):
            return False
        position = marker + 3


def bounded_epay_fields(
    items: Iterable[tuple[str, str]], *, encoded_size: int
) -> dict[str, str] | None:
    if not 0 <= encoded_size <= MAX_EPAY_CALLBACK_BYTES:
        return None
    fields: dict[str, str] = {}
    for key, value in items:
        limit = _CALLBACK_FIELD_LIMITS.get(key)
        if (
            limit is None
            or key in fields
            or len(value) > limit
            or any(ord(character) < 32 or ord(character) == 127 for character in value)
        ):
            return None
        fields[key] = value
    return fields
