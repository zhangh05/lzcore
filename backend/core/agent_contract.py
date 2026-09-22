# backend/api/agent_contract.py
"""Shared helpers for agent transports (HTTP and WebSocket).

Both agent_routes.py and agent_ws.py delegate metadata normalization and
stream mode resolution here so the transport contract stays in one place.
"""

from __future__ import annotations

import json
from typing import Any


def metadata_size(value: Any) -> int:
    """Return the UTF-8 byte size of *value* as JSON."""
    try:
        return len(json.dumps(value, ensure_ascii=False).encode("utf-8"))
    except Exception:
        return 0


def resolve_stream_mode(data: dict) -> tuple[bool, str]:
    """Return (stream_enabled, stream_mode).

    HTTP accepts only the current ``stream_mode`` field. A true ``live`` stream
    requires the WebSocket transport.
    """
    requested = data.get("stream_mode") or False
    if requested is True:
        return True, "event_replay"
    if requested is False or requested is None:
        return False, "sync"
    mode = str(requested).strip().lower()
    if mode in {"1", "true", "yes", "sse", "event_replay", "replay"}:
        return True, "event_replay"
    if mode in {"live", "live_stream"}:
        # HTTP cannot do true live; degrade to event_replay.
        return True, "event_replay"
    return False, "sync"


_STREAM_CONTRACTS = {
    ("http", "event_replay"): "event_replay_after_turn_complete",
    ("http", "sync"): None,
    ("websocket", "live"): "live_stream_via_stream_emitter",
    ("websocket", "event_replay_fallback"): "event_replay_fallback",
}


# Metadata arriving over HTTP/WebSocket is untrusted.  Keep this allowlist
# deliberately small: runtime-only fields such as runtime_guidance,
# subagent_profile, history/retrieval blocks, cancellation callbacks and
# iteration budgets must only be created by server-side code.
_EXTERNAL_METADATA_KEYS = frozenset({"attachments", "client_request_id", "workbench_selection"})


def normalize_metadata(metadata: dict | None, *, transport: str, stream_mode: str) -> dict:
    """Build trusted runtime metadata from an untrusted transport payload.

    The caller may supply only explicitly public fields.  Transport identity
    and stream contracts are server-owned and always overwrite client input.
    """
    source = metadata if isinstance(metadata, dict) else {}
    normalized = {
        key: source[key]
        for key in _EXTERNAL_METADATA_KEYS
        if key in source
    }
    selection = normalized.get("workbench_selection")
    if selection is not None and not isinstance(selection, dict):
        normalized.pop("workbench_selection", None)
    normalized["transport"] = transport
    normalized["stream_mode"] = stream_mode
    contract = _STREAM_CONTRACTS.get((transport, stream_mode))
    if contract:
        normalized["stream_contract"] = contract
    return normalized


def resolve_workbench_metadata(metadata: dict, workspace_id: str, session_id: str | None = None) -> dict:
    """Turn an allowed but untrusted UI selection into server-owned context.

    If the client does not provide an explicit workbench_selection, but the
    current session is bound to a topology (e.g. created from the topology canvas
    or carrying topology metadata/title), automatically supply the topology
    drawing skill so canvas tools are active by default.
    """
    normalized = dict(metadata or {})
    selection = normalized.pop("workbench_selection", None)
    if not selection and session_id:
        try:
            from storage.session_store import get_session, update_session
            sess = get_session(session_id, workspace_id)
            if sess:
                sess_meta = dict(sess.get("metadata") or {})
                topo_id = sess_meta.get("topology_id")
                allow_edit = bool(sess_meta.get("allow_edit", True))
                if not topo_id and (sess.get("title") or "").startswith("拓扑 · "):
                    topo_name = sess["title"].split("拓扑 · ", 1)[1].strip()
                    try:
                        from extensions.network_operations.topology_service import list_topologies
                        topos = list_topologies(workspace_id)
                        for t in topos:
                            if t.get("name") == topo_name or t.get("topology_id") == topo_name:
                                topo_id = t["topology_id"]
                                break
                        if not topo_id:
                            import re
                            from storage.session_store import get_session_messages
                            msgs = get_session_messages(session_id, workspace_id)
                            for m in reversed(msgs[-10:]):
                                content = str(m.get("content") or "")
                                match = re.search(r'["\']topology_id["\']\s*:\s*["\'](topo_[a-f0-9]+)["\']', content)
                                if match:
                                    candidate = match.group(1)
                                    if any(t.get("topology_id") == candidate for t in topos):
                                        topo_id = candidate
                                        break
                    except Exception:
                        pass
                if topo_id:
                    selection = {
                        "extension_id": "network.operations",
                        "skill_id": f"drawing:{topo_id}" if allow_edit else f"drawing:{topo_id}:ro",
                        "resource_ids": [topo_id],
                        "allow_edit": allow_edit,
                    }
                    if not sess_meta.get("topology_id"):
                        sess_meta["topology_id"] = topo_id
                        sess_meta["workbench_selection"] = selection
                        update_session(session_id, workspace_id, metadata=sess_meta)
        except Exception:
            pass

    if selection:
        from extensions.runtime import resolve_workbench_context
        normalized["workbench_context"] = resolve_workbench_context(workspace_id, selection)
    return normalized


def normalize_agent_result(result: dict, workspace_id: str) -> dict:
    """Backfill stable message fields on an AgentResult dict.

    This ensures every response — HTTP or WebSocket — exposes the same stable
    field set regardless of which runtime path produced the result.
    """
    result.setdefault("ok", not bool(result.get("error")))
    result.setdefault("workspace_id", workspace_id)
    result.setdefault("run_id", result.get("turn_id") or result.get("request_id") or "")
    result.setdefault("turn_id", result.get("run_id") or result.get("request_id") or "")
    result.setdefault("trace_id", "")
    result.setdefault("intent", "assistant_chat")
    result.setdefault("final_response", "")
    result.setdefault("tool_calls", [])
    result.setdefault("warnings", [])
    result.setdefault("errors", [])
    result.setdefault("metadata", {})
    result.setdefault("cognitive", {})
    result.setdefault("cognitive_events", [])
    result.setdefault("report_artifacts", [])
    result.setdefault("artifact_refs", [])
    result.setdefault("trace_available", bool(result.get("trace_id")))
    result.setdefault("timeline_summary", {})
    result.setdefault("memory_written", False)
    result.setdefault("workspace_updated", False)
    result.setdefault("memory_hits_count", 0)
    result.setdefault("knowledge_hits_count", 0)
    result.setdefault("llm", {"enabled": False, "used": False})
    if result.get("trace_id") and not result.get("trace_available"):
        result["trace_available"] = True
    md = result.get("metadata") if isinstance(result.get("metadata"), dict) else {}
    md.setdefault("cognitive", result["cognitive"] if isinstance(result["cognitive"], dict) else {})
    md.setdefault("cognitive_events", result["cognitive_events"] if isinstance(result["cognitive_events"], list) else [])
    result["metadata"] = md
    result["cognitive"] = md["cognitive"]
    result["cognitive_events"] = md["cognitive_events"]
    if "memory_hits_count" in md and isinstance(md["memory_hits_count"], int):
        result["memory_hits_count"] = md["memory_hits_count"]
    if "knowledge_hits_count" in md and isinstance(md["knowledge_hits_count"], int):
        result["knowledge_hits_count"] = md["knowledge_hits_count"]
    return result
