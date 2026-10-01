"""Optional admission barrier for an embedded local application's lifecycle.

Server deployments do not install this barrier. Reservations cover accepted
work before a durable job exists, so exit/update cannot race a new turn.
"""
from __future__ import annotations

import threading
from contextlib import contextmanager


class LocalLifecycle:
    def __init__(self):
        self._lock = threading.RLock()
        self.accepting = True
        self.active = 0

    def reserve(self) -> bool:
        with self._lock:
            if not self.accepting:
                return False
            self.active += 1
            return True

    def release(self):
        with self._lock:
            self.active = max(0, self.active - 1)

    def pause(self, *, require_idle=True) -> bool:
        with self._lock:
            if require_idle and self.active:
                return False
            self.accepting = False
            return True

    def resume(self):
        with self._lock:
            self.accepting = True

    @contextmanager
    def operation(self):
        accepted = self.reserve()
        try:
            yield accepted
        finally:
            if accepted:
                self.release()


_local_lifecycle: LocalLifecycle | None = None


def install_local_lifecycle(value: LocalLifecycle | None):
    global _local_lifecycle
    _local_lifecycle = value


def local_lifecycle() -> LocalLifecycle | None:
    return _local_lifecycle
