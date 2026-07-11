from __future__ import annotations

import asyncio
import json
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any


class EventBus:
    def __init__(self):
        self._events: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self._queues: dict[str, list[asyncio.Queue[dict[str, Any]]]] = defaultdict(list)

    def emit(
        self,
        project_id: str,
        *,
        job_id: str,
        stage: str,
        status: str,
        message: str,
    ) -> dict[str, Any]:
        event = {
            "id": uuid.uuid4().hex,
            "job_id": job_id,
            "project_id": project_id,
            "stage": stage,
            "status": status,
            "message": message,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        self._events[project_id].append(event)
        for queue in list(self._queues[project_id]):
            queue.put_nowait(event)
        return event

    def history(self, project_id: str) -> list[dict[str, Any]]:
        return list(self._events.get(project_id, []))

    async def stream(self, project_id: str):
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._queues[project_id].append(queue)
        try:
            for event in self.history(project_id):
                yield _format_sse(event)
            while True:
                event = await queue.get()
                yield _format_sse(event)
        finally:
            self._queues[project_id].remove(queue)


def _format_sse(event: dict[str, Any]) -> str:
    return f"event: job\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"

