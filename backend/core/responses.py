# backend/core/responses.py
"""Unified API response helpers — canonical envelope shapes.

P2-C: Standardizes response shapes across all core APIs.
  - ok_response()    — success with data
  - error_response() — failure with machine-readable error code + message
  - list_response()  — paginated list with items + count + workspace_id
  - item_response()  — single object with item + workspace_id
  - empty_response() — success with no content

All helpers return (dict, status_code) tuples for Flask jsonify + status.
"""

from __future__ import annotations

from typing import Any

# ═══════════════════════════════════════════════════════════════════════
# Canonical envelope shapes
# ═══════════════════════════════════════════════════════════════════════


def ok_response(data: Any = None, workspace_id: str = "") -> tuple[dict, int]:
    """Generic success envelope.

    Returns (body, 200).
    """
    body: dict = {"ok": True}
    if workspace_id:
        body["workspace_id"] = workspace_id
    if data is not None:
        if isinstance(data, dict):
            body.update(data)
        else:
            body["data"] = data
    return body, 200


def error_response(
    error: str,
    message: str = "",
    status_code: int = 400,
    details: dict | None = None,
) -> tuple[dict, int]:
    """Canonical error envelope.

    Returns (body, status_code).

    Args:
        error: Machine-readable error code (e.g. "ARTIFACT_NOT_FOUND").
        message: Human-readable description.
        status_code: HTTP status code.
        details: Optional structured details dict.
    """
    body: dict = {"ok": False, "error": error, "message": message or error}
    if details:
        body["details"] = details
    return body, status_code


def list_response(
    items: list,
    workspace_id: str = "default",
    *,
    count: int = None,
    extra: dict = None,
) -> tuple[dict, int]:
    """Canonical list envelope.

    Returns (body, 200).

    Extra top-level fields may be supplied through `extra` when a route needs a
    named collection such as artifacts, runs, messages, or sessions.
    """
    body: dict = {
        "ok": True,
        "items": items,
        "count": count if count is not None else len(items),
        "workspace_id": workspace_id,
    }
    if extra:
        body.update(extra)
    return body, 200


def item_response(
    item: dict,
    workspace_id: str = "default",
    *,
    extra: dict = None,
) -> tuple[dict, int]:
    """Canonical single-object envelope.

    Returns (body, 200).
    """
    body: dict = {
        "ok": True,
        "item": item,
        "workspace_id": workspace_id,
    }
    if extra:
        body.update(extra)
    return body, 200


# ═══════════════════════════════════════════════════════════════════════
# Convenience wrappers for common patterns
# ═══════════════════════════════════════════════════════════════════════


def not_found(resource: str, resource_id: str = "") -> tuple[dict, int]:
    """404 not found — canonical form."""
    code = f"{resource.upper()}_NOT_FOUND"
    return error_response(code, f"{resource} not found: {resource_id}" if resource_id else f"{resource} not found", 404)


