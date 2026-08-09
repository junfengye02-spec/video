"""OpenAI GPT Image generation (gpt-image-1 / gpt-image-2 / DALL-E 3)."""

from __future__ import annotations

import base64
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


class OpenAIImage(BaseTool):
    name = "openai_image"
    version = "0.1.0"
    tier = ToolTier.GENERATE
    capability = "image_generation"
    provider = "openai"
    stability = ToolStability.BETA
    execution_mode = ExecutionMode.SYNC
    determinism = Determinism.STOCHASTIC
    runtime = ToolRuntime.API

    dependencies = []  # checked dynamically
    install_instructions = (
        "Set OPENAI_API_KEY to your OpenAI API key.\n"
        "  pip install openai"
    )
    agent_skills = ["flux-best-practices"]  # general image gen knowledge

    capabilities = ["generate_image", "generate_illustration", "text_to_image"]
    supports = {
        "complex_instructions": True,
        "text_in_image": True,
        "multiple_outputs": True,
    }
    best_for = [
        "complex multi-element compositions",
        "images with text/labels",
        "following detailed instructions accurately",
    ]
    not_good_for = ["offline generation", "budget-constrained projects at high quality"]

    input_schema = {
        "type": "object",
        "required": ["prompt"],
        "properties": {
            "prompt": {"type": "string"},
            "model": {
                "type": "string",
                "enum": ["gpt-image-1", "gpt-image-2", "dall-e-3"],
                "default": "gpt-image-1",
            },
            "size": {
                "type": "string",
                "enum": [
                    "1024x1024", "1536x1024", "1024x1536", "auto",
                    "1024x1792", "1792x1024",  # dall-e-3 only
                ],
                "default": "1024x1024",
            },
            "quality": {
                "type": "string",
                "enum": ["low", "medium", "high", "auto", "standard", "hd"],
                "default": "high",
            },
            "output_format": {
                "type": "string",
                "enum": ["png", "jpeg", "webp"],
                "default": "png",
            },
            "n": {"type": "integer", "default": 1, "minimum": 1, "maximum": 4},
            "output_path": {"type": "string"},
            "output_dir": {"type": "string"},
            "filename": {"type": "string"},
        },
    }

    resource_profile = ResourceProfile(
        cpu_cores=1, ram_mb=512, vram_mb=0, disk_mb=100, network_required=True
    )
    retry_policy = RetryPolicy(max_retries=2, retryable_errors=["rate_limit", "timeout"])
    idempotency_key_fields = ["prompt", "size", "quality", "model"]
    side_effects = ["writes image file to output_path", "calls OpenAI API"]
    user_visible_verification = ["Inspect generated image for relevance and quality"]

    def get_status(self) -> ToolStatus:
        if os.environ.get("OPENAI_API_KEY"):
            return ToolStatus.AVAILABLE
        return ToolStatus.UNAVAILABLE

    def estimate_cost(self, inputs: dict[str, Any]) -> float:
        model = inputs.get("model", "gpt-image-1")
        quality = inputs.get("quality", "high")
        n = inputs.get("n", 1)
        if model in {"gpt-image-1", "gpt-image-2"}:
            cost_map = {"low": 0.011, "medium": 0.042, "high": 0.167, "auto": 0.042}
            return cost_map.get(quality, 0.042) * n
        # dall-e-3 fallback pricing
        quality_map = {"standard": 0.04, "hd": 0.08}
        return quality_map.get(quality, 0.04) * n

    @staticmethod
    def _base_url() -> str:
        return (
            os.environ.get("OPENAI_BASE_URL")
            or os.environ.get("OPENAI_API_BASE")
            or "https://api.openai.com/v1"
        ).rstrip("/")

    @staticmethod
    def _output_path(inputs: dict[str, Any], default_filename: str) -> Path:
        if inputs.get("output_path"):
            return Path(inputs["output_path"])
        output_dir = inputs.get("output_dir")
        filename = inputs.get("filename", default_filename)
        if output_dir:
            return Path(output_dir) / filename
        return Path(filename)

    def _execute_gpt_image_2(self, inputs: dict[str, Any]) -> ToolResult:
        import requests

        start = time.time()
        api_key = os.environ["OPENAI_API_KEY"]
        model = inputs.get("model", "gpt-image-2")
        prompt = inputs["prompt"]
        output_format = inputs.get("output_format", "png")
        output_path = self._output_path(inputs, f"generated_image.{output_format}")
        output_path.parent.mkdir(parents=True, exist_ok=True)

        payload: dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "size": inputs.get("size", "1024x1024"),
        }
        if self._base_url() == "https://api.openai.com/v1":
            payload["quality"] = inputs.get("quality", "high")
            payload["n"] = inputs.get("n", 1)

        try:
            response = requests.post(
                f"{self._base_url()}/images/generations",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=180,
            )
            response.raise_for_status()
            data = response.json()
            first = (data.get("data") or [{}])[0]
            if first.get("b64_json"):
                output_path.write_bytes(base64.b64decode(first["b64_json"]))
            elif first.get("url"):
                download = requests.get(first["url"], timeout=180)
                download.raise_for_status()
                output_path.write_bytes(download.content)
            else:
                return ToolResult(
                    success=False,
                    error=f"OpenAI gpt-image-2 response missing b64_json/url: {data}",
                )
        except Exception as e:
            return ToolResult(success=False, error=f"OpenAI gpt-image-2 generation failed: {e}")

        return ToolResult(
            success=True,
            data={
                "provider": "openai",
                "model": model,
                "prompt": prompt,
                "output": str(output_path),
            },
            artifacts=[str(output_path)],
            cost_usd=self.estimate_cost(inputs),
            duration_seconds=round(time.time() - start, 2),
            model=model,
        )

    def execute(self, inputs: dict[str, Any]) -> ToolResult:
        if not os.environ.get("OPENAI_API_KEY"):
            return ToolResult(
                success=False,
                error="OPENAI_API_KEY not set. " + self.install_instructions,
            )

        model = inputs.get("model", "gpt-image-1")
        prompt = inputs["prompt"]
        size = inputs.get("size", "1024x1024")
        n = inputs.get("n", 1)

        if model == "gpt-image-2":
            return self._execute_gpt_image_2(inputs)

        from openai import OpenAI

        start = time.time()
        client = OpenAI()

        try:
            if model == "gpt-image-1":
                quality = inputs.get("quality", "high")
                output_format = inputs.get("output_format", "png")
                request: dict[str, Any] = {
                    "model": model,
                    "prompt": prompt,
                    "size": size,
                    "quality": quality,
                    "n": n,
                }
                if model == "gpt-image-1":
                    request["output_format"] = output_format
                response = client.images.generate(**request)
            else:
                # dall-e-3 path
                quality = inputs.get("quality", "standard")
                if quality in ("low", "medium", "high", "auto"):
                    quality = "standard"  # map to dall-e-3 quality options
                response = client.images.generate(
                    model=model,
                    prompt=prompt,
                    size=size,
                    quality=quality,
                    n=1,  # dall-e-3 only supports n=1
                    response_format="b64_json",
                )

            image_data = base64.b64decode(response.data[0].b64_json)
            ext = inputs.get("output_format", "png")
            output_path = self._output_path(inputs, f"generated_image.{ext}")
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(image_data)

        except Exception as e:
            return ToolResult(success=False, error=f"OpenAI image generation failed: {e}")

        return ToolResult(
            success=True,
            data={
                "provider": "openai",
                "model": model,
                "prompt": prompt,
                "output": str(output_path),
            },
            artifacts=[str(output_path)],
            cost_usd=self.estimate_cost(inputs),
            duration_seconds=round(time.time() - start, 2),
            model=model,
        )
