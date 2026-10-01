"""Deterministic handling for explicit user memory control commands."""

from __future__ import annotations

import hashlib
import re
from typing import Any


_FORGET = re.compile(r"(?:不要记住|别记住|忘掉|忘记|删除(?:这条|刚才的)?记忆|不再记得)\s*(.*)", re.I)
_REMEMBER = re.compile(
    r"(?:请记住|记住|以后(?=都|请|要|不要|别|默认|每|全量|回复|回答|使用|用|先|只)|下次(?:请|要|不要|别)|"
    r"我希望你|我要求你|默认(?:要|使用|采用|用|请)|不要再|别再|always\b|never\b|please remember\b)",
    re.I,
)


def parse_memory_command(user_input: str) -> dict[str, Any] | None:
    """Return explicit remember/forget intent from user text only."""
    text = str(user_input or "").strip()
    if not text:
        return None
    # A control command must be the user's own leading intent. Keywords inside
    # an audit request, quotation, document or code fence are not authorization.
    forget = _FORGET.match(text)
    if forget:
        return {
            "action": "forget",
            "query": (forget.group(1) or "").strip(" ，。.!！?"),
            "reason": "explicit_user_forget_command",
        }
    if not _REMEMBER.match(text):
        return None
    # Avoid weak conversational phrases that are not durable instructions.
    if re.fullmatch(r"以后(?:再说|看看|讨论|处理)[。.!！?]?", text, re.I):
        return None
    return {
        "action": "remember",
        "content": text,
        "summary": text,
        "memory_type": "core_rule",
        "memory_key": _rule_key(text),
        "reason": "explicit_user_memory_command",
    }


def apply_memory_command(
    command: dict[str, Any],
    *,
    workspace_id: str,
    session_id: str,
    task_id: str,
) -> dict[str, Any]:
    from storage.memory_governance import MemoryRecord, MemoryStore, MemoryWriteGate, expire_memory

    store = MemoryStore()
    if command.get("action") == "forget":
        query = str(command.get("query") or "").strip()
        candidates = store.search(workspace_id, query, limit=10) if query else store.list_all(workspace_id)
        expired = []
        for item in candidates:
            memory_id = item.get("memory_id") if isinstance(item, dict) else getattr(item, "memory_id", "")
            record = store.get(workspace_id, str(memory_id or ""))
            if record is None or record.status != "active" or record.memory_type != "core_rule":
                continue
            if expire_memory(workspace_id, record.memory_id).get("ok"):
                expired.append(record.memory_id)
            if not query:
                break
        return {"ok": True, "action": "forget", "expired_memory_ids": expired}

    content = str(command.get("content") or "").strip()
    record = MemoryRecord(
        workspace_id=workspace_id,
        session_id=session_id,
        task_id=task_id,
        scope="workspace",
        memory_type="core_rule",
        status="active",
        source="user",
        content=content,
        summary=str(command.get("summary") or content),
        confidence=1.0,
        citations=[{"task_id": task_id, "source": "user_input"}],
        created_by="user",
        metadata={
            "memory_key": command.get("memory_key"),
            "authority": "explicit_user",
            "authority_rank": 100,
            "extraction_reason": command.get("reason"),
            "evidence_source": "user_input",
            "generation_origin": "user_memory_command",
        },
    )
    return MemoryWriteGate(store).write(record)


def _rule_key(text: str) -> str:
    normalized = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "", text.lower())
    # Shared topic words cannot establish that two preferences replace one
    # another. Explicit structured keys remain supported by MemoryWriteGate.
    return "rule:" + hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
