"""SSOT memory boundary; public orchestration remains in ssot_runtime."""

from __future__ import annotations

import concurrent.futures
import logging
from typing import Any

_LOG = logging.getLogger(__name__)
from storage.principal import ContextThreadPoolExecutor

_MEMORY_WRITE_EXECUTOR = ContextThreadPoolExecutor(
    max_workers=1,
    thread_name_prefix="ssot-memory-write",
)


def _record_experience_and_maybe_reflect(
    *,
    workspace_id: str,
    session_id: str,
    task_id: str,
    user_input: str,
    assistant_response: str,
    tool_calls: list[dict[str, Any]],
    task_ok: bool,
) -> None:
    try:
        from agent.runtime.memory_hooks import install_memory_governance_hooks
        from agent.runtime.memory_write.commands import (
            apply_memory_command,
            parse_memory_command,
        )
        from agent.runtime.memory_write.consolidator import (
            consolidate_experiences,
            should_consolidate,
        )
        from agent.runtime.memory_write.event_log import (
            append_experience,
            mark_experiences_processed,
            pending_experiences,
        )
        from storage.memory_governance import is_auto_memory_enabled

        install_memory_governance_hooks()
        command = parse_memory_command(user_input)
        if command is not None and not is_auto_memory_enabled(workspace_id):
            apply_memory_command(command, workspace_id=workspace_id, session_id=session_id, task_id=task_id)
            return
        if not is_auto_memory_enabled(workspace_id):
            return
        event = append_experience(
            workspace_id=workspace_id,
            session_id=session_id,
            task_id=task_id,
            user_input=user_input,
            assistant_response=assistant_response,
            tool_calls=tool_calls,
            task_ok=task_ok,
        )
        if command is not None:
            apply_memory_command(
                command,
                workspace_id=workspace_id,
                session_id=session_id,
                task_id=task_id,
            )
            mark_experiences_processed(
                workspace_id, session_id, [str(event.get("event_id") or "")]
            )
            return
        pending = pending_experiences(workspace_id, session_id, limit=12)
        if should_consolidate(pending):
            from storage.principal import bind_storage_principal

            future = _MEMORY_WRITE_EXECUTOR.submit(
                bind_storage_principal(consolidate_experiences),
                workspace_id=workspace_id,
                session_id=session_id,
                task_id=task_id,
            )
            future.add_done_callback(_log_memory_reflection_failure)
    except Exception:
        _LOG.warning("experience journal write failed", exc_info=True)


def _log_memory_reflection_failure(done: concurrent.futures.Future) -> None:
    try:
        done.result()
    except Exception:
        _LOG.warning("background memory reflection failed", exc_info=True)
