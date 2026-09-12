"""One-pass, task-level memory reflection and consolidation."""

from __future__ import annotations

import json
import hashlib
import logging
import threading
from typing import Any

from storage.redaction import redact_text

_log = logging.getLogger(__name__)
_LOCK_GUARD = threading.Lock()
_REFLECTION_LOCKS: dict[tuple[str, str], threading.Lock] = {}

VALID_TYPES = {"core_rule", "semantic_fact", "episodic_case", "procedural_rule"}


def consolidate_experiences(
    *,
    workspace_id: str,
    session_id: str,
    task_id: str,
) -> dict[str, Any]:
    key = (workspace_id, session_id)
    with _LOCK_GUARD:
        lock = _REFLECTION_LOCKS.setdefault(key, threading.Lock())
    with lock:
        return _consolidate_locked(
            workspace_id=workspace_id,
            session_id=session_id,
            task_id=task_id,
        )


def _consolidate_locked(
    *,
    workspace_id: str,
    session_id: str,
    task_id: str,
) -> dict[str, Any]:
    from agent.runtime.memory_write.event_log import mark_experiences_processed, pending_experiences
    from storage.memory_event_store import read_cursor
    from storage.memory_governance import MemoryStore, is_auto_memory_enabled

    if not is_auto_memory_enabled(workspace_id):
        return {"ok": True, "status": "disabled", "processed": 0}
    events = pending_experiences(workspace_id, session_id, limit=12)
    if not events:
        return {"ok": True, "status": "empty", "processed": 0}

    event_ids = [str(row.get("event_id") or "") for row in events]
    batch_id = _batch_id(event_ids)
    cursor = read_cursor(workspace_id, session_id)
    batches = dict(cursor.get("consolidation_batches") or {})
    batch = batches.get(batch_id)
    store = MemoryStore()

    # Reflection is run once for this exact event set.  Persisting the parsed
    # proposals makes retry a continuation of the same operation, not a new
    # LLM generation with freshly invented memory ids or wording.
    if not isinstance(batch, dict):
        query = " ".join(str(row.get("user_input") or "") for row in events)
        existing = [row for row in store.search(workspace_id, query, limit=12) if row.get("status") == "active"]
        proposals = _reflect(events, existing)
        if proposals is None:
            return {"ok": False, "status": "retry_pending", "processed": 0}
        proposals = [_with_proposal_id(item, batch_id) for item in proposals]
        batch = {
            "event_ids": event_ids,
            "task_id": task_id,
            "proposals": proposals,
            "results": {},
        }
        batches[batch_id] = batch
        _save_batches(cursor, batches, workspace_id, session_id)
    else:
        proposals = list(batch.get("proposals") or [])
        # Older interrupted cursors are upgraded deterministically.
        proposals = [_with_proposal_id(item, batch_id) for item in proposals if isinstance(item, dict)]
        batch["proposals"] = proposals
        batch.setdefault("results", {})

    results_by_id = dict(batch.get("results") or {})
    results: list[dict[str, Any]] = []
    for proposal in proposals:
        proposal_id = str(proposal["proposal_id"])
        previous = results_by_id.get(proposal_id)
        if isinstance(previous, dict) and previous.get("ok"):
            results.append(previous)
            continue
        result = _apply(proposal, workspace_id, session_id, task_id, events, store)
        result = {**dict(result or {}), "proposal_id": proposal_id}
        results_by_id[proposal_id] = result
        batch["results"] = results_by_id
        # Commit each outcome before moving to the next proposal.  A crash can
        # now resume from the exact failing item rather than replay successes.
        batches[batch_id] = batch
        _save_batches(cursor, batches, workspace_id, session_id)
        results.append(result)

    if any(not result.get("ok") for result in results):
        return {"ok": False, "status": "retry_pending", "processed": 0, "results": results}

    batches.pop(batch_id, None)
    _save_batches(cursor, batches, workspace_id, session_id)
    mark_experiences_processed(workspace_id, session_id, event_ids)
    return {"ok": True, "status": "processed", "processed": len(events), "results": results}


def _batch_id(event_ids: list[str]) -> str:
    payload = json.dumps(event_ids, ensure_ascii=False, separators=(",", ":"))
    return "batch-" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def _with_proposal_id(proposal: dict[str, Any], batch_id: str) -> dict[str, Any]:
    item = dict(proposal)
    identity = {key: value for key, value in item.items() if key != "proposal_id"}
    digest = hashlib.sha256(
        (batch_id + "\n" + json.dumps(identity, ensure_ascii=False, sort_keys=True, default=str)).encode("utf-8")
    ).hexdigest()
    item["proposal_id"] = f"proposal-{digest[:24]}"
    return item


def _save_batches(cursor: dict[str, Any], batches: dict[str, Any], workspace_id: str, session_id: str) -> None:
    updated = dict(cursor)
    updated["consolidation_batches"] = batches
    updated["session_id"] = session_id
    from storage.time_utils import now_iso

    updated["updated_at"] = now_iso()
    cursor.clear()
    cursor.update(updated)
    from storage.memory_event_store import save_cursor

    save_cursor(workspace_id, session_id, updated)


def should_consolidate(events: list[dict[str, Any]]) -> bool:
    """Reflect at a completed operational task or after four accumulated turns."""
    if len(events) >= 4:
        return True
    latest = events[-1] if events else {}
    return bool(latest.get("tool_calls"))


def _reflect(events: list[dict[str, Any]], existing: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    try:
        from agent.llm.runtime import invoke_llm
        from agent.llm.schemas import LLMMessage
        from prompts.loader import render_prompt

        system = render_prompt("memory_consolidation", {}, "").text
        payload = {
            "experiences": [_safe_event(row) for row in events],
            "existing_memories": [_safe_existing(row) for row in existing],
        }
        response = invoke_llm(
            task="memory_consolidation",
            messages=[
                LLMMessage(role="system", content=system),
                LLMMessage(role="user", content=json.dumps(payload, ensure_ascii=False)),
            ],
            # Use the configured provider output capacity, not a hidden
            # memory-specific ceiling lower than the main agent's capacity.
            config_override={"temperature": 0.0},
            extra={
                "stream_to_user": False,
                "stream_scope": "internal",
                "request_metadata": {
                    "memory_stage": "task_reflection",
                    "event_count": len(events),
                },
            },
        )
        if response.error:
            _log.warning("memory consolidation failed: %s", response.error)
            return None
        if response.finish_reason in {"length", "max_tokens"}:
            _log.warning("memory consolidation response incomplete; experience remains pending")
            return None
        return _parse_operations(response.content or "")
    except Exception:
        _log.warning("memory consolidation error", exc_info=True)
        return None


def _apply(proposal, workspace_id, session_id, task_id, events, store):
    from storage.memory_governance import MemoryRecord, MemoryWriteGate, expire_memory

    action = proposal["action"]
    target = str(proposal.get("target_memory_id") or "")
    if action == "ignore":
        return {"ok": True, "status": "ignored"}
    if action == "expire" and target:
        return expire_memory(workspace_id, target)

    evidence_ids = set(proposal.get("evidence_event_ids") or [])
    evidence_events = [row for row in events if row.get("event_id") in evidence_ids]
    has_verified_tool = any(call.get("ok") for row in evidence_events for call in row.get("tool_calls") or [])
    memory_type = proposal["memory_type"]
    authority = "verified_tool" if has_verified_tool else "agent_inference"
    authority_rank = 70 if has_verified_tool else 30
    status = "active" if has_verified_tool and proposal["score"] >= 4 else "pending"
    proposal_id = str(proposal.get("proposal_id") or "")
    record_kwargs = {}
    if proposal_id:
        # Stable record identity makes an interrupted create idempotent even
        # in the narrow window between writing the record and saving cursor.
        record_kwargs["memory_id"] = "mem-" + proposal_id.removeprefix("proposal-")[:12]
    record = MemoryRecord(
        **record_kwargs,
        workspace_id=workspace_id,
        session_id=session_id,
        task_id=task_id,
        scope=proposal.get("scope", "workspace"),
        memory_type=memory_type,
        status=status,
        source="agent_suggestion",
        source_ref=target,
        content=proposal["content"],
        summary=proposal["summary"],
        confidence=proposal["confidence"],
        citations=[{"event_id": item} for item in evidence_ids],
        created_by="memory_consolidator",
        metadata={
            "memory_key": proposal.get("memory_key"),
            "authority": authority,
            "authority_rank": authority_rank,
            "llm_score": proposal["score"],
            "llm_keep": proposal["score"] >= 3,
            "llm_summary": proposal["summary"],
            "extraction_reason": proposal.get("reason"),
            "evidence_source": "experience_journal",
            "evidence_event_ids": list(evidence_ids),
            "consolidation_origin": "task_reflection",
            "generation_origin": "task_reflection",
            "consolidation_proposal_id": proposal_id,
            "supersedes_memory_id": target if action == "supersede" else "",
        },
    )
    result = MemoryWriteGate(store).write(record)
    if result.get("ok") and result.get("status") == "active" and action == "supersede" and target:
        old = store.get(workspace_id, target)
        if old and old.status == "active":
            old.status = "expired"
            old.metadata["superseded_by"] = result.get("memory_id")
            store._save(old)
    return result


def _parse_operations(raw: str) -> list[dict[str, Any]] | None:
    from agent.llm.runtime import sanitize_provider_output

    text, _ = sanitize_provider_output(str(raw or ""))
    text = text.strip()
    if text.startswith("```"):
        lines = text.splitlines()[1:]
        if lines and lines[-1].strip() == "```":
            lines.pop()
        text = "\n".join(lines)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("["), text.rfind("]")
        if start < 0 or end <= start:
            return None
        try:
            data = json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            return None
    result = []
    for item in data if isinstance(data, list) else []:
        if not isinstance(item, dict):
            continue
        action = str(item.get("action") or "ignore").lower()
        memory_type = str(item.get("memory_type") or "")
        content = str(item.get("content") or "").strip()
        if action not in {"create", "supersede", "expire", "ignore"}:
            continue
        if action not in {"expire", "ignore"} and (memory_type not in VALID_TYPES or not content):
            continue
        try:
            score = max(1, min(int(item.get("score", 1)), 5))
            confidence = max(0.0, min(float(item.get("confidence", 0.5)), 1.0))
        except (TypeError, ValueError):
            continue
        result.append({
            "action": action,
            "target_memory_id": str(item.get("target_memory_id") or ""),
            "memory_type": memory_type,
            "scope": "workspace" if str(item.get("scope") or "workspace") != "global" else "global",
            "memory_key": str(item.get("memory_key") or ""),
            "content": content,
            "summary": str(item.get("summary") or content),
            "confidence": confidence,
            "score": score,
            "reason": str(item.get("reason") or ""),
            "evidence_event_ids": [str(v) for v in list(item.get("evidence_event_ids") or [])],
        })
    return result


def _safe_event(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "event_id": row.get("event_id"),
        "task_id": row.get("task_id"),
        "task_ok": row.get("task_ok"),
        "user_input": _safe_text(row.get("user_input")),
        "assistant_response": _safe_text(row.get("assistant_response")),
        "tool_calls": row.get("tool_calls", []),
    }


def _safe_existing(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "memory_id": row.get("memory_id"),
        "memory_type": row.get("memory_type"),
        "scope": row.get("scope"),
        "content": _safe_text(row.get("content")),
        "summary": _safe_text(row.get("summary")),
        "memory_key": (row.get("metadata") or {}).get("memory_key"),
        "authority": (row.get("metadata") or {}).get("authority"),
    }


def _safe_text(value: Any) -> str:
    return redact_text(str(value or "").replace("\x00", ""))
