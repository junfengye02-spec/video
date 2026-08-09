"""Kling advanced lip sync through the SYAPI gateway."""

from __future__ import annotations

import base64
import json
import time
from pathlib import Path
from typing import Any

from tools._syapi_media import (
    api_key,
    auth_headers,
    base_url,
    collect_values,
    download_file,
    find_media_url,
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


class SyapiKlingLipSync(BaseTool):
    name = "syapi_kling_lip_sync"
    version = "0.1.0"
    tier = ToolTier.GENERATE
    capability = "avatar"
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
    capabilities = ["lip_sync", "face_recognition", "audio_video_alignment", "dubbing_support"]
    supports = {"video_input": True, "audio_url": True, "single_face": True, "async_generation": True}
    best_for = ["close-up dubbed dialogue with one clearly visible face"]
    not_good_for = ["crowd shots", "profiles with an obscured mouth"]
    input_schema = {
        "type": "object",
        "required": ["video_path"],
        "properties": {
            "video_path": {"type": "string"},
            "audio_path": {"type": "string"},
            "video_url": {"type": "string"},
            "audio_url": {"type": "string"},
            "audio_base64": {"type": "string"},
            "session_id": {"type": "string"},
            "face_id": {"type": "string"},
            "recognition_only": {"type": "boolean", "default": False},
            "sound_insert_time_ms": {"type": "integer", "default": 0},
            "sound_volume": {"type": "number", "default": 1.0},
            "original_audio_volume": {"type": "number", "default": 0.0},
            "external_task_id": {"type": "string"},
            "callback_url": {"type": "string"},
            "output_path": {"type": "string"},
            "metadata_path": {"type": "string"},
            "poll_interval_seconds": {"type": "number", "default": 8},
            "timeout_seconds": {"type": "integer", "default": 1800},
        },
    }
    resource_profile = ResourceProfile(
        cpu_cores=1, ram_mb=512, vram_mb=0, disk_mb=500, network_required=True
    )
    retry_policy = RetryPolicy(max_retries=1, retryable_errors=["timeout", "rate_limit"])
    idempotency_key_fields = ["video_path", "audio_path", "face_id", "sound_insert_time_ms"]
    side_effects = ["uploads video and audio", "runs Kling face recognition and advanced lip sync"]
    user_visible_verification = ["Watch the mouth throughout the result and check for drift or face artifacts"]

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE if api_key() else ToolStatus.UNAVAILABLE

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        if inputs.get("recognition_only") or inputs.get("session_id"):
            return 0.017
        return 0.034

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        if not api_key():
            return ToolResult(success=False, error="SYAPI_API_KEY not set. " + self.install_instructions)

        import requests

        video_path = Path(inputs["video_path"])
        if not video_path.is_file():
            return ToolResult(success=False, error=f"Video not found: {video_path}")

        output_path = Path(inputs.get("output_path", video_path.with_stem(video_path.stem + "_kling_lipsync")))
        metadata_path = Path(
            inputs.get("metadata_path") or output_path.with_suffix(output_path.suffix + ".json")
        )
        started = time.time()
        try:
            video_url = inputs.get("video_url") or upload_file(video_path)
            session_id = inputs.get("session_id")
            recognize_payload: dict[str, Any] = {}
            if not session_id:
                recognize_response = requests.post(
                    f"{base_url()}/kling/v1/videos/identify-face",
                    headers=auth_headers(json_content=True),
                    json={"video_id": "", "video_url": video_url},
                    timeout=(15, 300),
                )
                recognize_payload = response_json(recognize_response, "SYAPI Kling face recognition")
                session_id = find_value(recognize_payload, ("session_id",))
                if not session_id:
                    raise RuntimeError("face recognition response did not include session_id")
            recognized_faces = [str(value) for value in collect_values(recognize_payload, "face_id")]
            face_id = str(inputs.get("face_id") or (recognized_faces[0] if recognized_faces else "-1"))

            if inputs.get("recognition_only"):
                metadata = {
                    "model": "kling-advanced-lip-sync",
                    "stage": "face_recognition",
                    "session_id": str(session_id),
                    "recognized_face_ids": recognized_faces,
                    "video_url": video_url,
                    "recognize_response": recognize_payload,
                }
                metadata_path.parent.mkdir(parents=True, exist_ok=True)
                metadata_path.write_text(
                    json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
                )
                return ToolResult(
                    success=True,
                    data={
                        "provider": self.provider,
                        "model": "kling-advanced-lip-sync",
                        "stage": "face_recognition",
                        "session_id": str(session_id),
                        "recognized_face_ids": recognized_faces,
                        "video_url": video_url,
                        "metadata_path": str(metadata_path),
                    },
                    artifacts=[str(metadata_path)],
                    cost_usd=self.estimate_cost(inputs),
                    duration_seconds=round(time.time() - started, 2),
                    model="kling-advanced-lip-sync",
                )

            if not inputs.get("audio_path"):
                raise RuntimeError("audio_path is required after face recognition")
            audio_path = Path(inputs["audio_path"])
            if not audio_path.is_file():
                raise FileNotFoundError(f"Audio not found: {audio_path}")
            audio_url = inputs.get("audio_url")
            audio_base64 = inputs.get("audio_base64")
            if audio_url:
                sound_file = audio_url
                audio_transport = "url"
            else:
                sound_file = audio_base64 or base64.b64encode(audio_path.read_bytes()).decode("ascii")
                audio_transport = "base64"

            duration_ms = self._audio_duration_ms(audio_path)
            if duration_ms < 2000:
                raise RuntimeError("Kling advanced lip sync requires at least two seconds of audio")
            insert_time = int(inputs.get("sound_insert_time_ms", 0))
            payload = {
                "session_id": str(session_id),
                "face_choose": [
                    {
                        "face_id": face_id,
                        "audio_id": "",
                        "sound_file": sound_file,
                        "sound_start_time": 0,
                        "sound_end_time": duration_ms,
                        "sound_insert_time": insert_time,
                        "sound_volume": float(inputs.get("sound_volume", 1.0)),
                        "original_audio_volume": float(inputs.get("original_audio_volume", 0.0)),
                    }
                ],
                "external_task_id": inputs.get("external_task_id", ""),
                "callback_url": inputs.get("callback_url", ""),
            }
            submit_response = requests.post(
                f"{base_url()}/kling/v1/videos/advanced-lip-sync",
                headers=auth_headers(json_content=True),
                json=payload,
                timeout=(15, 300),
            )
            submit_payload = response_json(submit_response, "SYAPI Kling advanced lip sync")
            identifier = task_id(submit_payload)
            if not identifier:
                raise RuntimeError("lip-sync response did not include a task ID")
            final_payload = self._poll(
                identifier,
                interval=float(inputs.get("poll_interval_seconds", 8)),
                timeout_seconds=int(inputs.get("timeout_seconds", 1800)),
            )
            result_url = find_media_url(final_payload, (".mp4", ".mov"))
            if not result_url:
                raise RuntimeError("lip-sync task completed without a video URL")
            download_file(result_url, output_path)
            metadata = {
                "model": "kling-advanced-lip-sync",
                "task_id": identifier,
                "session_id": str(session_id),
                "face_id": face_id,
                "recognized_face_ids": recognized_faces,
                "video_url": video_url,
                "audio_transport": audio_transport,
                "result_url": result_url,
                "timing": {
                    key: value
                    for key, value in payload["face_choose"][0].items()
                    if key != "sound_file"
                },
                "recognize_response": recognize_payload,
                "response": final_payload,
            }
            metadata_path.parent.mkdir(parents=True, exist_ok=True)
            metadata_path.write_text(
                json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
        except Exception as exc:
            return ToolResult(success=False, error=f"SYAPI Kling lip sync failed: {exc}")

        return ToolResult(
            success=True,
            data={
                "provider": self.provider,
                "model": "kling-advanced-lip-sync",
                "task_id": identifier,
                "session_id": str(session_id),
                "face_id": face_id,
                "output": str(output_path),
                "metadata_path": str(metadata_path),
                "url": result_url,
            },
            artifacts=[str(output_path), str(metadata_path)],
            cost_usd=self.estimate_cost(inputs),
            duration_seconds=round(time.time() - started, 2),
            model="kling-advanced-lip-sync",
        )

    def _poll(self, identifier: str, *, interval: float, timeout_seconds: int) -> dict[str, Any]:
        import requests

        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            response = requests.get(
                f"{base_url()}/kling/v1/videos/advanced-lip-sync/{identifier}",
                headers=auth_headers(),
                timeout=(15, 60),
            )
            payload = response_json(response, "SYAPI Kling lip-sync query")
            status = task_status(payload)
            if status in {"succeed", "succeeded", "success", "completed", "done"}:
                return payload
            if status in {"failed", "failure", "error", "cancelled", "canceled"}:
                message = find_value(payload, ("message", "status_msg", "error"))
                raise RuntimeError(f"lip-sync task ended with status {status}: {message or 'unknown error'}")
            time.sleep(interval)
        raise TimeoutError(f"lip-sync task did not finish within {timeout_seconds} seconds")

    @staticmethod
    def _audio_duration_ms(path: Path) -> int:
        from tools.analysis.audio_probe import probe_duration

        duration = probe_duration(path)
        if not duration:
            raise RuntimeError("could not determine generated audio duration")
        return max(0, int(float(duration) * 1000) - 20)
