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
