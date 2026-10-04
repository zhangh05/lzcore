"""Process-local server cancellation links; never serialized or model-owned."""

from __future__ import annotations

import threading

from storage.paths import workspace_root

_LOCK = threading.RLock()
_PARENTS = {}


def register_parent_cancel(workspace_id: str, subtask_id: str, check) -> None:
    if callable(check):
        with _LOCK:
            _PARENTS[(str(workspace_root(workspace_id).resolve()), subtask_id)] = check


def cancellation_probe(workspace_id: str, subtask_id: str, event):
    key = (str(workspace_root(workspace_id).resolve()), subtask_id)

    def cancelled() -> bool:
        if event.is_set():
            return True
        with _LOCK:
            parent = _PARENTS.get(key)
        if parent is not None:
            try:
                if parent():
                    event.set()
                    return True
            except Exception:
                # An unavailable cancellation source cannot authorize more
                # delegated side effects.
                event.set()
                return True
        return False

    return cancelled


def release_parent_cancel(workspace_id: str, subtask_id: str) -> None:
    with _LOCK:
        _PARENTS.pop((str(workspace_root(workspace_id).resolve()), subtask_id), None)
