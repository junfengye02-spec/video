"""MiniMax speech synthesis through the SYAPI gateway."""

from __future__ import annotations

import base64
import json
import string
import time
from pathlib import Path
from typing import Any

from tools._syapi_media import api_key, auth_headers, base_url, find_media_url, response_json
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


class SyapiMiniMaxTTS(BaseTool):
    name = "syapi_minimax_tts"
    version = "0.1.0"
    tier = ToolTier.VOICE
    capability = "tts"
    provider = "syapi"
    stability = ToolStability.EXPERIMENTAL
    execution_mode = ExecutionMode.SYNC
    determinism = Determinism.STOCHASTIC
    runtime = ToolRuntime.API

    dependencies = ["env:SYAPI_API_KEY"]
    install_instructions = (
        "Set SYAPI_API_KEY to an SYAPI gateway token and SYAPI_BASE_URL to the gateway origin."
    )
    agent_skills = ["syapi-minimax-kling"]
    capabilities = ["text_to_speech", "voice_selection", "mandarin", "prosody_control"]
    supports = {
        "voice_cloning": False,
        "multilingual": True,
        "offline": False,
        "native_audio": True,
    }
    best_for = ["natural Mandarin dialogue", "Chinese dubbing hero samples"]
    not_good_for = ["using Kling custom voice IDs", "offline synthesis"]

    input_schema = {
        "type": "object",
        "required": ["text"],
        "properties": {
            "text": {"type": "string"},
            "model": {"type": "string", "default": "speech-2.8-hd"},
            "voice_id": {"type": "string", "default": "female-chengshu"},
            "speed": {"type": "number", "default": 1.0, "minimum": 0.5, "maximum": 2.0},
            "volume": {"type": "number", "default": 1.0, "minimum": 0.1, "maximum": 10.0},
            "pitch": {"type": "integer", "default": 0, "minimum": -12, "maximum": 12},
            "emotion": {"type": "string", "default": "neutral"},
            "format": {"type": "string", "default": "mp3", "enum": ["mp3", "wav"]},
            "sample_rate": {"type": "integer", "default": 32000},
            "bitrate": {"type": "integer", "default": 128000},
            "channel": {"type": "integer", "default": 1, "enum": [1, 2]},
            "language_boost": {"type": "string", "default": "Chinese"},
            "output_path": {"type": "string"},
            "metadata_path": {"type": "string"},
        },
    }
    resource_profile = ResourceProfile(
        cpu_cores=1, ram_mb=256, vram_mb=0, disk_mb=50, network_required=True
    )
    retry_policy = RetryPolicy(max_retries=1, retryable_errors=["timeout", "rate_limit"])
    idempotency_key_fields = ["text", "model", "voice_id", "speed", "pitch"]
    side_effects = ["writes synthesized audio", "calls SYAPI MiniMax TTS"]
    user_visible_verification = ["Listen for Mandarin tone, pacing, and character fit"]

    def get_status(self) -> ToolStatus:
        return ToolStatus.AVAILABLE if api_key() else ToolStatus.UNAVAILABLE

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        return 0.016

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        if not api_key():
            return ToolResult(success=False, error="SYAPI_API_KEY not set. " + self.install_instructions)

        import requests

        model = inputs.get("model", "speech-2.8-hd")
        fmt = inputs.get("format", "mp3")
        output_path = Path(inputs.get("output_path", f"syapi_{model}.{fmt}"))
        metadata_path = Path(
            inputs.get("metadata_path") or output_path.with_suffix(output_path.suffix + ".json")
        )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        payload = self._payload(inputs)
        started = time.time()

        try:
            response = requests.post(
                f"{base_url()}/minimax/v1/t2a_v2",
                headers=auth_headers(json_content=True),
                json=payload,
                timeout=(15, 180),
            )
            content_type = str(response.headers.get("Content-Type", "")).lower()
            if response.ok and content_type.startswith("audio/"):
                response_payload: dict[str, Any] = {"content_type": content_type}
                output_path.write_bytes(response.content)
            else:
                response_payload = response_json(response, "SYAPI MiniMax TTS")
                self._write_audio(response_payload, output_path)
            metadata_path.write_text(
                json.dumps(response_payload, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        except Exception as exc:
            return ToolResult(success=False, error=f"SYAPI MiniMax TTS failed: {exc}")

        duration = self._duration(output_path)
        return ToolResult(
            success=True,
            data={
                "provider": self.provider,
                "model": model,
                "voice_id": payload["voice_setting"]["voice_id"],
                "format": fmt,
                "audio_duration_seconds": round(duration, 3) if duration else None,
                "output": str(output_path),
                "metadata_path": str(metadata_path),
            },
            artifacts=[str(output_path), str(metadata_path)],
            cost_usd=self.estimate_cost(inputs),
            duration_seconds=round(time.time() - started, 2),
            model=model,
        )

    @staticmethod
    def _payload(inputs: dict[str, Any]) -> dict[str, Any]:
        return {
            "model": inputs.get("model", "speech-2.8-hd"),
            "text": inputs["text"],
            "stream": False,
            "voice_setting": {
                "voice_id": inputs.get("voice_id", "female-chengshu"),
                "speed": inputs.get("speed", 1.0),
                "vol": inputs.get("volume", 1.0),
                "pitch": inputs.get("pitch", 0),
                "emotion": inputs.get("emotion", "neutral"),
            },
            "audio_setting": {
                "sample_rate": inputs.get("sample_rate", 32000),
                "bitrate": inputs.get("bitrate", 128000),
                "format": inputs.get("format", "mp3"),
                "channel": inputs.get("channel", 1),
            },
            "language_boost": inputs.get("language_boost", "Chinese"),
        }

    @staticmethod
    def _write_audio(payload: dict[str, Any], output_path: Path) -> None:
        audio_url = find_media_url(payload, (".mp3", ".wav", ".m4a"))
        if audio_url:
            import requests

            response = requests.get(audio_url, timeout=(15, 180))
            response.raise_for_status()
            output_path.write_bytes(response.content)
            return

        audio = payload.get("data", {}).get("audio") if isinstance(payload.get("data"), dict) else None
        if not isinstance(audio, str) or not audio:
            raise RuntimeError("response did not contain data.audio or an audio URL")
        normalized = "".join(audio.split())
        is_hex = len(normalized) % 2 == 0 and all(char in string.hexdigits for char in normalized)
        try:
            decoded = bytes.fromhex(normalized) if is_hex else base64.b64decode(normalized, validate=True)
        except (ValueError, base64.binascii.Error) as exc:
            raise RuntimeError("data.audio was neither hex nor base64") from exc
        output_path.write_bytes(decoded)

    @staticmethod
    def _duration(path: Path) -> float | None:
        try:
            from tools.analysis.audio_probe import probe_duration

            return probe_duration(path)
        except Exception:
            return None
