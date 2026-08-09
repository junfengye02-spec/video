"""Kling custom voice creation through the SYAPI gateway."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from tools._syapi_media import (
    api_key,
    auth_headers,
    base_url,
    find_value,
    response_json,
    task_id,
    task_status,
    upload_file,
)
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


class SyapiKlingCustomVoice(BaseTool):
    name = "syapi_kling_custom_voice"
    version = "0.1.0"
    tier = ToolTier.VOICE
    capability = "voice_cloning"
    provider = "syapi"
    stability = ToolStability.EXPERIMENTAL
    execution_mode = ExecutionMode.ASYNC
    determinism = Determinism.STOCHASTIC
    runtime = ToolRuntime.API

    dependencies = ["env:SYAPI_API_KEY"]
    install_instructions = (
        "Set SYAPI_API_KEY to an SYAPI gateway token and SYAPI_BASE_URL to the gateway origin."
    )
    agent_skills = ["syapi-minimax-kling"]
    capabilities = ["voice_cloning", "custom_voice_identity"]
    supports = {"audio_reference": True, "video_reference": True, "async_generation": True}
    best_for = ["stable Kling character voices from clean 5-30 second references"]
    not_good_for = ["references with multiple speakers", "references shorter than five seconds"]
    input_schema = {
        "type": "object",
        "required": ["voice_name"],
        "properties": {
            "voice_name": {"type": "string", "maxLength": 20},
            "voice_path": {"type": "string"},
            "voice_url": {"type": "string"},
            "video_id": {"type": "string"},
            "external_task_id": {"type": "string"},
            "callback_url": {"type": "string"},
            "metadata_path": {"type": "string"},
            "poll_interval_seconds": {"type": "number", "default": 5},
            "timeout_seconds": {"type": "integer", "default": 600},
        },
    }
    resource_profile = ResourceProfile(
        cpu_cores=1, ram_mb=256, vram_mb=0, disk_mb=20, network_required=True
    )
    retry_policy = RetryPolicy(max_retries=1, retryable_errors=["timeout", "rate_limit"])
    idempotency_key_fields = ["voice_name", "voice_url", "video_id"]
    side_effects = ["uploads reference media", "creates a Kling custom voice"]
    user_visible_verification = ["Use the returned voice ID in a Kling TTS preview before batch use"]

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE if api_key() else ToolStatus.UNAVAILABLE

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        return 0.017

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        if not api_key():
            return ToolResult(success=False, error="SYAPI_API_KEY not set. " + self.install_instructions)
        if not inputs.get("voice_url") and not inputs.get("voice_path") and not inputs.get("video_id"):
            return ToolResult(success=False, error="Pass voice_path, voice_url, or video_id")
        if len(inputs["voice_name"]) > 20:
            return ToolResult(success=False, error="Kling voice_name must be at most 20 characters")

        import requests

        started = time.time()
        metadata_path = Path(inputs.get("metadata_path", "syapi_kling_custom_voice.json"))
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            voice_url = inputs.get("voice_url")
            if not voice_url and inputs.get("voice_path"):
                voice_url = upload_file(Path(inputs["voice_path"]))
            payload = {
                "voice_name": inputs["voice_name"],
                "voice_url": voice_url or "",
                "video_id": inputs.get("video_id", ""),
                "callback_url": inputs.get("callback_url", ""),
                "external_task_id": inputs.get("external_task_id", ""),
            }
            response = requests.post(
                f"{base_url()}/kling/v1/general/custom-voices",
                headers=auth_headers(json_content=True),
                json=payload,
                timeout=(15, 180),
            )
            submit_payload = response_json(response, "SYAPI Kling custom voice")
            voice_id = find_value(submit_payload, ("voice_id",))
            identifier = task_id(submit_payload)
            final_payload = submit_payload
            if not voice_id:
                if not identifier:
                    raise RuntimeError("custom voice response did not include a task or voice ID")
                final_payload = self._poll(
                    identifier,
                    interval=float(inputs.get("poll_interval_seconds", 5)),
                    timeout_seconds=int(inputs.get("timeout_seconds", 600)),
                )
                voice_id = find_value(final_payload, ("voice_id",))
            if not voice_id:
                raise RuntimeError("custom voice task completed without a voice ID")
            metadata = {
                "model": "kling-custom-voices",
                "task_id": identifier,
                "voice_id": str(voice_id),
                "voice_name": inputs["voice_name"],
                "voice_url": voice_url,
                "response": final_payload,
            }
            metadata_path.write_text(
                json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
        except Exception as exc:
            return ToolResult(success=False, error=f"SYAPI Kling custom voice failed: {exc}")

        return ToolResult(
            success=True,
            data={
                "provider": self.provider,
                "model": "kling-custom-voices",
                "task_id": identifier,
                "voice_id": str(voice_id),
                "voice_name": inputs["voice_name"],
                "metadata_path": str(metadata_path),
            },
            artifacts=[str(metadata_path)],
            cost_usd=self.estimate_cost(inputs),
            duration_seconds=round(time.time() - started, 2),
            model="kling-custom-voices",
        )

    def _poll(self, identifier: str, *, interval: float, timeout_seconds: int) -> dict[str, Any]:
        import requests

        deadline = time.time() + timeout_seconds
        last_payload: dict[str, Any] = {}
        while time.time() < deadline:
            response = requests.get(
                f"{base_url()}/kling/v1/general/custom-voices/{identifier}",
                headers=auth_headers(),
                timeout=(15, 60),
            )
            last_payload = response_json(response, "SYAPI Kling custom voice query")
            status = task_status(last_payload)
            if status in {"succeed", "succeeded", "success", "completed", "done"}:
                return last_payload
            if status in {"failed", "failure", "error", "cancelled", "canceled"}:
                raise RuntimeError(f"custom voice task ended with status {status}")
            time.sleep(interval)
        raise TimeoutError(f"custom voice task did not finish within {timeout_seconds} seconds")
