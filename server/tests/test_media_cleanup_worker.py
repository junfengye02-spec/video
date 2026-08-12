from __future__ import annotations

import threading
from pathlib import Path

from server.media_cleanup_worker import run_worker


def test_cleanup_worker_runs_immediately_and_stops_cleanly(tmp_path):
    stop = threading.Event()
    calls: list[Path] = []

    def cleanup(projects_root: Path) -> list[Path]:
        calls.append(projects_root)
        stop.set()
        return []

    result = run_worker(
        stop,
        projects_root=tmp_path,
        interval_seconds=1,
        cleanup=cleanup,
    )

    assert result == 0
    assert calls == [tmp_path]


def test_cleanup_worker_runs_model_cleanup_at_most_once_per_day(tmp_path):
    stop = threading.Event()
    media_calls: list[Path] = []
    model_calls: list[bool] = []
    ticks = iter([0.0, 0.0, 0.0, 3600.0, 3600.0])

    def cleanup(projects_root: Path) -> list[Path]:
        media_calls.append(projects_root)
        if len(media_calls) == 2:
            stop.set()
        return []

    def cleanup_models() -> list[str]:
        model_calls.append(True)
        return ["removed-model"]

    result = run_worker(
        stop,
        projects_root=tmp_path,
        interval_seconds=1,
        cleanup=cleanup,
        model_cleanup=cleanup_models,
        model_cleanup_interval_seconds=86_400,
        monotonic=lambda: next(ticks),
    )

    assert result == 0
    assert media_calls == [tmp_path, tmp_path]
    assert model_calls == [True]
