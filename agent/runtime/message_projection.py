"""Bounded display facts for persisted assistant messages, separate from audit."""

import math
import re
from itertools import islice

from storage.redaction import MASK, is_sensitive_field, redact_text


MAX_TOOL_CALLS = 64
MAX_DISPLAY_TEXT = 48_000
MAX_DISPLAY_NODES = 3_000
_OMIT = object()
_RAW_FIELDS = frozenset({
    "arguments", "params", "parameters", "output", "raw_output", "stdout", "stderr",
    "source_config", "raw_config", "config", "configuration", "headers",
})


def _text(value: str, limit: int) -> str:
    # Redact before clipping: a boundary must never expose half a credential.
    value = re.sub(r"-----BEGIN [^-]*PRIVATE KEY-----.*?(?:-----END [^-]*PRIVATE KEY-----|$)",
                   MASK, value, flags=re.DOTALL)
    safe = redact_text(value)
    return safe if len(safe) <= limit else safe[:limit] + "…"


class _DisplayBudget:
    def __init__(self):
        self.text = MAX_DISPLAY_TEXT
        self.nodes = MAX_DISPLAY_NODES

    def project(self, value, depth=6):
        if depth < 0 or self.nodes <= 0:
            return _OMIT
        self.nodes -= 1
        if value is None or isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value if math.isfinite(value) else _OMIT
        if isinstance(value, str):
            if self.text <= 0:
                return _OMIT
            safe = _text(value, min(1024, self.text))
            self.text -= len(safe)
            return safe
        if isinstance(value, dict):
            out = {}
            for key, item in islice(value.items(), 32):
                if (not isinstance(key, str) or len(key) > 80
                        or is_sensitive_field(key) or key.lower() in _RAW_FIELDS):
                    continue
                projected = self.project(item, depth - 1)
                if projected is not _OMIT:
                    out[key] = projected
            return out
        if isinstance(value, (list, tuple)):
            out = []
            for item in value[:32]:
                projected = self.project(item, depth - 1)
                if projected is not _OMIT:
                    out.append(projected)
            return out
        return _OMIT


def _card_result(raw: dict, depth: int = 1) -> dict:
    """Keep the shared extension presentation envelope and subtask facts.

    Extensions own their presentation objects; raw execution output and tool
    arguments never become chat display data. Approval cards only need an ID.
    """
    out = {key: raw[key] for key in (
        "ok", "status", "execution_may_continue",
        "subtask_id", "task_status", "observation_revision", "profile_id",
        "instruction", "goal", "started_at", "created_at", "finished_at",
        "content_complete", "approval_operation_id",
    ) if key in raw}
    for key, fields in (
        ("approval", ("operation_id",)),
        ("tracking", ("domain", "task_id", "status", "observation_token", "auto_polling")),
        ("progress", ("state", "event", "model_responses", "tool_results", "completion_status", "tool", "action")),
    ):
        if isinstance(raw.get(key), dict):
            out[key] = {field: raw[key][field] for field in fields if field in raw[key]}
    if isinstance(raw.get("presentation"), dict):
        out["presentation"] = raw["presentation"]
    observations = raw.get("observations")
    if isinstance(observations, list) and depth > 0:
        out["observations"] = [
            {"result": _card_result(item["result"], depth - 1)}
            for item in observations[:32]
            if isinstance(item, dict) and isinstance(item.get("result"), dict)
        ]
    elif isinstance(observations, dict) and "execution_outcome" in observations:
        out["observations"] = {"execution_outcome": observations["execution_outcome"]}
    return out


def message_display_metadata(result, artifact_refs: list) -> dict:
    if result is None:
        return {}
    metadata = getattr(result, "metadata", None) or {}
    out = {}
    for key in ("execution_outcome", "tool_execution_outcome", "task_id", "operation_id"):
        if isinstance(metadata.get(key), str) and metadata[key]:
            out[key] = _text(metadata[key], 256)
    task = metadata.get("task_state")
    if isinstance(task, dict) and task.get("task_id"):
        out["task_id"] = _text(str(task["task_id"]), 256)
    unknown = metadata.get("unknown_outcome")
    if isinstance(unknown, dict) and unknown:
        fact = {
            key: _text(value, 256) if isinstance(value, str) else value
            for key in ("tool_id", "call_id", "error_code", "execution_may_continue", "status")
            if isinstance((value := unknown.get(key)), (str, bool))
        }
        if fact:
            out["unknown_outcome"] = fact
    elif "unknown_outcome" in metadata and unknown is None:
        out["unknown_outcome"] = None
    if isinstance(metadata.get("cancelled"), bool):
        out["cancelled"] = metadata["cancelled"]
    if "cancelled_by_user" in (getattr(result, "errors", None) or []):
        out["cancelled"] = True

    calls = list(getattr(result, "tool_calls", None) or [])
    budget = _DisplayBudget()
    out["tool_calls"] = []
    for call in calls[:MAX_TOOL_CALLS]:
        if not isinstance(call, dict):
            continue
        item = {key: _text(str(call[key]), 256) for key in ("tool_id", "call_id") if key in call}
        if isinstance(call.get("ok"), bool):
            item["ok"] = call["ok"]
        if isinstance(call.get("status"), str):
            item["status"] = _text(call["status"], 64)
        if isinstance(call.get("summary"), str):
            item["summary"] = _text(call["summary"], 512)
        duration = call.get("duration_ms")
        if isinstance(duration, (int, float)) and not isinstance(duration, bool) and 0 <= duration < math.inf:
            item["duration_ms"] = duration
        if isinstance(call.get("result"), dict):
            projected = budget.project(_card_result(call["result"]))
            if projected is not _OMIT and projected:
                item["result"] = projected
        out["tool_calls"].append(item)
    if len(calls) > MAX_TOOL_CALLS:
        out["tool_calls_truncated"] = len(calls) - MAX_TOOL_CALLS
    out["output_artifacts"] = list(dict.fromkeys(
        _text(str(ref["artifact_id"]), 256) for ref in artifact_refs if ref.get("artifact_id")
    ))[:64]
    return out
