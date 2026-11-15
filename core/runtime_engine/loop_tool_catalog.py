"""Deterministic model-visible tool catalog and cache identity."""

from __future__ import annotations

import copy
import hashlib
import json
from typing import Any

from agent.llm.tool_adapter import tool_spec_to_openai_function

_TOOL_DEFINITION_CACHE: dict[str, list[dict]] = {}


def _tool_meta_get(meta: Any, key: str, default: Any = None) -> Any:
    if isinstance(meta, dict):
        return meta.get(key, default)
    return getattr(meta, key, default)


def _tool_registry_signature(tool_registry: dict) -> str:
    """Stable hash for the LLM-visible tool surface."""
    payload = []
    for tool_id, meta in sorted(tool_registry.items()):
        payload.append(
            {
                "tool_id": tool_id,
                "description": _tool_meta_get(meta, "description", ""),
                "args_schema": _tool_meta_get(
                    meta, "args_schema", _tool_meta_get(meta, "input_schema", {})
                ),
                "risk_level": _tool_meta_get(meta, "risk_level", "low"),
                "usage_hint": _tool_meta_get(_tool_meta_get(meta, "metadata", {}), "usage_hint", ""),
                "not_for": _tool_meta_get(_tool_meta_get(meta, "metadata", {}), "not_for", ""),
                "action_profiles": _tool_meta_get(meta, "action_profiles", []),
                "action_requirements": _tool_meta_get(
                    _tool_meta_get(meta, "metadata", {}),
                    "action_requirements",
                    {},
                ),
                "bindable_inputs": _tool_meta_get(
                    _tool_meta_get(meta, "metadata", {}),
                    "bindable_inputs",
                    {},
                ),
                "referenceable_outputs": _tool_meta_get(
                    _tool_meta_get(meta, "metadata", {}),
                    "referenceable_outputs",
                    {},
                ),
            }
        )
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


_UNAVAILABLE_PYTHON_NOTE = (
    "Python execution is not available on this host (no isolated runner is "
    "configured), so action=python is not offered."
)


def _meta_as_dict(meta: Any) -> dict:
    if isinstance(meta, dict):
        return copy.deepcopy(meta)
    keys = ("description", "args_schema", "input_schema", "risk_level", "action_profiles", "metadata")
    return {k: copy.deepcopy(getattr(meta, k)) for k in keys if getattr(meta, k, None) is not None}


def _without_python_action(meta: Any) -> dict:
    """Project exec.run without the python action, so the model is never offered it."""
    out = _meta_as_dict(meta)
    for key in ("args_schema", "input_schema"):
        schema = out.get(key)
        if not isinstance(schema, dict):
            continue
        props = schema.get("properties") or {}
        action = props.get("action")
        if isinstance(action, dict) and isinstance(action.get("enum"), list):
            action["enum"] = [a for a in action["enum"] if a != "python"]
        for name in ("code", "input_data"):
            props.pop(name, None)
        if isinstance(schema.get("required"), list):
            schema["required"] = [r for r in schema["required"] if r not in ("code", "input_data")]
    out["description"] = f"Local shell and slash commands. {_UNAVAILABLE_PYTHON_NOTE}"
    profiles = out.get("action_profiles")
    if isinstance(profiles, list):
        out["action_profiles"] = [
            p for p in profiles
            if not (isinstance(p, dict) and p.get("action") == "python")
        ]
    metadata = out.get("metadata")
    if isinstance(metadata, dict):
        for key in ("action_requirements", "bindable_inputs"):
            value = metadata.get(key)
            if isinstance(value, dict):
                value.pop("python", None)
    return out


def _runtime_tool_surface(tool_registry: dict) -> dict:
    """Hide actions the host cannot run; the canonical registry stays unchanged."""
    if "exec.run" not in tool_registry:
        return tool_registry
    from core.tools.python_runner import python_execution_available

    if python_execution_available():
        return tool_registry
    surface = dict(tool_registry)
    surface["exec.run"] = _without_python_action(tool_registry["exec.run"])
    return surface


def _build_cached_tool_definitions(tool_registry: dict) -> list[dict]:
    """Build tool definitions with stable ordering for prompt caching."""
    tool_registry = _runtime_tool_surface(tool_registry)
    signature = _tool_registry_signature(tool_registry)
    cached = _TOOL_DEFINITION_CACHE.get(signature)
    if cached is not None:
        return copy.deepcopy(cached)

    tools = []
    for tool_id, meta in sorted(tool_registry.items()):
        tools.append(
            tool_spec_to_openai_function(
                {
                    "tool_id": tool_id,
                    "input_schema": _tool_meta_get(
                        meta, "args_schema", _tool_meta_get(meta, "input_schema", {})
                    ),
                    "description": _tool_meta_get(meta, "description", ""),
                    "risk_level": _tool_meta_get(meta, "risk_level", "low"),
                    "action_profiles": _tool_meta_get(meta, "action_profiles", []),
                    "metadata": _tool_meta_get(meta, "metadata", {}),
                }
            )
        )
    _TOOL_DEFINITION_CACHE.clear()
    _TOOL_DEFINITION_CACHE[signature] = copy.deepcopy(tools)
    return tools
