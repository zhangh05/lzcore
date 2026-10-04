"""Project an execution transcript without rewriting native provider evidence.

The provider's original proposal remains in message.protocol for durable audit.
message.tool_calls, when present (including []), is the runtime's authoritative
interaction contract after validation, compilation or suppression. Native
reasoning blocks and signatures are opaque and remain unchanged.
"""

from __future__ import annotations

from typing import Callable
import hashlib
import json


def anthropic_assistant_blocks(message, protocol: dict, tool_block: Callable) -> list[dict]:
    original = protocol.get("anthropic") or []
    if message.tool_calls is None:
        return [dict(block) for block in original]

    calls = [tool_block(call) for call in message.tool_calls]
    projected: list[dict] = []
    inserted = False
    for block in original:
        if block.get("type") == "tool_use":
            if not inserted:
                projected.extend(calls)
                inserted = True
            continue
        projected.append(dict(block))
    if not inserted:
        projected.extend(calls)
    return projected


def openai_assistant_state(message, protocol: dict) -> dict:
    projected = dict(protocol.get("openai") or {})
    if message.tool_calls is not None:
        # Explicitly empty means a rejected proposal, never an outstanding
        # tool invocation. The original native state is still archived.
        projected.pop("tool_calls", None)
        if message.tool_calls:
            projected["tool_calls"] = message.tool_calls
    return projected


def anthropic_request_structure(body: dict) -> dict:
    """Content-free failure diagnostics; never export prompts or reasoning."""
    encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    pending: set[str] = set()
    seen: set[str] = set()
    violations: dict[str, int] = {}
    counts: dict[str, int] = {}
    def flag(name):
        violations[name] = violations.get(name, 0) + 1
    for message in body.get("messages") or []:
        if message.get("role") == "assistant" and pending:
            flag("assistant_before_results")
        for block in message.get("content") or []:
            kind = str(block.get("type") or "unknown")
            if kind not in {"text", "thinking", "redacted_thinking", "tool_use", "tool_result", "image"}:
                kind = "unknown"
            counts[kind] = counts.get(kind, 0) + 1
            if kind == "tool_use":
                call_id = str(block.get("id") or "")
                if not call_id:
                    flag("missing_call_id")
                if call_id in seen:
                    flag("duplicate_call_id")
                seen.add(call_id)
                pending.add(call_id)
                if not isinstance(block.get("input"), dict):
                    flag("non_object_tool_input")
            elif kind == "tool_result":
                call_id = str(block.get("tool_use_id") or "")
                if call_id not in pending:
                    flag("unmatched_tool_result")
                pending.discard(call_id)
            elif kind == "text" and not str(block.get("text") or ""):
                flag("empty_text_block")
        if message.get("role") == "user" and pending:
            flag("user_before_all_results")
    if pending:
        violations["unanswered_calls"] = len(pending)
    return {"schema": "provider.request_structure.v1", "sha256": hashlib.sha256(encoded).hexdigest(),
            "bytes": len(encoded), "messages": len(body.get("messages") or []),
            "blocks": counts, "violations": violations}
