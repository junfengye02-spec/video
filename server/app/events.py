from __future__ import annotations

import asyncio
import json
import threading
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any


class EventBus:
    def __init__(self):
        self._events: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self._queues: dict[
            str, list[tuple[asyncio.AbstractEventLoop, asyncio.Queue[dict[str, Any]]]]
        ] = defaultdict(list)
        self._lock = threading.RLock()

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
        self._publish(project_id, event)
        return event

    def emit_task(
        self,
        project_id: str,
        *,
        task_id: str,
        status: str,
        progress: int,
        message: str,
        item_id: str | None = None,
    ) -> dict[str, Any]:
        event = {
            "id": uuid.uuid4().hex,
            "job_id": task_id,
            "project_id": project_id,
            "stage": "task_item" if item_id is not None else "task",
            "status": status,
            "message": message,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "event_type": "task_item" if item_id is not None else "task",
            "task_id": task_id,
            "item_id": item_id,
            "progress": progress,
        }
        self._publish(project_id, event)
        return event

    def _publish(self, project_id: str, event: dict[str, Any]) -> None:
        with self._lock:
            self._events[project_id].append(event)
            subscribers = list(self._queues[project_id])
        for loop, queue in subscribers:
            try:
                loop.call_soon_threadsafe(queue.put_nowait, event)
            except RuntimeError:
                # A stream can disconnect between the subscriber snapshot and publish.
                continue

    def history(self, project_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._events.get(project_id, []))

    async def stream(self, project_id: str):
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        subscriber = (asyncio.get_running_loop(), queue)
        with self._lock:
            self._queues[project_id].append(subscriber)
            history = list(self._events.get(project_id, []))
        try:
            for event in history:
                yield _format_sse(event)
            while True:
                event = await queue.get()
                yield _format_sse(event)
        finally:
            with self._lock:
                subscribers = self._queues.get(project_id, [])
                if subscriber in subscribers:
                    subscribers.remove(subscriber)


def _format_sse(event: dict[str, Any]) -> str:
    return f"event: job\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
