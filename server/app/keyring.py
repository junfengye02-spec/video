from __future__ import annotations


def mask_key(value: str) -> str:
    if len(value) < 12:
        return "*" * len(value)
    return f"{value[:4]}...{value[-4:]}"


def key_environment(value: str, base_url: str = "https://api.0000238.xyz") -> dict[str, str]:
    return {
        "SYAPI_API_KEY": value,
        "SYAPI_BASE_URL": base_url.rstrip("/"),
    }
