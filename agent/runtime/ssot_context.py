"""SSOT context boundary; public orchestration remains in ssot_runtime."""

from __future__ import annotations

import logging
from typing import Any

_LOG = logging.getLogger(__name__)


def _build_retrieved_context_block(
    *,
    workspace_id: str,
    session_id: str,
    task_id: str,
    user_input: str,
    max_tokens: int = 3000,
    include_workspace_memory: bool = True,
) -> str:
    """Retrieve governed context without silently widening child-agent access.

    A subagent has a restricted tool profile and an isolated child session.
    Its automatic context must not reintroduce workspace/global memory that the
    profile did not expose.  Workspace knowledge remains available when its
    canonical tool profile permits research-oriented work.
    """
    if not workspace_id or not user_input.strip():
        return ""
    try:
        from core.context.unified_retriever import get_retriever
        from storage.memory_governance import MemoryStore

        retriever = get_retriever(workspace_id)
        if include_workspace_memory:
            retrieved = retriever.retrieve_for_context(
                user_input,
                top_k_memory=3,
                top_k_knowledge=2,
                session_id=session_id,
                task_id=task_id,
            )
        else:
            retrieved = {
                "memory_hits": [],
                "knowledge_hits": retriever.search_knowledge(user_input, top_k=2),
            }
        from storage.redaction import redact_text

        lines: list[str] = []
        if include_workspace_memory:
            core_store = MemoryStore()
            core_rules = core_store.list_retrievable(
                workspace_id,
                memory_type="core_rule",
                session_id=session_id,
                task_id=task_id,
                limit=0,
            )
            for rule in core_rules:
                content = redact_text(
                    str(rule.get("content") or rule.get("summary") or "")
                ).strip()
                if content:
                    lines.append(
                        f"[core-rule scope=workspace authority=explicit-user] {content}"
                    )
            if core_store.load_errors():
                lines.append(
                    "[memory_load_warning] Some saved memory records could not be read; "
                    "healthy records remain available. Do not assume unavailable records are absent."
                )
        for hit in retrieved.get("memory_hits", [])[:3]:
            if str(hit.get("memory_type") or "") == "core_rule":
                continue
            content = redact_text(
                str(hit.get("content") or hit.get("summary") or "")
            ).strip()
            if content:
                scope = str(hit.get("scope") or "workspace")
                lines.append(f"[memory scope={scope}] {content}")
        for hit in retrieved.get("knowledge_hits", [])[:2]:
            content = redact_text(
                str(hit.get("content") or hit.get("summary") or "")
            ).strip()
            if content:
                scope = str(hit.get("scope") or "workspace")
                source_id = str(hit.get("source_id") or "")
                chunk_id = str(hit.get("chunk_id") or hit.get("item_id") or "")
                parent_chunk_id = str(hit.get("parent_chunk_id") or "")
                title = str(hit.get("title") or "")
                section = str(hit.get("chapter") or hit.get("section") or "")
                lines.append(
                    "[knowledge "
                    f"scope={scope} source_id={source_id} chunk_id={chunk_id} "
                    f"parent_chunk_id={parent_chunk_id} title={title!r} section={section!r}] "
                    f"{content}"
                )
        return "\n".join(lines)
    except Exception:
        _LOG.debug("governed context retrieval failed", exc_info=True)
        return "[context_load_failed] Memory/knowledge context could not be loaded. Do not assume there are no saved rules or facts; retry the relevant read tool and disclose any unresolved gap."


def _build_history_block(
    session,
    *,
    user_input: str = "",
    max_tokens: int = 8000,
    exclude_run_id: str = "",
    exclude_client_request_id: str = "",
) -> str:
    """Build prompt-ready conversation context from the session message SSOT.

    Source order:
      1. ``SessionMessageStore`` full persisted messages
      2. in-memory ``session.history`` entries not yet flushed

    The block preserves every persisted conversation turn verbatim. Runtime
    token accounting is telemetry only and must not decide which prior facts
    the model may see.
    """
    try:
        messages = _load_context_messages(
            session,
            exclude_run_id=exclude_run_id,
            exclude_client_request_id=exclude_client_request_id,
        )
        if not messages:
            return ""

        return "RECENT CONVERSATION HISTORY:\n" + "\n".join(
            f"  [{message['role']}] {message['content']}" for message in messages
        )
    except Exception:
        _LOG.debug("conversation history block build failed", exc_info=True)
        return ""


def _attachment_reference_terms(text: str) -> set[str]:
    value = str(text or "").lower()
    terms = (
        "附件",
        "文件",
        "文档",
        "图片",
        "照片",
        "截图",
        "配置",
        "表格",
        "pdf",
        "docx",
        "word",
        "xlsx",
        "excel",
        "ppt",
        "日志",
    )
    return {term for term in terms if term in value}


def _recent_session_attachments(
    session,
    *,
    user_input: str = "",
    limit: int = 8,
) -> list[dict[str, Any]]:
    """Return recent user attachment references for a same-session follow-up.

    Only FileStore metadata already persisted with a user message is reused.
    This is not a filesystem lookup and never revives files from another
    workspace or session.
    """
    workspace_id = str(getattr(session, "workspace_id", "") or "")
    session_id = str(getattr(session, "session_id", "") or "")
    if not workspace_id or not session_id:
        return []
    try:
        from storage.message_store import SessionMessageStore

        messages = SessionMessageStore(
            session_id=session_id, ws_id=workspace_id
        ).get_messages()
        attachment_message_index = -1
        items: list[dict[str, Any]] = []
        for index in range(len(messages) - 1, -1, -1):
            message = messages[index]
            if str(message.get("role") or "") != "user":
                continue
            raw = (message.get("metadata") or {}).get("attachments") or []
            if isinstance(raw, list):
                items = [item for item in raw if isinstance(item, dict)][:limit]
            if items:
                attachment_message_index = index
                break
        if not items:
            return []

        explicit_reference = bool(_attachment_reference_terms(user_input))
        turns_after_attachment = len(messages) - attachment_message_index - 1
        # Implicit reuse is intentionally limited to the immediate follow-up.
        # Older managed files stay available in FileStore but are not injected
        # into unrelated topics later in the same session.
        if not explicit_reference and turns_after_attachment > 1:
            return []
        return items
    except Exception:
        _LOG.debug("recent attachment lookup failed", exc_info=True)
        return []


def _merge_attachment_references(*groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Deduplicate validated attachment metadata while retaining caller order."""
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for group in groups:
        for item in group:
            file_id = str(item.get("file_id") or "").strip()
            if not file_id or file_id in seen:
                continue
            seen.add(file_id)
            merged.append(dict(item))
            if len(merged) >= 8:
                return merged
    return merged


def _active_attachment_references(
    workspace_id: str,
    attachments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Keep only active, current-workspace FileStore records for reuse."""
    if not workspace_id:
        return []
    try:
        from backend.core.chat_attachments import normalize_chat_attachments

        active: list[dict[str, Any]] = []
        for attachment in attachments:
            try:
                active.extend(normalize_chat_attachments(workspace_id, [attachment]))
            except ValueError:
                # A historic message may reference a file the user removed.
                # It must never become a stale trusted handle in a later turn.
                continue
        return active
    except Exception:
        _LOG.debug("attachment revalidation failed", exc_info=True)
        return []


def _load_context_messages(
    session,
    *,
    exclude_run_id: str = "",
    exclude_client_request_id: str = "",
) -> list[dict[str, str]]:
    persisted: list[dict[str, str]] = []
    persisted_seen: set[str] = set()
    ws_id = str(getattr(session, "workspace_id", "") or "")
    session_id = str(getattr(session, "session_id", "") or "")
    if ws_id and session_id:
        try:
            from storage.message_store import SessionMessageStore

            for m in SessionMessageStore(
                session_id=session_id, ws_id=ws_id
            ).get_messages():
                metadata = (
                    m.get("metadata") if isinstance(m.get("metadata"), dict) else {}
                )
                if (
                    exclude_client_request_id
                    and str(metadata.get("client_request_id") or "")
                    == exclude_client_request_id
                ):
                    continue
                _append_context_message(persisted, persisted_seen, m)
        except Exception:
            _LOG.debug(
                "SessionMessageStore history read failed for %s",
                session_id,
                exc_info=True,
            )

    memory: list[dict[str, str]] = []
    memory_seen: set[str] = set()
    for i, msg in enumerate(list(getattr(session, "history", None) or [])):
        role = str(getattr(msg, "role", "") or "")
        content = str(getattr(msg, "content", "") or "")
        client_request_id = str(getattr(msg, "client_request_id", "") or "")
        if exclude_client_request_id and client_request_id == exclude_client_request_id:
            continue
        _append_context_message(
            memory,
            memory_seen,
            {
                "message_id": getattr(msg, "id", "")
                or getattr(msg, "message_id", "")
                or f"mem:{i}:{role}:{content[:40]}",
                "run_id": getattr(msg, "run_id", "") or "",
                "role": role,
                "content": content,
                "metadata": {"client_request_id": client_request_id},
            },
        )
    overlap = _history_overlap(persisted, memory)
    persisted_ids = {m["message_id"] for m in persisted}
    persisted_runs = {(m["run_id"], m["role"]) for m in persisted if m.get("run_id")}
    persisted_requests = {
        (m["client_request_id"], m["role"])
        for m in persisted
        if m.get("client_request_id")
    }
    merged = persisted + [
        m
        for m in memory[overlap:]
        if m["message_id"] not in persisted_ids
        and (m.get("run_id"), m["role"]) not in persisted_runs
        and (m.get("client_request_id"), m["role"]) not in persisted_requests
    ]
    excluded = str(exclude_run_id or "").strip()
    if excluded:
        merged = [
            message
            for message in merged
            if not str(message.get("message_id") or "").startswith(f"{excluded}:")
        ]
    return merged


def _history_overlap(
    persisted: list[dict[str, str]],
    memory: list[dict[str, str]],
) -> int:
    """Return the longest persisted suffix duplicated at memory's prefix."""
    for size in range(min(len(persisted), len(memory)), 0, -1):
        if all(
            left.get("role") == right.get("role")
            and (
                (
                    left.get("message_id")
                    and left.get("message_id") == right.get("message_id")
                )
                or left.get("source_content", left.get("content"))
                == right.get("source_content", right.get("content"))
            )
            for left, right in zip(persisted[-size:], memory[:size])
        ):
            return size
    return 0


def _append_context_message(
    messages: list[dict[str, Any]], seen: set[str], raw: Any
) -> None:
    if not isinstance(raw, dict):
        return
    role = str(raw.get("role") or "")
    content = str(raw.get("content") or "").strip()
    source_content = content
    if role not in ("user", "assistant") or not content:
        return
    key = str(
        raw.get("message_id")
        or raw.get("id")
        or raw.get("run_id")
        or f"{role}:{content[:80]}"
    )
    if key in seen:
        return
    seen.add(key)
    # Public stage history and redacted tool facts remain complete. These
    # are not native reasoning blocks and must not impersonate tool messages.
    metadata = raw.get("metadata") or {}
    if role == "assistant":
        stages = [
            str(stage.get("text") or "")
            for stage in (metadata.get("stage_outputs") or [])
            if isinstance(stage, dict)
        ]
        stages = [stage for stage in stages if stage and stage.strip() != content]
        if stages:
            content = (
                "[Earlier assistant stages]\n"
                + "\n\n".join(stages)
                + "\n\n[Final response]\n"
                + content
            )
    tool_context = metadata.get("tool_context") or []
    if role == "assistant" and isinstance(tool_context, list):
        facts = []
        for item in tool_context:
            if not isinstance(item, dict):
                continue
            tool_id = str(item.get("tool_id") or "tool")
            status = "succeeded" if item.get("ok") else "failed"
            summary = str(item.get("summary") or "").strip()
            errors = "; ".join(str(error) for error in list(item.get("errors") or []))
            detail = summary or errors
            facts.append(f"- {tool_id}: {status}" + (f" — {detail}" if detail else ""))
        if facts:
            content += "\n\n[Tool execution summary]\n" + "\n".join(facts)
    message: dict[str, Any] = {
        "message_id": key,
        "role": role,
        "content": content,
        "source_content": source_content,
    }
    history_state = metadata.get("history_state")
    run_id = str(raw.get("run_id") or metadata.get("run_id") or "").strip()
    if run_id:
        message["run_id"] = run_id
    client_request_id = str(metadata.get("client_request_id") or "").strip()
    if client_request_id:
        message["client_request_id"] = client_request_id
    if (
        isinstance(history_state, dict)
        and history_state.get("schema") == "runtime.history_state.v1"
    ):
        from storage.redaction import redact_value

        message["history_state"] = redact_value(history_state)
    messages.append(message)
