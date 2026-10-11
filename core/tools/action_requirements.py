"""Action-level argument requirements for merged canonical tools.

Flat function schemas expose every supported argument to the model. This table
adds the conditional requirements that JSON Schema ``required`` cannot express
for a merged ``tool + action`` interface. SemanticValidator and ToolExecutor consume it before
execution, so missing identifiers fail as planning errors rather than opaque
handler errors.
"""

from __future__ import annotations


ACTION_REQUIRED_ALL: dict[tuple[str, str], tuple[str, ...]] = {
    ("exec.run", "shell"): ("command",),
    ("exec.run", "slash"): ("command",),
    ("exec.run", "python"): ("code",),
    ("browser.manage", "navigate"): ("url",),
    ("browser.manage", "type"): ("text",),
    ("browser.manage", "press_key"): ("key",),
    ("browser.manage", "select_option"): ("value",),
    ("browser.manage", "evaluate"): ("script",),
    ("web.manage", "search"): ("query",),
    ("web.manage", "deep_search"): ("query",),
    ("web.manage", "fetch"): ("url",),
    ("web.manage", "weather_batch"): ("locations",),
    ("location.manage", "resolve"): ("query",),
    ("location.manage", "resolve_batch"): ("queries",),
    ("location.manage", "reverse"): ("latitude", "longitude"),
    ("data.manage", "distinct"): ("column",),
    ("data.manage", "filter"): ("conditions",),
    ("data.manage", "sort"): ("by",),
    # ``values`` is required by every aggregate except count. The handler
    # validates it after inspecting aggfunc because the merged schema cannot
    # express that action-and-value-dependent requirement clearly.
    ("data.manage", "pivot"): ("index", "columns"),
    ("data.manage", "join"): ("on",),
    ("report.manage", "save"): ("content",),
    ("report.manage", "diff"): ("text_a", "text_b"),
    ("report.manage", "document"): ("summary",),
    ("knowledge.manage", "search"): ("query",),
    ("knowledge.manage", "import"): ("artifact_id",),
    ("knowledge.manage", "reindex"): ("source_id",),
    ("memory.manage", "get"): ("memory_id",),
    ("memory.manage", "create"): ("content",),
    ("memory.manage", "update"): ("memory_id", "content"),
    ("memory.manage", "confirm"): ("memory_id",),
    ("memory.manage", "delete"): ("memory_id",),
    ("memory.manage", "profile_set"): ("field", "value"),
    ("skill.manage", "find"): ("query",),
    ("skill.manage", "load"): ("skill_name",),
    ("skill.manage", "inspect"): ("skill_name",),
    ("skill.manage", "mcp_list_tools"): ("provider_id",),
    ("skill.manage", "mcp_call"): ("provider_id", "tool_name"),
    ("agent.manage", "spawn"): ("instruction",),
    ("agent.manage", "cancel"): ("subtask_id",),
    ("agent.manage", "start"): ("subtask_id",),
    ("agent.manage", "reconcile"): ("subtask_id",),
    ("agent.manage", "merge"): (),
    ("system.manage", "context_index"): (),
    ("system.manage", "context_read"): ("checkpoint_id", "message_index"),
    ("system.manage", "context_search"): ("query",),
    ("system.manage", "run_get"): ("run_id",),
    ("system.manage", "session_get"): ("session_id",),
    ("system.manage", "session_checkpoint"): ("session_id",),
    ("system.manage", "session_rewind"): ("session_id", "snapshot_id"),
    ("system.manage", "session_export"): ("session_id",),
    ("system.manage", "session_snapshot"): ("session_id",),
    ("text.analyze", "redact"): ("text",),
    ("text.analyze", "extract_entities"): ("text",),
    ("text.analyze", "match"): ("text", "pattern"),
    ("workspace.file", "read"): ("filepath",),
    ("workspace.file", "search"): ("query",),
    ("workspace.file", "read_image"): ("filepath",),
    ("workspace.file", "extract_document"): ("file_id",),
    ("workspace.file", "extract_document_image"): ("file_id", "image_index"),
    ("workspace.file", "extract_document_images"): ("file_id",),
    ("workspace.file", "write"): ("filename", "content"),
    ("workspace.file", "create"): ("filepath", "content"),
    ("workspace.file", "write_artifact"): ("filename", "content"),
    ("workspace.file", "edit"): ("filepath", "old_string", "new_string"),
    ("workspace.file", "patch"): ("filepath", "patch_text"),
    ("workspace.file", "delete"): ("filepath",),
    ("workspace.artifact", "read"): ("artifact_id",),
    ("workspace.artifact", "save"): ("content",),
    ("workspace.artifact", "tag"): ("artifact_id", "tags"),
    ("workspace.artifact", "delete"): ("artifact_id",),
    ("workspace.filestore", "references"): ("file_id",),
    ("workspace.filestore", "export"): ("destination",),
    ("workspace.filestore", "restore_bundle_preview"): ("file_id",),
    ("workspace.filestore", "restore_bundle"): ("file_id",),
    ("workspace.filestore", "search"): ("query",),
    ("workspace.filestore", "source_move"): ("filepath", "destination"),
    ("workspace.filestore", "pack"): ("filepath", "destination"),
    ("workspace.filestore", "extract_archive"): ("file_id", "destination"),
    ("workspace.filestore", "inspect"): ("file_id",),
    ("workspace.filestore", "render_page"): ("file_id",),
    ("workspace.filestore", "materialize"): ("destination",),
    ("workspace.filestore", "publish"): ("filepath",),
    ("workspace.filestore", "rename"): ("file_id", "name"),
    ("workspace.filestore", "move"): ("file_id", "folder"),
    ("workspace.filestore", "restore"): ("file_id",),
    ("workspace.filestore", "delete"): ("file_id",),
    ("workspace.filestore", "import"): ("filepath",),
}

# Requirements selected by another published argument, shared by planning and
# tool governance. They do not invent missing values or change permissions.
ACTION_REQUIRED_WHEN = {
    ("agent.manage", "spawn"): (
        ("profile_id", ("coding_agent", "frontend_agent", "qa_agent"), ("coding_assignment",)),
    ),
}


def required_action_arguments(tool_id: str, action: str, arguments: dict) -> tuple:
    required = list(ACTION_REQUIRED_ALL.get((tool_id, action), ()))
    for field, values, fields in ACTION_REQUIRED_WHEN.get((tool_id, action), ()):
        if arguments.get(field) in values:
            required.extend(fields)
    return tuple(dict.fromkeys(required))

# Presence and a valid string type are sufficient for an empty source file.
# Other required text (paths, identifiers, commands) must remain non-empty.
ACTION_ALLOW_EMPTY: dict[tuple[str, str], frozenset[str]] = {
    ("workspace.file", "create"): frozenset({"content"}),
    ("workspace.file", "edit"): frozenset({"new_string"}),
    ("browser.manage", "type"): frozenset({"text"}),
    ("report.manage", "diff"): frozenset({"text_a", "text_b"}),
}


ACTION_REQUIRED_ANY: dict[tuple[str, str], tuple[tuple[str, ...], ...]] = {
    ("browser.manage", "click"): (("selector", "ref"),),
    ("browser.manage", "type"): (("selector", "ref"),),
    ("browser.manage", "hover"): (("selector", "ref"),),
    ("browser.manage", "select_option"): (("selector", "ref"),),
    ("knowledge.manage", "read"): (("chunk_id", "source_id"),),
    # CNF form: either location, or both coordinates.
    ("web.manage", "weather"): (
        ("location", "latitude"),
        ("location", "longitude"),
    ),
    ("data.manage", "parse"): (("text", "rows", "source_filepath"),),
    ("data.manage", "stats"): (("text", "rows", "source_filepath"),),
    ("data.manage", "distinct"): (("text", "rows", "source_filepath"),),
    ("data.manage", "aggregate"): (("text", "rows", "source_filepath"),),
    ("data.manage", "filter"): (("text", "rows", "source_filepath"),),
    ("data.manage", "sort"): (("text", "rows", "source_filepath"),),
    ("data.manage", "render"): (("text", "rows", "source_filepath"),),
    ("data.manage", "pivot"): (("text", "rows", "source_filepath"),),
    ("data.manage", "join"): (
        ("text", "rows", "source_filepath"),
        ("right_text", "right_rows", "right_source_filepath"),
    ),
    ("agent.manage", "get"): (("subtask_id",),),
    ("agent.manage", "merge"): (("subtask_id",),),
}


# Action-level execution semantics are shared by planning, authorization and
# catalog presentation. Tool manifests remain defaults for unlisted actions.
_READ = {
    "action_class": "read", "risk_level": "low", "side_effects": "none",
    "idempotency": "safe_to_retry", "read_only": True,
}
_WRITE = {
    "action_class": "write", "risk_level": "medium", "side_effects": "workspace",
    "idempotency": "unsafe_to_retry", "read_only": False,
}
_EXECUTE = {
    "action_class": "execute", "risk_level": "medium", "side_effects": "task_state",
    "idempotency": "unsafe_to_retry", "read_only": False,
}
_NETWORK_READ = {
    "action_class": "network", "risk_level": "low", "side_effects": "external_read",
    "idempotency": "safe_to_retry", "read_only": True,
}
_BROWSER_EXECUTE = {
    "action_class": "network", "risk_level": "medium", "side_effects": "browser_state",
    "idempotency": "unsafe_to_retry", "read_only": False,
}
_LOCAL_EXECUTE = {
    "action_class": "execute", "risk_level": "medium", "side_effects": "local_process",
    "idempotency": "unsafe_to_retry", "read_only": False,
}
_DELETE = {
    "action_class": "delete", "risk_level": "high", "side_effects": "workspace",
    "idempotency": "unsafe_to_retry", "read_only": False,
    "destructive": True,
}


def _contracts(tool_id: str, actions: tuple[str, ...], contract: dict) -> dict[tuple[str, str], dict]:
    return {(tool_id, action): dict(contract) for action in actions}


ACTION_EXECUTION_CONTRACTS: dict[tuple[str, str], dict] = {}
ACTION_EXECUTION_CONTRACTS.update(_contracts(
    "exec.run", ("shell", "python", "slash"), _LOCAL_EXECUTE,
))
ACTION_EXECUTION_CONTRACTS.update(_contracts(
    "browser.manage", ("snapshot", "extract", "wait", "network", "console"), _NETWORK_READ,
))
ACTION_EXECUTION_CONTRACTS.update(_contracts(
    "browser.manage",
    ("navigate", "screenshot", "click", "type", "scroll", "hover", "press_key", "select_option", "evaluate", "tabs", "navigate_back", "close"),
    _BROWSER_EXECUTE,
))
ACTION_EXECUTION_CONTRACTS.update(_contracts(
    "web.manage", ("search", "fetch", "weather", "weather_batch", "deep_search"), _READ,
))
ACTION_EXECUTION_CONTRACTS.update(_contracts(
    "location.manage", ("resolve", "resolve_batch", "reverse"), _READ,
))
ACTION_EXECUTION_CONTRACTS.update(_contracts(
    "data.manage", ("parse", "stats", "distinct", "aggregate", "filter", "sort", "render", "pivot", "join"), _READ,
))
ACTION_EXECUTION_CONTRACTS.update(_contracts(
    "workspace.file",
    ("list", "read", "read_image", "extract_document", "extract_document_image", "extract_document_images", "glob", "search"),
    _READ,
))
ACTION_EXECUTION_CONTRACTS.update(_contracts("workspace.file", ("create", "write", "write_artifact", "edit", "patch"), _WRITE))
ACTION_EXECUTION_CONTRACTS.update(_contracts("workspace.file", ("delete",), _DELETE))
ACTION_EXECUTION_CONTRACTS.update(_contracts("workspace.artifact", ("list", "read"), _READ))
ACTION_EXECUTION_CONTRACTS.update(_contracts("workspace.artifact", ("save", "tag"), _WRITE))
ACTION_EXECUTION_CONTRACTS.update(_contracts("workspace.artifact", ("delete",), _DELETE))
ACTION_EXECUTION_CONTRACTS.update(_contracts("workspace.filestore", ("references", "reconcile_trash_preview"), _READ))
ACTION_EXECUTION_CONTRACTS.update(_contracts('workspace.filestore', ('list', 'resolve', 'inspect', 'render_page', 'source_list', 'search', 'health', 'migration_preview', 'restore_bundle_preview', 'reconcile_preview'), _READ))
ACTION_EXECUTION_CONTRACTS.update(_contracts('workspace.filestore', ('materialize', 'publish', 'rename', 'move', 'restore', 'source_move', 'pack', 'extract_archive', 'reindex', 'migrate', 'export', 'restore_bundle', 'reconcile'), _WRITE))
ACTION_EXECUTION_CONTRACTS.update(_contracts('workspace.filestore', ('delete',), _DELETE))
ACTION_EXECUTION_CONTRACTS.update(_contracts("workspace.filestore", ("import", "reconcile_trash"), _WRITE))
ACTION_EXECUTION_CONTRACTS.update(_contracts("agent.review", ("",), _WRITE))
ACTION_EXECUTION_CONTRACTS.update(_contracts("agent.manage", ("reconcile",), _WRITE))
ACTION_EXECUTION_CONTRACTS.update(_contracts("agent.manage", ("list", "get", "status"), _READ))
ACTION_EXECUTION_CONTRACTS.update(_contracts("agent.manage", ("spawn", "start", "cancel", "merge"), _EXECUTE))
ACTION_EXECUTION_CONTRACTS.update(_contracts("knowledge.manage", ("search", "read", "list", "chunk"), _READ))
ACTION_EXECUTION_CONTRACTS.update(_contracts("knowledge.manage", ("import", "reindex"), _WRITE))
ACTION_EXECUTION_CONTRACTS.update(_contracts("memory.manage", ("search", "get", "review", "profile_get"), _READ))
ACTION_EXECUTION_CONTRACTS.update(_contracts("memory.manage", ("create", "update", "confirm", "profile_set"), _WRITE))
ACTION_EXECUTION_CONTRACTS.update(_contracts("memory.manage", ("delete",), _DELETE))
ACTION_EXECUTION_CONTRACTS.update(_contracts(
    "skill.manage", ("list", "find", "load", "inspect", "mcp_list_tools"), _READ,
))
ACTION_EXECUTION_CONTRACTS.update(_contracts("skill.manage", ("mcp_call",), _EXECUTE))
ACTION_EXECUTION_CONTRACTS.update(_contracts("report.manage", ("diff", "document"), _READ))
ACTION_EXECUTION_CONTRACTS.update(_contracts("report.manage", ("save",), _WRITE))
ACTION_EXECUTION_CONTRACTS.update(_contracts(
    "system.manage", ("diagnostics", "health", "selfcheck", "local_info", "tasks", "audit_log", "run_get", "session_get", "session_export", "session_snapshot", "context_index", "context_read", "context_search"), _READ,
))
ACTION_EXECUTION_CONTRACTS.update(_contracts("system.manage", ("session_checkpoint",), _WRITE))
ACTION_EXECUTION_CONTRACTS.update(_contracts("system.manage", ("session_rewind",), _DELETE))
ACTION_EXECUTION_CONTRACTS.update(_contracts(
    "text.analyze", ("redact", "extract_entities", "match"), _READ,
))


def action_execution_contract(tool_id: str, action: str) -> dict:
    """Return a copy of the canonical action-level execution contract."""
    key = (str(tool_id or "").strip(), str(action or "").strip().lower())
    return dict(ACTION_EXECUTION_CONTRACTS.get(key, {}))

DATA_INPUT_ACTIONS = frozenset({
    "parse", "stats", "distinct", "aggregate", "filter", "sort", "render", "pivot", "join",
})


def has_argument_value(arguments: dict, field_name: str) -> bool:
    value = arguments.get(field_name)
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, dict, tuple, set)):
        return bool(value)
    return True


def missing_action_arguments(tool_id: str, arguments: dict, metadata: dict | None = None,
                             bound_fields=()) -> list[dict]:
    """One conditional contract for planning and every execution entry point.

    Pending result bindings count only during planning; execution must contain
    the actual resolved values. False and zero are valid provided values.
    """
    action = str(arguments.get("action") or "").strip().lower()
    key = (tool_id, action)
    requirements = (metadata or {}).get("action_requirements") or {}
    required_all = tuple((requirements.get("all") or {}).get(action) or ())
    required_any = tuple((requirements.get("any") or {}).get(action) or ())
    missing = []
    for name in dict.fromkeys(required_action_arguments(tool_id, action, arguments) + required_all):
        allowed_empty = name in ACTION_ALLOW_EMPTY.get(key, ()) and isinstance(arguments.get(name), str)
        if not has_argument_value(arguments, name) and not allowed_empty and name not in bound_fields:
            missing.append({"field": name, "tool_id": tool_id, "action": action})
    for alternatives in dict.fromkeys(tuple(ACTION_REQUIRED_ANY.get(key, ())) + tuple(tuple(g) for g in required_any)):
        if not any(has_argument_value(arguments, name) or name in bound_fields for name in alternatives):
            missing.append({"one_of_fields": list(alternatives), "tool_id": tool_id, "action": action})
    return missing
