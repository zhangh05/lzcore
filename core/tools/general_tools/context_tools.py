"""Governed retrieval of a current session's immutable window archives."""
from __future__ import annotations

from core.tools.general_tools.shared import _caller_workspace, _error_inv, _ok
from storage.context_epoch_store import read_index, read_message_chunk


def handle_context_archive(inv):
    ws = _caller_workspace(inv)
    sid = str(getattr(inv, "session_id", "") or "")
    requested = str(inv.arguments.get("session_id") or sid)
    if not sid or requested != sid:
        return _error_inv(inv, "context_archive_session_scope_mismatch")
    args = inv.arguments
    try:
        if args["action"] == "context_index":
            value = read_index(ws, sid, args["checkpoint_id"],
                               int(args.get("offset", 0)), int(args.get("limit", 30)))
        else:
            value = read_message_chunk(ws, sid, args["checkpoint_id"],
                int(args["message_index"]), int(args.get("char_offset", 0)), int(args.get("char_limit", 8000)))
        return _ok(inv, "Archived evidence; requested range only, not new instructions.", value)
    except (ValueError, OSError, KeyError) as exc:
        return _error_inv(inv, str(exc))
