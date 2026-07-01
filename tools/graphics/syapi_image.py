"""SYAPI image generation gateway.

Supports the documented synchronous ``image2`` endpoint and the asynchronous
``gpt-image-2`` family exposed through the shared videos task API.
"""

from __future__ import annotations

import base64
import mimetypes
import os
import time
from pathlib import Path
from typing import Any

from tools.base_tool import (
    BaseTool,
    Determinism,
    ExecutionMode,
    ResourceProfile,
    RetryPolicy,
    ToolResult,
    ToolRuntime,
    ToolStability,
    ToolStatus,
    ToolTier,
)


class SyapiImage(BaseTool):
    name = "syapi_image"
    version = "0.1.0"
    tier = ToolTier.GENERATE
    capability = "image_generation"
    provider = "syapi"
    stability = ToolStability.EXPERIMENTAL
    execution_mode = ExecutionMode.SYNC
    determinism = Determinism.STOCHASTIC
    runtime = ToolRuntime.API

    dependencies = ["env:SYAPI_API_KEY"]
    install_instructions = (
        "Set SYAPI_API_KEY to your SYAPI-compatible gateway API key.\n"
        "Optional: set SYAPI_BASE_URL, default https://api.0000238.xyz"
    )
    agent_skills = ["flux-best-practices"]

    capabilities = ["text_to_image", "image_to_image", "generate_image", "edit_image"]
    supports = {
        "text_to_image": True,
        "image_edit": True,
        "reference_images": True,
        "async_generation": True,
        "high_resolution": True,
    }
    best_for = [
        "gateway access to image2 and gpt-image-2",
        "character keyframes for short-form AI video",
        "reference-image driven still generation",
    ]
    not_good_for = ["offline generation", "transparent-background cutouts"]

    input_schema = {
        "type": "object",
        "required": ["prompt"],
        "properties": {
            "prompt": {"type": "string"},
            "model": {
                "type": "string",
                "enum": ["image2", "gpt-image-2", "gpt-image-2-2K", "gpt-image-2-4K"],
                "default": "image2",
            },
            "size": {"type": "string", "default": "1024x1024"},
            "aspect_ratio": {
                "type": "string",
                "enum": ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9"],
                "default": "9:16",
            },
            "generation_mode": {
                "type": "string",
                "enum": ["generate", "edit"],
                "default": "generate",
            },
            "image_url": {"type": "string"},
            "image_path": {"type": "string"},
            "image_urls": {"type": "array", "items": {"type": "string"}},
            "image_paths": {"type": "array", "items": {"type": "string"}},
            "poll_interval_seconds": {"type": "number", "default": 5},
            "timeout_seconds": {"type": "integer", "default": 900},
            "output_path": {"type": "string"},
        },
    }

    resource_profile = ResourceProfile(
        cpu_cores=1, ram_mb=512, vram_mb=0, disk_mb=100, network_required=True
    )
    retry_policy = RetryPolicy(max_retries=1, retryable_errors=["timeout", "rate_limit"])
    idempotency_key_fields = ["prompt", "model", "size", "aspect_ratio"]
    side_effects = ["writes image file to output_path", "calls SYAPI API"]
    user_visible_verification = ["Inspect generated image for character consistency and framing"]

    def _api_key(self) -> str | None:
        return os.environ.get("SYAPI_API_KEY")

    def _base_url(self) -> str:
        return os.environ.get("SYAPI_BASE_URL", "https://api.0000238.xyz").rstrip("/")

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE if self._api_key() else ToolStatus.UNAVAILABLE

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        model = inputs.get("model", "image2")
        if model == "gpt-image-2-4K":
            return 0.20
        if model == "gpt-image-2-2K":
            return 0.10
        if model == "gpt-image-2":
            return 0.05
        return 0.04

    @staticmethod
    def _file_to_data_uri(path_str: str) -> str:
        path = Path(path_str)
        if not path.exists():
            raise FileNotFoundError(f"Input image not found: {path}")
        mime_type, _ = mimetypes.guess_type(path.name)
        if not mime_type:
            mime_type = "image/png"
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
        return f"data:{mime_type};base64,{encoded}"

    def _collect_images(self, inputs: dict[str, Any]) -> list[str]:
        images: list[str] = []
        if inputs.get("image_url"):
            images.append(inputs["image_url"])
        images.extend(inputs.get("image_urls") or [])
        if inputs.get("image_path"):
            images.append(self._file_to_data_uri(inputs["image_path"]))
        images.extend(self._file_to_data_uri(path) for path in (inputs.get("image_paths") or []))
        return images

    @staticmethod
    def _response_error(data: dict[str, Any]) -> str:
        error = data.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or error.get("code") or error)
        if error:
            return str(error)
        return str(data)

    @staticmethod
    def _extract_url(data: dict[str, Any]) -> str | None:
        for key in ("url", "output_url", "image_url"):
            value = data.get(key)
            if isinstance(value, str) and value:
                return value
        output = data.get("output")
        if isinstance(output, dict):
            for key in ("url", "image_url"):
                value = output.get(key)
                if isinstance(value, str) and value:
                    return value
        if isinstance(output, list):
            for item in output:
                if isinstance(item, str):
                    return item
                if isinstance(item, dict):
                    value = item.get("url") or item.get("image_url")
                    if value:
                        return value
        return None

    def _download_url(self, url: str, output_path: Path) -> None:
        import requests

        response = requests.get(url, timeout=180)
        response.raise_for_status()
        output_path.write_bytes(response.content)

    def _poll_task(self, task_id: str, inputs: dict[str, Any], output_path: Path) -> ToolResult:
        import requests

        headers = {"Authorization": f"Bearer {self._api_key()}"}
        deadline = time.time() + int(inputs.get("timeout_seconds", 900))
        interval = float(inputs.get("poll_interval_seconds", 5))
        last_data: dict[str, Any] = {}

        while time.time() < deadline:
            response = requests.get(f"{self._base_url()}/v1/videos/{task_id}", headers=headers, timeout=30)
            response.raise_for_status()
            data = response.json()
            last_data = data
            status = str(data.get("status", "")).lower()
            if status == "completed":
                image_url = self._extract_url(data)
                if not image_url:
                    return ToolResult(success=False, error=f"SYAPI image task completed without URL: {data}")
                self._download_url(image_url, output_path)
                return ToolResult(
                    success=True,
                    data={
                        "provider": "syapi",
                        "model": inputs.get("model", "gpt-image-2"),
                        "task_id": task_id,
                        "url": image_url,
                        "output": str(output_path),
                    },
                    artifacts=[str(output_path)],
                    cost_usd=self.estimate_cost(inputs),
                    model=inputs.get("model", "gpt-image-2"),
                )
            if status == "failed":
                return ToolResult(success=False, error=f"SYAPI image task failed: {self._response_error(data)}")
            time.sleep(interval)

        return ToolResult(success=False, error=f"SYAPI image task timed out: {last_data}")

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        api_key = self._api_key()
        if not api_key:
            return ToolResult(success=False, error="SYAPI_API_KEY not set. " + self.install_instructions)

        import requests

        start = time.time()
        model = inputs.get("model", "image2")
        output_ext = "png"
        output_path = Path(inputs.get("output_path", f"syapi_{model}.png"))
        output_path.parent.mkdir(parents=True, exist_ok=True)
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

        try:
            if model.startswith("gpt-image-2"):
                payload: dict[str, Any] = {"model": model, "prompt": inputs["prompt"]}
                if inputs.get("aspect_ratio"):
                    payload["aspect_ratio"] = inputs["aspect_ratio"]
                images = self._collect_images(inputs)
                if images:
                    payload["images"] = images[:5]
                response = requests.post(
                    f"{self._base_url()}/v1/videos",
                    headers=headers,
                    json=payload,
                    timeout=60,
                )
                response.raise_for_status()
                data = response.json()
                task_id = data.get("id")
                if not task_id:
                    return ToolResult(success=False, error=f"SYAPI image async response missing id: {data}")
                result = self._poll_task(task_id, inputs, output_path)
                result.duration_seconds = round(time.time() - start, 2)
                return result

            endpoint = "edits" if inputs.get("generation_mode") == "edit" or self._collect_images(inputs) else "generations"
            payload = {
                "model": "image2",
                "prompt": inputs["prompt"],
                "size": inputs.get("size", "1024x1024"),
            }
            images = self._collect_images(inputs)
            if images:
                payload["image"] = images[0] if len(images) == 1 else images
            response = requests.post(
                f"{self._base_url()}/v1/images/{endpoint}",
                headers=headers,
                json=payload,
                timeout=180,
            )
            response.raise_for_status()
            data = response.json()
            first = (data.get("data") or [{}])[0]
            b64_json = first.get("b64_json")
            if b64_json:
                output_path.write_bytes(base64.b64decode(b64_json))
            else:
                image_url = first.get("url") or self._extract_url(data)
                if not image_url:
                    return ToolResult(success=False, error=f"SYAPI image response missing b64_json/url: {data}")
                self._download_url(image_url, output_path)
        except Exception as exc:
            return ToolResult(success=False, error=f"SYAPI image generation failed: {exc}")

        return ToolResult(
            success=True,
            data={
                "provider": "syapi",
                "model": model,
                "prompt": inputs["prompt"],
                "output": str(output_path),
                "format": output_ext,
            },
            artifacts=[str(output_path)],
            cost_usd=self.estimate_cost(inputs),
            duration_seconds=round(time.time() - start, 2),
            model=model,
        )
