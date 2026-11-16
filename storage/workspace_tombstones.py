"""Process-local record of workspaces deleted while this server is running.

Turn post-processing (memory reflection, usage, session/state updates) runs on
background threads and can finish after the user deleted the workspace.  Every
storage helper creates missing parents, so those late writes used to bring a
deleted workspace's directory back.  Deleting marks the id here first; record
writers and workspace bootstrap refuse to recreate it until the workspace is
explicitly created again.
"""

from __future__ import annotations

import threading

_LOCK = threading.Lock()
_DELETED: set[str] = set()


class WorkspaceDeletedError(RuntimeError):
    """A background write targeted a workspace that has been deleted."""

    def __init__(self, workspace_id: str):
        super().__init__(f"workspace_deleted: {workspace_id}")
        self.workspace_id = workspace_id


def mark_deleted(workspace_id: str) -> None:
    with _LOCK:
        _DELETED.add(workspace_id)


def revive(workspace_id: str) -> None:
    with _LOCK:
        _DELETED.discard(workspace_id)


def is_deleted(workspace_id: str) -> bool:
    with _LOCK:
        return workspace_id in _DELETED


def ensure_not_deleted(workspace_id: str) -> None:
    if is_deleted(workspace_id):
        raise WorkspaceDeletedError(workspace_id)


def reset() -> None:
    """Forget every mark (test isolation only)."""
    with _LOCK:
        _DELETED.clear()
