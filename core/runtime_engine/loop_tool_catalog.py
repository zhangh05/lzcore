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


def _build_cached_tool_definitions(tool_registry: dict) -> list[dict]:
    """Build tool definitions with stable ordering for prompt caching."""
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
