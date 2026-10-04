"""SSOT persistence boundary; public orchestration remains in ssot_runtime."""

from __future__ import annotations

import logging
from typing import Any

from agent.runtime.result import AgentResult
from agent.runtime.utils import now_iso


def _persist_inflight_user_message(session, turn, user_input: str) -> None:
    """Durably retain the original request before tools can run.

    The terminal run persistence writes the same `(run_id, user)` projection
    again, so this is idempotent.  An interrupted process therefore restores a
    safe untrusted context for an explicit later resume.
    """
    if not user_input or isinstance(
        (getattr(turn.op, "metadata", {}) or {}).get("approval_continuation_resume"),
        dict,
    ):
        return
    from agent.runtime.message_identity import (
        user_message_storage_run_id,
        workbench_message_metadata,
    )
    from core.runtime_engine.context_compaction import build_history_state_record
    from storage.message_store import SessionMessageStore

    metadata = dict(getattr(turn.op, "metadata", {}) or {})
    message_run_id = user_message_storage_run_id(
        str(metadata.get("client_request_id") or ""),
        turn.turn_id,
    )
    SessionMessageStore(
        session_id=session.session_id, ws_id=session.workspace_id
    ).write_message(
        message_run_id,
        "user",
        user_input,
        metadata={
            "created_at": now_iso(),
            "client_request_id": str(metadata.get("client_request_id") or ""),
            "attachments": list(metadata.get("attachments") or []),
            **workbench_message_metadata(metadata),
            "history_state": build_history_state_record(
                "user", user_input, references=list(metadata.get("attachments") or [])
            ),
        },
    )


def _mark_task_state_persistence_failure(result: AgentResult, code: str) -> None:
    """Expose state-store degradation without invalidating completed work.

    TaskState is a durable projection of the agent loop, not the authority
    that decides whether a tool result happened.  Reclassifying a completed
    turn as failed here previously destroyed the model's response and made a
    storage incident look like an Agent failure.
    """
    result.metadata["task_state_persistence"] = {
        "stage": "commit",
        "status": "degraded",
        "code": code,
    }
    if code not in result.warnings:
        result.warnings.append(code)


def _mark_run_record_persistence_failure(result: AgentResult, code: str) -> None:
    """Expose run-record degradation without rewriting the Agent outcome."""
    result.metadata["run_record_persistence"] = {
        "stage": "persist",
        "status": "degraded",
        "code": code,
    }
    if code not in result.warnings:
        result.warnings.append(code)


def _task_state_runtime_metadata(
    result_metadata: dict[str, Any] | None,
) -> dict[str, Any]:
    """Project only server-owned terminal facts into the TaskState commit.

    ``ssot_runtime`` preserves raw QueryLoop metrics, while the adapter may
    normalize lifecycle fields (notably a primary QueryLoop ``error`` into
    ``runtime_errors``).  Passing the raw mirror alone splits TaskState from the
    delivered AgentResult.  The fixed allow-list preserves the execution facts
    without allowing caller-provided top-level metadata to influence state.
    """
    metadata = result_metadata if isinstance(result_metadata, dict) else {}
    raw = metadata.get("ssot_runtime")
    projected = dict(raw) if isinstance(raw, dict) else {}
    for key in (
        "execution_outcome",
        "runtime_errors",
        "tool_execution_outcome",
        "unknown_outcome",
        "goal_assertions",
        "recovery_goals",
        "recovery_goal_events",
        "goal_loop",
        "evidence",
        "cognitive",
        "cognitive_events",
    ):
        if key in metadata:
            projected[key] = metadata[key]
    return projected


def _sync_session_history(
    session,
    user_input: str,
    final_response: str,
    *,
    include_user: bool = True,
    include_assistant: bool = True,
    run_id: str = "",
    client_request_id: str = "",
) -> None:
    """Append current turn to session.history for context in next turns."""
    try:
        from agent.protocol.message import AssistantMessage, UserMessage

        history = getattr(session, "history", None)
        if history is None:
            history = []
            session.history = history

        # Dedup check: skip if last entries already match
        if include_user and not include_assistant and history:
            last = history[-1]
            if (
                getattr(last, "role", "") == "user"
                and getattr(last, "content", "") == user_input
            ):
                return
        if include_assistant and not include_user and history:
            last = history[-1]
            if (
                getattr(last, "role", "") == "assistant"
                and getattr(last, "content", "") == final_response
            ):
                return
        if len(history) >= 2:
            last_user = history[-2]
            last_asst = history[-1]
            if (
                getattr(last_user, "role", "") == "user"
                and getattr(last_asst, "role", "") == "assistant"
                and getattr(last_user, "content", "") == user_input
                and getattr(last_asst, "content", "") == final_response
            ):
                return

        if not final_response and not (include_user and user_input):
            return

        if include_user and user_input:
            history.append(
                UserMessage(
                    content=user_input,
                    message_id=(
                        f"{client_request_id}:user"
                        if client_request_id
                        else f"{run_id}:user"
                    ),
                    run_id=run_id,
                    client_request_id=client_request_id,
                )
            )
        if include_assistant and final_response:
            history.append(
                AssistantMessage(
                    content=final_response,
                    message_id=f"{run_id}:assistant",
                    run_id=run_id,
                    client_request_id=client_request_id,
                )
            )
    except Exception:
        logging.getLogger(__name__).warning(
            "Failed to sync session history", exc_info=True
        )
