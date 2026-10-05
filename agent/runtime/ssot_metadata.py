"""SSOT metadata boundary; public orchestration remains in ssot_runtime."""

from __future__ import annotations

from typing import Any

_CALLER_RESERVED_RUNTIME_METADATA_KEYS = frozenset(
    {
        "cognitive_state",
        "conversation_history_block",
        "operational_clarification",
        "retrieved_context_block",
        "task_continuation_contract",
        "task_state_contract",
        "trusted_prompt_items",
        # Subagent controls become system-prompt text and tool-registry limits.
        # They are accepted only from SubagentRuntimeControl below.
        "subagent_profile",
        "max_steps",
        "max_tool_nodes",
        "subtask_id",
        "parent_session_id",
        "workbench_context",
        "approval_continuation_resume",
        "cancel_check",
        "completion_check",
        "completion_source_digest",
    }
)


def _sanitize_caller_runtime_metadata(metadata: Any) -> dict[str, Any]:
    """Keep caller metadata data-only before it enters the SSOT control plane."""
    if not isinstance(metadata, dict):
        return {}
    sanitized = {
        str(key): value
        for key, value in metadata.items()
        if isinstance(key, str)
        and not key.startswith("__")
        and key not in _CALLER_RESERVED_RUNTIME_METADATA_KEYS
    }
    raw_wb = metadata.get("workbench_context")
    if (
        isinstance(raw_wb, dict)
        and raw_wb.get("source") == "server_validated_extension_context"
    ):
        sanitized["workbench_context"] = dict(raw_wb)
    return sanitized


def _apply_runtime_control(metadata: dict[str, Any], runtime_control: Any) -> None:
    """Install only typed, server-created runtime control envelopes."""
    from core.runtime_engine.models import (
        ApprovalContinuationRuntimeControl,
        MainAgentRuntimeControl,
        SubagentRuntimeControl,
    )

    if isinstance(runtime_control, MainAgentRuntimeControl):
        if callable(runtime_control.cancel_check):
            metadata["cancel_check"] = runtime_control.cancel_check
        if (
            isinstance(runtime_control.workbench_context, dict)
            and runtime_control.workbench_context
        ):
            metadata["workbench_context"] = dict(runtime_control.workbench_context)
        return
    if isinstance(runtime_control, ApprovalContinuationRuntimeControl):
        metadata["approval_continuation_resume"] = dict(
            runtime_control.checkpoint or {}
        )
        if runtime_control.workbench_context:
            metadata["workbench_context"] = dict(runtime_control.workbench_context)
        return
    if not isinstance(runtime_control, SubagentRuntimeControl):
        return
    profile = (
        runtime_control.profile if isinstance(runtime_control.profile, dict) else {}
    )
    metadata.update(
        {
            "subagent_profile": dict(profile),
            "max_steps": max(0, int(runtime_control.max_steps or 0)),
            "max_tool_nodes": max(0, int(runtime_control.max_tool_nodes or 0)),
            "subtask_id": str(runtime_control.subtask_id or ""),
            "parent_session_id": str(runtime_control.parent_session_id or ""),
        }
    )
    if (
        isinstance(runtime_control.workbench_context, dict)
        and runtime_control.workbench_context
    ):
        metadata["workbench_context"] = dict(runtime_control.workbench_context)
    if callable(runtime_control.cancel_check):
        metadata["cancel_check"] = runtime_control.cancel_check
    if callable(runtime_control.completion_check):
        metadata["__completion_check"] = runtime_control.completion_check

    if callable(runtime_control.completion_source_digest):
        metadata["__completion_source_digest"] = runtime_control.completion_source_digest
