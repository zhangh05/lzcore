"""Durable loop protocol envelopes and complete redacted evidence projections."""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass, field
from typing import Any

from agent.llm.schemas import LLMMessage
from core.tools.redaction import redact_tool_output

from .prompt_contract import RUNTIME_SYSTEM_PROMPT

SYNTHESIS_CHECKPOINT_MARKER = "[SYNTHESIS_CHECKPOINT]"
FINAL_SYNTHESIS_CHECKPOINT_MARKER = "[FINAL_SYNTHESIS_CHECKPOINT]"
QUERY_LOOP_SYSTEM_PROMPT = RUNTIME_SYSTEM_PROMPT


@dataclass
class StreamingToolResult:
    tool_name: str
    call_id: str
    output: dict
    ok: bool
    error: str | None = None
    latency_ms: float = 0.0
    error_code: str = ""
    execution_may_continue: bool = False
    summary: str = ""


@dataclass
class QueryLoopResult:
    final_response: str
    tool_results: list[StreamingToolResult] = field(default_factory=list)
    iterations: int = 0
    total_tool_calls: int = 0
    llm_calls: int = 0
    error: str | None = None
    errors: list[str] = field(default_factory=list)
    risk_level: str = "low"
    hard_block: bool = False
    metrics: dict[str, Any] = field(default_factory=dict)


def serialize_loop_message(message: LLMMessage) -> dict[str, Any]:
    """Losslessly project an LLM message for a durable external pause.

    Approval is allowed to release the active request/LLM connection, but it
    must never turn the next model turn into a new, contextless conversation.
    This is deliberately not a prompt summary or a bounded preview.
    """
    return {
        "role": message.role,
        "content": message.content,
        "tool_call_id": message.tool_call_id,
        "tool_calls": message.tool_calls,
        "protocol": copy.deepcopy(message.protocol),
    }


def deserialize_loop_message(value: dict[str, Any]) -> LLMMessage:
    return LLMMessage(
        role=str(value.get("role") or "user"),
        content=value.get("content")
        if isinstance(value.get("content"), list)
        else str(value.get("content") or ""),
        tool_call_id=str(value.get("tool_call_id") or "") or None,
        tool_calls=(list(value["tool_calls"]) if value.get("tool_calls") is not None else None),
        protocol=copy.deepcopy(value.get("protocol") or {}),
    )


def serialize_streaming_tool_result(result: StreamingToolResult) -> dict[str, Any]:
    return {
        "tool_name": result.tool_name,
        "call_id": result.call_id,
        "output": result.output,
        "ok": result.ok,
        "error": result.error,
        "latency_ms": result.latency_ms,
        "error_code": result.error_code,
        "execution_may_continue": result.execution_may_continue,
        "summary": result.summary,
    }


def deserialize_streaming_tool_result(value: dict[str, Any]) -> StreamingToolResult:
    return StreamingToolResult(
        tool_name=str(value.get("tool_name") or ""),
        call_id=str(value.get("call_id") or ""),
        output=dict(value.get("output") or {}),
        ok=bool(value.get("ok")),
        error=str(value.get("error") or "") or None,
        latency_ms=float(value.get("latency_ms") or 0),
        error_code=str(value.get("error_code") or ""),
        execution_may_continue=bool(value.get("execution_may_continue")),
        summary=str(value.get("summary") or ""),
    )


def _redact_tool_error(error: Any) -> str:
    """Return complete, redacted tool or orchestration error text for model context."""
    value = redact_tool_output({"error": str(error or "")}).get("error")
    return str(value or "tool execution failed")


def _json_compact(value: Any, **_: Any) -> str:
    """Serialize the complete model-visible payload without truncation."""
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=False,
        separators=(",", ":"),
        default=str,
    )


def _model_tool_payload(result: Any) -> dict[str, Any]:
    """Return the complete tool result for the next model turn."""
    payload = redact_tool_output(dict(result.output or {}))
    payload.pop("_evidence_projection", None)
    payload.pop("_evidence_content_digest", None)
    if result.error:
        payload["ok"] = False
        errors = list(payload.get("errors") or [])
        error = _redact_tool_error(result.error)
        if error not in errors:
            errors.append(error)
        payload["errors"] = errors
    return payload
