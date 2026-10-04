"""Schema-aware execution semantics shared by catalog, policy and runtime."""

from __future__ import annotations

import math


def declared_action_contract(schema: dict, declared: dict, arguments: dict) -> dict:
    action = str((arguments or {}).get("action") or "").strip().lower()
    candidate = declared.get(action)
    if isinstance(candidate, dict):
        return dict(candidate)
    # A dedicated tool does not have an action discriminator. Its sole
    # declaration is authoritative in every projection, including callers
    # without catalog metadata. A missing action on a merged tool is never
    # inferred to be a read.
    if not action and "properties" in schema and "action" not in (schema.get("properties") or {}) and len(declared) == 1:
        candidate = next(iter(declared.values()))
        if isinstance(candidate, dict):
            return dict(candidate)
    return {}


def validate_execution_time_budget(rule: dict | None, schema: dict) -> dict:
    if not rule:
        return {}
    if not isinstance(rule, dict) or set(rule) != {"duration_argument", "guard_seconds"}:
        raise ValueError("invalid_execution_time_budget")
    name = rule["duration_argument"]
    guard = rule["guard_seconds"]
    if (not isinstance(name, str) or (schema.get("properties", {}).get(name) or {}).get("type") not in {"number", "integer"}
            or isinstance(guard, bool) or not isinstance(guard, (int, float)) or not math.isfinite(guard) or not 0.1 <= guard <= 10):
        raise ValueError("invalid_execution_time_budget")
    return {"duration_argument": name, "guard_seconds": float(guard)}


def execution_timeout_seconds(base: float, arguments: dict, rule: dict) -> float:
    """Account for a declared blocking duration; caller caps still apply."""
    if not rule:
        return base
    duration = arguments.get(rule["duration_argument"])
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration < 0:
        return base
    return max(base, duration + rule["guard_seconds"])
