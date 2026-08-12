from __future__ import annotations

import logging
import signal
import threading
import time
from collections.abc import Callable
from pathlib import Path

from server.app.core.config import get_settings
from server.app.db.session import SessionLocal
from server.app.media_retention import cleanup_expired_media
from server.app.provider.newapi import (
    InvalidNewApiResponse,
    NewApiCallError,
    NewApiClient,
)
from server.app.settings import (
    DEFAULT_PROJECTS_ROOT,
    MEDIA_CLEANUP_INTERVAL_SECONDS,
)
from server.app.video_model_settings.cleanup import (
    synchronize_video_model_settings,
)


logger = logging.getLogger("miseStudio.media_cleanup")
VIDEO_MODEL_CLEANUP_INTERVAL_SECONDS = 24 * 60 * 60


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
    model_cleanup: Callable[[], list[str]] | None = None,
    model_cleanup_interval_seconds: int = VIDEO_MODEL_CLEANUP_INTERVAL_SECONDS,
    monotonic: Callable[[], float] = time.monotonic,
) -> int:
    next_model_cleanup = monotonic()
    while not stop.is_set():
        deleted = cleanup(projects_root)
        logger.info("expired video cleanup completed deleted_files=%d", len(deleted))
        if (
            model_cleanup is not None
            and not stop.is_set()
            and monotonic() >= next_model_cleanup
        ):
            try:
                deleted_models = model_cleanup()
                logger.info(
                    "missing video model cleanup completed deleted_settings=%d",
                    len(deleted_models),
                )
            except (InvalidNewApiResponse, NewApiCallError):
                logger.warning(
                    "missing video model cleanup skipped: catalog unavailable"
                )
            except Exception:
                logger.exception("missing video model cleanup failed")
            next_model_cleanup = monotonic() + model_cleanup_interval_seconds
        stop.wait(interval_seconds)
    return 0


def cleanup_missing_video_models() -> list[str]:
    with SessionLocal() as db, NewApiClient(get_settings()) as newapi:
        return synchronize_video_model_settings(db, newapi)


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    stop = threading.Event()
    install_signal_handlers(stop)
    return run_worker(stop, model_cleanup=cleanup_missing_video_models)


if __name__ == "__main__":
    raise SystemExit(main())
