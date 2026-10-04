"""Network scripts domain; shared persistence and transport contracts stay explicit."""

from __future__ import annotations

import re
from typing import Any

from extensions.network_operations.device_tools import normalize_read_only_commands
from storage.time_utils import now_iso

from .network_records import _id, _store

STARTER_SCRIPTS: tuple[dict[str, Any], ...] = (
    {
        "script_id": "starter-h3c-health",
        "name": "H3C 健康巡检",
        "description": "采集 H3C 设备版本、CPU、内存、接口和日志摘要。",
        "vendors": ["h3c"],
        "commands": [
            "display version",
            "display cpu-usage",
            "display memory",
            "display interface brief",
            "display logbuffer | include ERROR|WARN",
        ],
        "checks": [
            {
                "check_id": "log-alert",
                "name": "日志告警关键字",
                "description": "日志中出现 ERROR、FATAL 或 CRITICAL。",
                "severity": "medium",
                "kind": "output_matches",
                "pattern": "\\b(?:ERROR|FATAL|CRITICAL)\\b",
            }
        ],
        "readonly": True,
        "builtin": True,
        "version": 1,
    },
    {
        "script_id": "starter-huawei-health",
        "name": "华为健康巡检",
        "description": "采集华为设备版本、CPU、内存、接口和日志摘要。",
        "vendors": ["huawei"],
        "commands": [
            "display version",
            "display cpu-usage",
            "display memory-usage",
            "display interface brief",
            "display logbuffer | include ERROR|WARN",
        ],
        "checks": [
            {
                "check_id": "log-alert",
                "name": "日志告警关键字",
                "description": "日志中出现 ERROR、FATAL 或 CRITICAL。",
                "severity": "medium",
                "kind": "output_matches",
                "pattern": "\\b(?:ERROR|FATAL|CRITICAL)\\b",
            }
        ],
        "readonly": True,
        "builtin": True,
        "version": 1,
    },
    {
        "script_id": "starter-cisco-health",
        "name": "Cisco 健康巡检",
        "description": "采集 Cisco 设备版本、CPU、内存、接口和日志摘要。",
        "vendors": ["cisco"],
        "commands": [
            "show version",
            "show processes cpu",
            "show memory statistics",
            "show ip interface brief",
            "show logging | include ERROR|WARN",
        ],
        "checks": [
            {
                "check_id": "log-alert",
                "name": "日志告警关键字",
                "description": "日志中出现 ERROR、FATAL 或 CRITICAL。",
                "severity": "medium",
                "kind": "output_matches",
                "pattern": "\\b(?:ERROR|FATAL|CRITICAL)\\b",
            }
        ],
        "readonly": True,
        "builtin": True,
        "version": 1,
    },
)


_CHECK_SEVERITIES = {"low", "medium", "high", "critical"}


def _script_safe(record: dict[str, Any]) -> dict[str, Any]:
    return {
        key: record.get(key)
        for key in (
            "script_id",
            "name",
            "description",
            "vendors",
            "commands",
            "checks",
            "readonly",
            "builtin",
            "version",
            "created_at",
            "updated_at",
        )
        if key in record
    }


def _script_id(value: str) -> str:
    result = str(value or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", result):
        raise ValueError("invalid script_id")
    return result


def _ensure_starter_scripts(workspace_id: str) -> None:
    """Create editable per-workspace starter scripts only once.

    The marker deliberately prevents deleted templates from being recreated.
    """
    store = _store(workspace_id)
    if store.get("script_meta", "starter_scripts_initialized"):
        # Older per-workspace starter records predate deterministic health
        # checks.  Only enrich untouched starter records; custom scripts and
        # any user-owned rule set remain exactly as saved.
        for template in STARTER_SCRIPTS:
            existing = store.get("scripts", template["script_id"])
            if (
                existing
                and existing.get("source") == "starter"
                and int(existing.get("version") or 0) == 1
                and "checks" not in existing
            ):
                existing["checks"] = list(template["checks"])
                existing["updated_at"] = now_iso()
                store.save("scripts", template["script_id"], existing)
        return
    for template in STARTER_SCRIPTS:
        record = {
            **dict(template),
            "readonly": True,
            "builtin": False,
            "source": "starter",
            "created_at": now_iso(),
            "updated_at": now_iso(),
        }
        store.save("scripts", record["script_id"], record)
    store.save(
        "script_meta", "starter_scripts_initialized", {"initialized_at": now_iso()}
    )


def list_inspection_scripts(workspace_id: str) -> list[dict[str, Any]]:
    _ensure_starter_scripts(workspace_id)
    return [
        _script_safe(item) for item in _store(workspace_id).list("scripts", limit=200)
    ]


def get_inspection_script(workspace_id: str, script_id: str) -> dict[str, Any] | None:
    _ensure_starter_scripts(workspace_id)
    identifier = _script_id(script_id)
    record = _store(workspace_id).get("scripts", identifier)
    return _script_safe(record) if record else None


def _normalize_checks(value: Any) -> list[dict[str, str]]:
    """Validate deterministic checks without pretending every vendor has one parser.

    A check is deliberately a small, auditable evidence rule.  It never uses an
    LLM or a local heuristic to decide whether an operational condition is
    true: it either matches persisted command output, or it does not.
    """
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 30:
        raise ValueError("checks must be an array containing at most 30 items")
    normalized: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw in value:
        if not isinstance(raw, dict):
            raise ValueError("each check must be an object")
        check_id = str(raw.get("check_id") or "").strip()
        name = str(raw.get("name") or "").strip()
        description = str(raw.get("description") or "").strip()
        severity = str(raw.get("severity") or "medium").strip().lower()
        kind = str(raw.get("kind") or "output_matches").strip()
        pattern = str(raw.get("pattern") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", check_id) or check_id in seen:
            raise ValueError("check_id must be unique and use letters, numbers, _ or -")
        if not name or len(name) > 100 or len(description) > 300:
            raise ValueError("check name or description is invalid")
        if (
            severity not in _CHECK_SEVERITIES
            or kind != "output_matches"
            or not pattern
            or len(pattern) > 240
        ):
            raise ValueError("invalid check severity, kind, or pattern")
        try:
            re.compile(pattern, re.IGNORECASE)
        except re.error as exc:
            raise ValueError("invalid check pattern") from exc
        seen.add(check_id)
        normalized.append(
            {
                "check_id": check_id,
                "name": name,
                "description": description,
                "severity": severity,
                "kind": kind,
                "pattern": pattern,
            }
        )
    return normalized


def save_inspection_script(
    workspace_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
    script_id = _script_id(str(payload.get("script_id") or _id("script")))
    name = str(payload.get("name") or "").strip()
    description = str(payload.get("description") or "").strip()
    raw_vendors = payload.get("vendors")
    if not isinstance(raw_vendors, list) or any(
        not isinstance(item, str) for item in raw_vendors
    ):
        raise ValueError("script vendors must be an array")
    vendors = [item.strip().lower() for item in raw_vendors if item.strip()]
    allowed = {"h3c", "huawei", "cisco", "generic"}
    if not name or len(name) > 80:
        raise ValueError("script name is required and must be at most 80 characters")
    if not vendors or any(item not in allowed for item in vendors):
        raise ValueError("invalid script vendors")
    raw_commands = payload.get("commands")
    commands = normalize_read_only_commands(raw_commands)
    for vendor in set(vendors):
        normalize_read_only_commands(commands, vendor)
    existing = _store(workspace_id).get("scripts", script_id) or {}
    checks = (
        _normalize_checks(payload["checks"])
        if "checks" in payload
        else list(existing.get("checks") or [])
    )
    record = {
        "script_id": script_id,
        "name": name,
        "description": description[:300],
        "vendors": sorted(set(vendors)),
        "commands": commands,
        "checks": checks,
        "readonly": True,
        "builtin": False,
        "source": str(existing.get("source") or "custom"),
        "version": int(existing.get("version") or 0) + 1,
        "created_at": str(existing.get("created_at") or now_iso()),
        "updated_at": now_iso(),
    }
    _store(workspace_id).save("scripts", script_id, record)
    return _script_safe(record)


def delete_inspection_script(workspace_id: str, script_id: str) -> bool:
    _ensure_starter_scripts(workspace_id)
    return _store(workspace_id).delete("scripts", _script_id(script_id))


def _resolve_script(workspace_id: str, script_id: str | None) -> dict[str, Any] | None:
    if not script_id:
        return None
    script = get_inspection_script(workspace_id, str(script_id))
    if not script:
        raise ValueError("inspection_script_not_found")
    return script
