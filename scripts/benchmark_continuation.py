"""Read-only identity check before a benchmark can continue a known task."""

from agent.runtime.task_state import load_task_state, resolve_task_state
from storage.message_store import SessionMessageStore


def continuation_preflight(workspace_id: str, session_id: str, prompt: str, expected_task_id: str) -> dict:
    state = load_task_state(workspace_id, session_id)
    current = (state.get("task") or {}).get("task_id")
    observation = {
        "status": "BLOCKED", "stage": "task_continuation_preflight",
        "expected_task_id": expected_task_id, "current_task_id": current,
        "resolved_task_id": None, "reason": "explicit_parent_task_identity_required",
    }
    if not expected_task_id:
        return observation
    if current != expected_task_id:
        return {**observation, "reason": "parent_task_identity_mismatch"}
    contract = resolve_task_state(
        workspace_id=workspace_id, session_id=session_id, user_input=prompt,
        messages=SessionMessageStore(session_id, workspace_id).get_messages(),
    )
    resolved = (contract or {}).get("task_id")
    observation["resolved_task_id"] = resolved
    if resolved != expected_task_id:
        return {**observation, "reason": "request_would_start_another_task"}
    return {**observation, "status": "READY", "reason": "parent_identity_verified"}
