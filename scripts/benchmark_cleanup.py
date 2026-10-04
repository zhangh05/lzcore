"""Bounded, governed teardown of benchmark-owned delegated workers."""

from __future__ import annotations

import time


def drain_delegations(
    client, workspace_id: str, session_id: str, timeout: float = 20.0
) -> dict:
    from core.tools.context import ToolRuntimeContext
    from storage.subagent_store import list_subagents
    from agent.runtime.durable.subagent import subagent_worker_alive

    def owned():
        return [
            row
            for row in list_subagents(workspace_id, 1000)
            if row.get("session_id") == session_id
        ]

    try:
        for row in owned():
            if row["status"] in {"created", "running"}:
                client.invoke(
                    "agent.manage",
                    {"action": "cancel", "subtask_id": row["subtask_id"]},
                    context=ToolRuntimeContext(
                        workspace_id=workspace_id,
                        session_id=session_id,
                        task_id=row.get("parent_task_id", ""),
                        requested_by="turn_runner",
                    ),
                )
        deadline = time.monotonic() + timeout
        while True:
            remaining = []
            for row in owned():
                environment = row.get("coding", {}).get("environment")
                if subagent_worker_alive(workspace_id, row["subtask_id"]) or (
                    environment and not environment.get("cleanup_confirmed")
                ):
                    remaining.append(row["subtask_id"])
            if not remaining or time.monotonic() >= deadline:
                return {"confirmed": not remaining, "remaining_subtasks": remaining}
            time.sleep(0.1)
    except (OSError, ValueError, KeyError):
        return {"confirmed": False, "reason": "delegation_cleanup_unconfirmed"}
