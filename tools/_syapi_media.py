"""Shared helpers for SYAPI media provider tools."""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path
from typing import Any, Iterable


DEFAULT_BASE_URL = "https://api.0000238.xyz"
DEFAULT_UPLOAD_URL = "https://imageproxy.zhongzhuan.chat/api/upload"


def api_key() -> str | None:
    return os.environ.get("SYAPI_API_KEY")


def base_url() -> str:
    return os.environ.get("SYAPI_BASE_URL", DEFAULT_BASE_URL).rstrip("/")


def auth_headers(*, json_content: bool = False) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {api_key()}"}
    if json_content:
        headers["Content-Type"] = "application/json"
    return headers


def response_json(response: Any, operation: str) -> dict[str, Any]:
    try:
        payload = response.json()
    except ValueError as exc:
        raise RuntimeError(
            f"{operation} returned non-JSON data (HTTP {response.status_code})"
        ) from exc
    if not response.ok:
        message = find_value(payload, ("message", "error_msg", "error"))
        detail = f": {str(message)[:400]}" if message else ""
        raise RuntimeError(f"{operation} failed (HTTP {response.status_code}){detail}")
    base_response = payload.get("base_resp")
    if isinstance(base_response, dict):
        status_code = base_response.get("status_code")
        if status_code not in (None, 0, "0"):
            message = base_response.get("status_msg") or "provider rejected the request"
            raise RuntimeError(f"{operation} failed ({status_code}): {message}")
    return payload


def find_value(value: Any, keys: Iterable[str]) -> Any:
    wanted = set(keys)
    if isinstance(value, dict):
        for key in wanted:
            candidate = value.get(key)
            if candidate not in (None, "", [], {}):
                return candidate
        for candidate in value.values():
            found = find_value(candidate, wanted)
            if found not in (None, "", [], {}):
                return found
    elif isinstance(value, list):
        for candidate in value:
            found = find_value(candidate, wanted)
            if found not in (None, "", [], {}):
                return found
    return None


def collect_values(value: Any, key: str) -> list[Any]:
    found: list[Any] = []
    if isinstance(value, dict):
        if key in value and value[key] not in (None, ""):
            found.append(value[key])
        for candidate in value.values():
            found.extend(collect_values(candidate, key))
    elif isinstance(value, list):
        for candidate in value:
            found.extend(collect_values(candidate, key))
    return found


def find_media_url(value: Any, extensions: tuple[str, ...]) -> str | None:
    preferred_keys = ("video_url", "audio_url", "output_url", "result_url", "url")
    preferred = find_value(value, preferred_keys)
    if isinstance(preferred, str) and preferred.lower().split("?", 1)[0].endswith(extensions):
        return preferred
    if isinstance(value, dict):
        for candidate in value.values():
            found = find_media_url(candidate, extensions)
            if found:
                return found
    elif isinstance(value, list):
        for candidate in value:
            found = find_media_url(candidate, extensions)
            if found:
                return found
    elif isinstance(value, str) and value.lower().split("?", 1)[0].endswith(extensions):
        return value
    return None


def task_status(payload: dict[str, Any]) -> str:
    value = find_value(payload, ("task_status", "status", "state"))
    return str(value or "").strip().lower()


def task_id(payload: dict[str, Any]) -> str | None:
    value = find_value(payload, ("task_id", "id"))
    return str(value) if value not in (None, "") else None


def upload_file(path: Path, *, upload_url: str = DEFAULT_UPLOAD_URL) -> str:
    import requests

    if not path.is_file():
        raise FileNotFoundError(f"Upload input not found: {path}")
    mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    with path.open("rb") as handle:
        response = requests.post(
            upload_url,
            headers=auth_headers(),
            files={"file": (path.name, handle, mime_type)},
            timeout=(15, 180),
        )
    payload = response_json(response, "SYAPI media upload")
    url = find_value(payload, ("url", "file_url", "download_url"))
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        raise RuntimeError("SYAPI media upload completed without a public URL")
    return url


def download_file(url: str, output_path: Path) -> None:
    import requests

    response = requests.get(url, timeout=(15, 300))
    response.raise_for_status()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(response.content)
