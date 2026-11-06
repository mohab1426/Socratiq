"""Ingestion worker: a few daemon threads draining QUEUED files. State lives in Postgres (stored_files), so a restart
loses nothing: stale PROCESSING rows are re-queued at startup and periodically."""
from __future__ import annotations

import logging
import threading

from .pipeline import FilePipeline

log = logging.getLogger("socratiq.worker")


class IngestWorker:
    def __init__(self, pipeline: FilePipeline, workers: int = 2, poll_seconds: int = 5, stale_minutes: int = 15):
        self.pipeline, self.n, self.poll, self.stale = pipeline, workers, poll_seconds, stale_minutes
        self._wake, self._stop = threading.Event(), threading.Event()
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        try:
            n = self.pipeline.requeue_stale(0)          # anything left PROCESSING by a previous process is orphaned
            if n:
                log.info("re-queued %s interrupted file(s)", n)
        except Exception:  # noqa: BLE001
            log.exception("could not re-queue interrupted files")
        for i in range(self.n):
            t = threading.Thread(target=self._loop, name=f"ingest-{i}", daemon=True)
            t.start()
            self._threads.append(t)

    def kick(self) -> None:
        self._wake.set()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        for t in self._threads:
            t.join(timeout=5)

    def _loop(self) -> None:
        ticks = 0
        while not self._stop.is_set():
            try:
                result = self.pipeline.process()
            except Exception:  # noqa: BLE001
                log.exception("ingest loop error")
                result = None
            if result is None:
                self._wake.wait(self.poll)
                self._wake.clear()
                ticks += 1
                if ticks % max(1, 60 // max(1, self.poll)) == 0:
                    try:
                        self.pipeline.requeue_stale(self.stale)
                    except Exception:  # noqa: BLE001
                        log.exception("stale requeue failed")
