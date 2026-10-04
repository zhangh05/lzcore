"""Activate already-authorized coding DAG work after durable phase changes.

No publication, task recreation, or unknown-write replay. Process restart
recovery uses explicit start; reads never start side effects.
"""
from collections import deque
from storage.subagent_store import list_subagents


def dispatch_dependents(trigger):
    from .subagent import _load_task, start_subagent_task

    pending = deque([trigger])
    while pending:
        current = pending.popleft()
        for record in list_subagents(current.workspace_id, 1000):
            coding = record.get("coding") or {}
            if (
                record.get("status") != "created"
                or record.get("parent_task_id") != current.parent_task_id
                or record.get("session_id") != current.session_id
                or not coding
                or current.subtask_id not in [*(coding.get("depends_on") or []), coding.get("review_subtask_id")]
            ):
                continue
            task = _load_task(current.workspace_id, record["subtask_id"])
            if task is None or (task.workspace_id, task.parent_task_id, task.session_id) != (
                current.workspace_id, current.parent_task_id, current.session_id
            ):
                continue
            result = start_subagent_task(task.subtask_id, current.workspace_id)
            if result.get("status") == "failed":
                # Propagate a failed prerequisite through queued descendants.
                pending.append(_load_task(current.workspace_id, task.subtask_id))
