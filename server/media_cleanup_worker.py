from __future__ import annotations

import logging
import signal
import threading
from collections.abc import Callable
from pathlib import Path

from server.app.media_retention import cleanup_expired_media
from server.app.settings import (
    DEFAULT_PROJECTS_ROOT,
    MEDIA_CLEANUP_INTERVAL_SECONDS,
)


logger = logging.getLogger("miseStudio.media_cleanup")


def install_signal_handlers(stop: threading.Event) -> None:
    def request_stop(_signum, _frame) -> None:
        stop.set()

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)


def run_worker(
    stop: threading.Event,
    *,
    projects_root: Path = DEFAULT_PROJECTS_ROOT,
    interval_seconds: int = MEDIA_CLEANUP_INTERVAL_SECONDS,
    cleanup: Callable[[Path], list[Path]] = cleanup_expired_media,
) -> int:
    while not stop.is_set():
        deleted = cleanup(projects_root)
        logger.info("expired video cleanup completed deleted_files=%d", len(deleted))
        stop.wait(interval_seconds)
    return 0


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    stop = threading.Event()
    install_signal_handlers(stop)
    return run_worker(stop)


if __name__ == "__main__":
    raise SystemExit(main())
