"""SSOT catalog boundary; public orchestration remains in ssot_runtime."""

from __future__ import annotations

from typing import Any


def build_runtime_catalog(client, allowed_tool_ids=None) -> dict[str, dict[str, Any]]:
    tools = {}
    allowed = set(allowed_tool_ids or []) if allowed_tool_ids else None
    action_profiles = {}
    try:
        from core.tools.catalog_snapshot import build_catalog_snapshot

        action_profiles = {
            item.get("tool_id"): item.get("action_profiles", [])
            for item in build_catalog_snapshot().get("tools", [])
            if isinstance(item, dict)
        }
    except Exception:
        action_profiles = {}
    try:
        from core.tools.catalog_snapshot import build_action_profiles_for_tool
    except Exception:
        build_action_profiles_for_tool = None
    for item in client.list_tools():
        tool_id = str(item.get("tool_id") or "")
        if not tool_id:
            continue
        if allowed is not None and tool_id not in allowed:
            continue
        if item.get("enabled") is False or item.get("callable_by_llm") is False:
            continue
        if item.get("forbidden") is True:
            continue
        args_schema = item.get("input_schema") or {}
        profiles = action_profiles.get(tool_id, [])
        if not profiles and build_action_profiles_for_tool:
            try:
                profiles = build_action_profiles_for_tool(
                    tool_id,
                    input_schema=args_schema,
                    category=str(item.get("category") or ""),
                    base_permission=str(item.get("permission_action") or "read"),
                    action_contracts=(item.get("metadata") or {}).get(
                        "action_execution_contracts"
                    ),
                )
            except Exception:
                profiles = []
        tools[tool_id] = {
            "description": str(item.get("description") or tool_id),
            "args_schema": args_schema,
            "category": item.get("category") or "",
            "risk_level": item.get("risk_level") or "low",
            "action_profiles": profiles,
            "metadata": item.get("metadata") or {},
        }
    return tools
