"""Semantic stage timing and best-effort stream projection."""

from __future__ import annotations

import logging
import time
from typing import Any

_LOG = logging.getLogger(__name__)


class LoopStageEvents:
    def _emit_stage(
        self,
        stage: str,
        t_turn_started: float,
        *,
        stage_started_at: float | None = None,
        **extra: Any,
    ) -> None:
        """Emit a semantic QueryLoop boundary with monotonic timing fields."""
        if self._emitter is None:
            return
        try:
            now = time.monotonic()
            turn_elapsed_ms = int((now - t_turn_started) * 1000)
            stage_elapsed_ms = int((now - (stage_started_at or t_turn_started)) * 1000)
            self._emitter.emit(
                stage,
                {
                    "stage": stage,
                    "elapsed_ms": turn_elapsed_ms,
                    "turn_elapsed_ms": turn_elapsed_ms,
                    "stage_elapsed_ms": stage_elapsed_ms,
                    **extra,
                },
            )
        except Exception:  # noqa: BLE001 -- Telemetry failure cannot interrupt the governed loop.
            _LOG.debug("stream stage emit failed: %s", stage, exc_info=True)
