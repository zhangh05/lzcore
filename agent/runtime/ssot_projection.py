"""SSOT projection boundary; public orchestration remains in ssot_runtime."""

from __future__ import annotations

import time
from typing import Any


def _final_response(runtime_result) -> str:
    text = str(getattr(runtime_result, "final_response", "") or "").strip()

    if text:
        from agent.llm.runtime import sanitize_provider_output

        text, _ = sanitize_provider_output(text)
        text = text.strip()

    # QueryLoop owns finalization. The transport adapter must not discard a
    # valid answer based on phrases such as "已完成。" inside a full report.
    if text:
        return text
    # No tool results and no text — return empty so caller can fall back.
    return ""


def _tool_result_fallback_from_projected_calls(tool_calls: list[dict[str, Any]]) -> str:
    """Build a useful user-facing fallback from projected tool-call results."""
    if not tool_calls:
        return ""

    ok_count = sum(1 for call in tool_calls if call.get("ok"))
    fail_count = len(tool_calls) - ok_count
    lines = [
        f"工具结果已返回：成功 {ok_count} 个"
        + (f"，失败 {fail_count} 个" if fail_count else "")
    ]

    for call in tool_calls:
        tool_id = str(call.get("tool_id") or "tool")
        status = "✅" if call.get("ok") else "❌"
        summary = str(call.get("summary") or "").strip()
        result = call.get("result") if isinstance(call.get("result"), dict) else {}
        lines.append(f"\n### {status} {tool_id}")
        if summary and summary not in {"Tool completed", "Tool failed"}:
            lines.append(summary)
        command = result.get("command") or result.get("description")
        if command:
            lines.append(f"> `{str(command)}`")
        if result.get("exit_code") is not None:
            lines.append(f"Exit: exit_code={result.get('exit_code')}")
        stdout = str(result.get("stdout") or "").strip()
        stderr = str(result.get("stderr") or "").strip()
        if stdout:
            lines.append(f"```\n{stdout}\n```")
        if stderr:
            lines.append(f"```\n{stderr}\n```")
        artifacts = (
            call.get("artifacts") if isinstance(call.get("artifacts"), list) else []
        )
        if artifacts:
            ids = [
                str(item.get("artifact_id") or item.get("title") or "").strip()
                for item in artifacts
                if isinstance(item, dict)
            ]
            ids = [value for value in ids if value]
            if ids:
                lines.append("产物：" + "、".join(ids))

    return "\n".join(lines).strip()


def _project_tool_calls(runtime_result) -> list[dict[str, Any]]:
    calls = []
    for node_id, tr in (runtime_result.node_results or {}).items():
        data = tr.data if isinstance(tr.data, dict) else {"value": tr.data}
        raw_ids = list(data.get("artifact_ids") or [])
        # Normalise artifacts: frontend expects objects, not plain strings.
        artifacts: list[dict[str, str]] = []
        for aid in raw_ids:
            if isinstance(aid, dict):
                artifacts.append(
                    {
                        "artifact_id": str(aid.get("artifact_id", aid.get("id", ""))),
                        "artifact_type": str(
                            aid.get("artifact_type", aid.get("type", ""))
                        ),
                        "title": str(aid.get("title", aid.get("name", ""))),
                    }
                )
            elif isinstance(aid, str):
                artifacts.append(
                    {
                        "artifact_id": aid,
                        "artifact_type": "",
                        "title": aid,
                    }
                )

        calls.append(
            {
                "call_id": node_id,
                "tool_id": tr.tool,
                "ok": bool(tr.success),
                "status": "succeeded" if tr.success else "failed",
                "summary": _tool_summary(data, tr),
                "result": data.get("output", data),
                "duration_ms": tr.latency_ms,
                "errors": list(data.get("errors") or ([tr.error] if tr.error else [])),
                "warnings": list(data.get("warnings") or []),
                "artifacts": artifacts,
                "metadata": {
                    "runtime_engine": "ssot_runtime",
                    "node_id": node_id,
                    "duration_ms": tr.latency_ms,
                    "redacted": bool(data.get("redacted", True)),
                    "orchestration": dict(data.get("_orchestration") or {}),
                },
            }
        )
    return calls


def _tool_summary(data: dict[str, Any], tr) -> str:
    for key in ("summary", "message", "error"):
        value = data.get(key)
        if value:
            return str(value)[:500]
    if tr.error:
        return str(tr.error)[:500]
    return "Tool completed" if tr.success else "Tool failed"


def _project_events(
    runtime_result, trace_id: str, turn_id: str
) -> list[dict[str, Any]]:
    events = []
    for batch_index, batch in enumerate(
        (runtime_result.metadata or {}).get("orchestration_batches") or []
    ):
        if not isinstance(batch, dict):
            continue
        parallel_steps_by_layer = list(batch.get("parallel_steps") or [])
        for layer_index, steps in enumerate(batch.get("layers") or [], start=1):
            parallel_steps = (
                parallel_steps_by_layer[layer_index - 1]
                if layer_index <= len(parallel_steps_by_layer)
                and isinstance(parallel_steps_by_layer[layer_index - 1], list)
                else []
            )
            events.append(
                {
                    "event_id": f"orchestration-{turn_id}-{batch_index}-{layer_index}",
                    "event_type": "orchestration_layer_completed",
                    "type": "orchestration_layer_completed",
                    "name": "协同步骤执行完成",
                    "trace_id": trace_id,
                    "run_id": turn_id,
                    "timestamp": time.time(),
                    "status": "completed",
                    "summary": f"第 {layer_index} 组：{len(list(steps or []))} 个步骤",
                    "metadata": {
                        "batch": batch_index + 1,
                        "layer": layer_index,
                        "steps": list(steps or []),
                        "parallel": len(parallel_steps) > 1,
                        "parallel_steps": list(parallel_steps),
                    },
                }
            )
    for node_id, tr in (runtime_result.node_results or {}).items():
        events.append(
            {
                "event_id": f"tool-start-{turn_id}-{node_id}",
                "event_type": "tool_call",
                "type": "tool_call",
                "name": "tool_call",
                "tool_id": tr.tool,
                "node_id": node_id,
                "call_id": node_id,
                "trace_id": trace_id,
                "run_id": turn_id,
                "timestamp": time.time(),
                "status": "started",
            }
        )
        events.append(
            {
                "event_id": f"tool-result-{turn_id}-{node_id}",
                "event_type": "tool_result",
                "type": "tool_result",
                "name": "tool_result",
                "tool_id": tr.tool,
                "node_id": node_id,
                "call_id": node_id,
                "trace_id": trace_id,
                "run_id": turn_id,
                "timestamp": time.time(),
                "status": "success" if tr.success else "failed",
                "ok": bool(tr.success),
                "summary": _tool_summary(
                    tr.data if isinstance(tr.data, dict) else {}, tr
                ),
                "duration_ms": tr.latency_ms,
                "metadata": {
                    "orchestration": dict(
                        (tr.data if isinstance(tr.data, dict) else {}).get(
                            "_orchestration"
                        )
                        or {}
                    )
                },
            }
        )
    for idx, ev in enumerate((runtime_result.metadata or {}).get("retry_events") or []):
        if not isinstance(ev, dict):
            continue
        events.append(
            {
                "event_id": f"retry-{turn_id}-{idx}",
                "event_type": "tool_retry",
                "type": "tool_retry",
                "name": "工具自动重试",
                "status": ev.get("final_status")
                or ("succeeded" if ev.get("retry_allowed") else "blocked"),
                "summary": _retry_event_summary(ev),
                "tool_id": ev.get("tool_id", ""),
                "node_id": ev.get("node_id", ""),
                "trace_id": trace_id,
                "run_id": turn_id,
                "timestamp": time.time(),
                "duration_ms": ev.get("duration_ms", 0),
                "metadata": ev,
            }
        )
    return events


def _retry_event_summary(ev: dict[str, Any]) -> str:
    tool_id = str(ev.get("tool_id") or ev.get("node_id") or "tool")
    reason = str(ev.get("reason") or ev.get("error_code") or "")
    if ev.get("retry_allowed"):
        if str(ev.get("final_status") or "") == "succeeded":
            return f"{tool_id} 首次失败后已自动重试并恢复"
        return f"{tool_id} 已按策略重试，但仍未完成"
    if ev.get("blocked_by_policy"):
        if (
            reason == "non_idempotent"
            or "side_effect_not_retryable" in reason
            or reason == "execute_command_not_retryable"
        ):
            return f"{tool_id} 未原样重放，以避免重复副作用；模型可改用其他策略"
        return f"{tool_id} 未自动重试：{reason or '策略禁止重试'}"
    return f"{tool_id} 未触发重试：{reason or '不满足重试条件'}"


def _event(
    event_type: str, name: str, trace_id: str, turn_id: str, *, started_at: float
) -> dict[str, Any]:
    return {
        "type": event_type,
        "name": name,
        "trace_id": trace_id,
        "run_id": turn_id,
        "timestamp": time.time(),
        "duration_ms": int((time.monotonic() - started_at) * 1000),
    }


def _timeline_summary(
    *, started: float, events: list, tool_calls: list, runtime_result
) -> dict[str, Any]:
    runtime_metadata = runtime_result.metadata or {}
    return {
        "node_count": max(len(events), 1),
        "total_duration_ms": int((time.monotonic() - started) * 1000),
        "artifact_saved_count": sum(len(c.get("artifacts") or []) for c in tool_calls),
        "execution_duration_ms": int(
            getattr(runtime_result, "execution_latency_ms", 0) or 0
        ),
        "llm_calls": int(runtime_metadata.get("llm_calls", 0) or 0),
        "llm_usage": dict(runtime_metadata.get("llm_usage") or {}),
        "tool_calls": len(tool_calls),
        "max_parallel_width": int(
            runtime_metadata.get("metrics", {}).get("max_parallel_width", 0) or 0
        ),
    }


def _tool_decision(runtime_result, tool_calls: list) -> dict[str, Any]:
    if not tool_calls:
        return {
            "needed": False,
            "reason": "SSOT Runtime planner selected no tools.",
            "selected_tools": [],
        }
    return {
        "needed": True,
        "reason": "SSOT Runtime execution graph selected tool nodes.",
        "selected_tools": [c["tool_id"] for c in tool_calls],
        "tool_count": len(tool_calls),
    }
