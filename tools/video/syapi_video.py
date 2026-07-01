"""SYAPI video generation gateway for Omni and Veo model slugs."""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
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
from tools.video._shared import probe_output


class SyapiVideo(BaseTool):
    name = "syapi_video"
    version = "0.1.0"
    tier = ToolTier.GENERATE
    capability = "video_generation"
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
    agent_skills = ["ai-video-gen"]

    capabilities = ["text_to_video", "image_to_video", "reference_to_video", "first_last_frame_to_video"]
    supports = {
        "text_to_video": True,
        "image_to_video": True,
        "reference_to_video": True,
        "first_last_frame_to_video": True,
        "vertical_video": True,
    }
    best_for = [
        "low-friction gateway access to Veo and Omni",
        "short vertical AI drama samples",
        "first/last-frame guided motion when paired with generated keyframes",
    ]
    not_good_for = ["offline generation", "guaranteed actor identity across many scenes"]
    fallback_tools = ["veo_video", "kling_video", "minimax_video"]

    input_schema = {
        "type": "object",
        "required": ["prompt"],
        "properties": {
            "prompt": {"type": "string"},
            "operation": {
                "type": "string",
                "enum": ["text_to_video", "image_to_video", "reference_to_video", "first_last_frame_to_video"],
                "default": "text_to_video",
            },
            "model_variant": {
                "type": "string",
                "enum": [
                    "omni_flash-10s",
                    "veo_3_1-fast",
                    "veo_3_1-fast-fl",
                    "veo_3_1-lite",
                    "veo_3_1-lite-fl",
                    "veo_3_1-fast-fl",
                    "veo_3_1-fl",
                ],
                "default": "omni_flash-10s",
            },
            "size": {"type": "string", "default": "720x1280"},
            "image_url": {"type": "string"},
            "image_path": {"type": "string"},
            "reference_image_url": {"type": "string"},
            "reference_image_path": {"type": "string"},
            "reference_image_urls": {"type": "array", "items": {"type": "string"}},
            "reference_image_paths": {"type": "array", "items": {"type": "string"}},
            "first_frame_url": {"type": "string"},
            "first_frame_path": {"type": "string"},
            "last_frame_url": {"type": "string"},
            "last_frame_path": {"type": "string"},
            "poll_interval_seconds": {"type": "number", "default": 5},
            "timeout_seconds": {"type": "integer", "default": 1200},
            "output_path": {"type": "string"},
        },
    }

    resource_profile = ResourceProfile(
        cpu_cores=1, ram_mb=512, vram_mb=0, disk_mb=500, network_required=True
    )
    retry_policy = RetryPolicy(max_retries=1, retryable_errors=["timeout", "rate_limit"])
    idempotency_key_fields = ["prompt", "model_variant", "operation", "size"]
    side_effects = ["writes video file to output_path", "calls SYAPI API"]
    user_visible_verification = ["Watch generated clip for motion, framing, artifacts, and dialogue fit"]

    def _api_key(self) -> str | None:
        return os.environ.get("SYAPI_API_KEY")

    def _base_url(self) -> str:
        return os.environ.get("SYAPI_BASE_URL", "https://api.0000238.xyz").rstrip("/")

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE if self._api_key() else ToolStatus.UNAVAILABLE

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        model = inputs.get("model_variant", "omni_flash-10s")
        if "lite" in model:
            return 0.35
        if "omni" in model:
            return 0.40
        return 0.70

    def estimate_runtime(self, inputs: dict[str, Any]) -> float:
        model = inputs.get("model_variant", "omni_flash-10s")
        return 90.0 if "omni" in model or "fast" in model or "lite" in model else 180.0

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
        operation = inputs.get("operation", "text_to_video")
        if operation == "first_last_frame_to_video":
            if inputs.get("first_frame_url"):
                images.append(inputs["first_frame_url"])
            if inputs.get("first_frame_path"):
                images.append(self._file_to_data_uri(inputs["first_frame_path"]))
            if inputs.get("last_frame_url"):
                images.append(inputs["last_frame_url"])
            if inputs.get("last_frame_path"):
                images.append(self._file_to_data_uri(inputs["last_frame_path"]))
            return images[:2]

        for key in ("image_url", "reference_image_url"):
            if inputs.get(key):
                images.append(inputs[key])
        images.extend(inputs.get("reference_image_urls") or [])
        for key in ("image_path", "reference_image_path"):
            if inputs.get(key):
                images.append(self._file_to_data_uri(inputs[key]))
        images.extend(self._file_to_data_uri(path) for path in (inputs.get("reference_image_paths") or []))
        return images[:3]

    @staticmethod
    def _response_error(data: dict[str, Any]) -> str:
        error = data.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or error.get("code") or error)
        if error:
            return str(error)
        return str(data)

    @staticmethod
    def _quota_hint(body_text: str) -> str:
        if "insufficient_user_quota" not in body_text and "用户剩余额度" not in body_text:
            return ""
        decoded = body_text
        try:
            parsed = json.loads(body_text)
            if isinstance(parsed, dict):
                decoded = str(parsed.get("message") or parsed)
        except Exception:
            pass
        remaining = re.search(r"用户剩余额度:\s*([^,\"]+)", decoded)
        required = re.search(r"需要预扣费额度:\s*([^,\"]+)", decoded)
        if remaining and required:
            return f" 余额不足：用户剩余额度 {remaining.group(1).strip()}，需要预扣费额度 {required.group(1).strip()}。"
        return " 余额不足：SYAPI 返回 insufficient_user_quota，请充值或选择更便宜的视频模型。"

    @classmethod
    def _http_error(
        cls,
        *,
        method: str,
        url: str,
        response: Any,
        model: str,
    ) -> str:
        status = getattr(response, "status_code", "unknown")
        final_url = getattr(response, "url", None) or url
        body_text = ""
        try:
            body = response.json()
            if isinstance(body, dict):
                body_text = cls._response_error(body)
            else:
                body_text = str(body)
        except Exception:
            body_text = getattr(response, "text", "") or ""
        quota_hint = cls._quota_hint(body_text)
        if body_text:
            body_text = f" provider_error={body_text[:500]}"
        return f"SYAPI video HTTP error: {method} {final_url} status={status} model={model}{quota_hint}{body_text}"

    @classmethod
    def _raise_for_status_with_context(
        cls,
        response: Any,
        *,
        method: str,
        url: str,
        model: str,
    ) -> None:
        if getattr(response, "ok", None) is False:
            raise RuntimeError(cls._http_error(method=method, url=url, response=response, model=model))
        try:
            response.raise_for_status()
        except Exception as exc:
            raise RuntimeError(
                cls._http_error(method=method, url=url, response=response, model=model)
            ) from exc

    @staticmethod
    def _extract_video_url(data: dict[str, Any]) -> str | None:
        for key in ("url", "video_url", "output_url"):
            value = data.get(key)
            if isinstance(value, str) and value:
                return value
        video = data.get("video")
        if isinstance(video, dict):
            value = video.get("url") or video.get("video_url")
            if value:
                return value
        output = data.get("output")
        if isinstance(output, dict):
            value = output.get("url") or output.get("video_url")
            if value:
                return value
            nested_video = output.get("video")
            if isinstance(nested_video, dict):
                value = nested_video.get("url") or nested_video.get("video_url")
                if value:
                    return value
        if isinstance(output, list):
            for item in output:
                if isinstance(item, str):
                    return item
                if isinstance(item, dict):
                    value = item.get("url") or item.get("video_url")
                    if value:
                        return value
        return None

    def _poll_task(self, task_id: str, inputs: dict[str, Any], output_path: Path) -> ToolResult:
        import requests

        headers = {"Authorization": f"Bearer {self._api_key()}"}
        deadline = time.time() + int(inputs.get("timeout_seconds", 1200))
        interval = float(inputs.get("poll_interval_seconds", 5))
        last_data: dict[str, Any] = {}

        while time.time() < deadline:
            poll_url = f"{self._base_url()}/v1/videos/{task_id}"
            response = requests.get(poll_url, headers=headers, timeout=30)
            if getattr(response, "ok", None) is False and int(getattr(response, "status_code", 0) or 0) >= 500:
                last_data = {
                    "transient_http_error": self._http_error(
                        method="GET",
                        url=poll_url,
                        response=response,
                        model=str(inputs.get("model_variant", "omni_flash-10s")),
                    )
                }
                time.sleep(interval)
                continue
            self._raise_for_status_with_context(
                response,
                method="GET",
                url=poll_url,
                model=str(inputs.get("model_variant", "omni_flash-10s")),
            )
            data = response.json()
            last_data = data
            status = str(data.get("status", "")).lower()
            if status == "completed":
                video_url = self._extract_video_url(data)
                if not video_url:
                    return ToolResult(success=False, error=f"SYAPI video task completed without URL: {data}")
                download = requests.get(video_url, timeout=240)
                download.raise_for_status()
                output_path.write_bytes(download.content)
                return ToolResult(
                    success=True,
                    data={
                        "provider": "syapi",
                        "model_variant": inputs.get("model_variant", "omni_flash-10s"),
                        "task_id": task_id,
                        "url": video_url,
                        "output": str(output_path),
                        "operation": inputs.get("operation", "text_to_video"),
                        **probe_output(output_path),
                    },
                    artifacts=[str(output_path)],
                    cost_usd=self.estimate_cost(inputs),
                    model=inputs.get("model_variant", "omni_flash-10s"),
                )
            if status == "failed":
                return ToolResult(success=False, error=f"SYAPI video task failed: {self._response_error(data)}")
            time.sleep(interval)

        return ToolResult(success=False, error=f"SYAPI video task timed out: {last_data}")

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        api_key = self._api_key()
        if not api_key:
            return ToolResult(success=False, error="SYAPI_API_KEY not set. " + self.install_instructions)

        import requests

        start = time.time()
        model = inputs.get("model_variant", inputs.get("model", "omni_flash-10s"))
        output_path = Path(inputs.get("output_path", f"syapi_{model}.mp4"))
        output_path.parent.mkdir(parents=True, exist_ok=True)
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

        payload: dict[str, Any] = {
            "model": model,
            "prompt": inputs["prompt"],
        }
        if inputs.get("size"):
            payload["size"] = inputs["size"]
        else:
            payload["size"] = "720x1280"
        images = self._collect_images(inputs)
        if images:
            payload["images"] = images

        try:
            submit_url = f"{self._base_url()}/v1/videos"
            response = requests.post(
                submit_url,
                headers=headers,
                json=payload,
                timeout=60,
            )
            self._raise_for_status_with_context(
                response,
                method="POST",
                url=submit_url,
                model=str(model),
            )
            data = response.json()
            task_id = data.get("id")
            if not task_id:
                return ToolResult(success=False, error=f"SYAPI video response missing id: {data}")
            result = self._poll_task(task_id, inputs, output_path)
            result.duration_seconds = round(time.time() - start, 2)
            return result
        except Exception as exc:
            return ToolResult(success=False, error=f"SYAPI video generation failed: {exc}")
