"""SSOT tools boundary; public orchestration remains in ssot_runtime."""

from __future__ import annotations

import asyncio
from typing import Any


def _make_tool_handler(
    *,
    client,
    tool_id: str,
    workspace_id: str,
    session_id: str,
    run_id: str,
    trace_id: str,
    requested_by: str,
    task_id: str = "",
    skill_id: str = "",
    skill_connection_ids: tuple[str, ...] = (),
):
    async def _handler(args: dict[str, Any]) -> dict[str, Any]:
        from core.tools.context import ToolRuntimeContext, get_runtime_cancel_check

        args = client.canonicalize_arguments(tool_id, dict(args or {}))
        ctx = ToolRuntimeContext(
            workspace_id=workspace_id,
            session_id=session_id,
            run_id=run_id,
            task_id=task_id,
            trace_id=trace_id,
            requested_by=requested_by,
            skill=skill_id or None,
            skill_connection_ids=skill_connection_ids,
            module="ssot_runtime",
            cancel_check=get_runtime_cancel_check(),
        )
        result = await asyncio.to_thread(client.invoke, tool_id, args, context=ctx)
        payload = dict(result.output or {})
        payload.setdefault("status", result.status)
        payload.setdefault("ok", result.status in ("succeeded", "dry_run"))
        payload.setdefault("summary", result.summary or "")
        payload.setdefault("artifact_ids", list(result.artifact_ids or []))
        payload.setdefault("warnings", list(result.warnings or []))
        payload.setdefault("errors", list(result.errors or []))
        payload.setdefault("duration_ms", result.duration_ms)
        payload.setdefault("redacted", bool(result.redacted))
        return payload

    return _handler
