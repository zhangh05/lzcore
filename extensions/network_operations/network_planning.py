"""Network planning domain; shared persistence and transport contracts stay explicit."""

from __future__ import annotations

from typing import Any

from storage.time_utils import now_iso

from .network_execution import _safe_asset, commands_for, get_asset
from .network_inventory import _normalize_semantic_facts, get_connection, get_device
from .network_records import _id
from .network_scripts import _resolve_script, _script_safe


def _inspection_assets(
    workspace_id: str, asset_ids: list[str] | None
) -> list[dict[str, Any]]:
    if not isinstance(asset_ids, list) or not asset_ids:
        raise ValueError("asset_ids must be a non-empty array")
    if any(not isinstance(item, str) or not item.strip() for item in asset_ids):
        raise ValueError("asset_ids must contain non-empty strings")
    normalized = [item.strip() for item in asset_ids]
    if len(set(normalized)) != len(normalized):
        raise ValueError("asset_ids must not contain duplicates")
    assets = [
        get_asset(workspace_id, asset_id, include_secret=True)
        for asset_id in normalized
    ]
    missing = [asset_id for asset_id, asset in zip(normalized, assets) if asset is None]
    if missing:
        raise ValueError(f"inspection_assets_not_found:{','.join(missing)}")
    return [item for item in assets if item]


def _inspection_connections(
    workspace_id: str, connection_ids: list[str] | None
) -> list[dict[str, Any]]:
    if not isinstance(connection_ids, list) or not connection_ids:
        raise ValueError("connection_ids must be a non-empty array")
    normalized = [str(item).strip() for item in connection_ids]
    if any(not item for item in normalized) or len(set(normalized)) != len(normalized):
        raise ValueError("connection_ids must contain unique non-empty strings")
    targets: list[dict[str, Any]] = []
    for connection_id in normalized:
        connection = get_connection(workspace_id, connection_id)
        if not connection:
            raise ValueError(f"inspection_connection_not_found:{connection_id}")
        device = get_device(workspace_id, str(connection.get("device_id") or ""))
        if not device:
            raise ValueError(f"inspection_connection_device_not_found:{connection_id}")
        targets.append(
            {
                **device,
                "connection_id": connection_id,
                "workspace_id": workspace_id,
                "protocol": connection.get("protocol"),
                "port": connection.get("port"),
            }
        )
    return targets


def _inspection_target_id(target: dict[str, Any]) -> str:
    identifier = str(
        target.get("connection_id") or target.get("asset_id") or ""
    ).strip()
    if not identifier:
        raise ValueError("inspection_target_id_missing")
    return identifier


def _safe_inspection_target(target: dict[str, Any]) -> dict[str, Any]:
    if target.get("connection_id"):
        return {
            key: target.get(key)
            for key in (
                "connection_id",
                "device_id",
                "name",
                "host",
                "vendor",
                "device_type",
                "region_id",
                "protocol",
                "port",
            )
            if key in target
        }
    return _safe_asset(target)


def _command_plan(
    commands: list[str] | None,
    script: dict[str, Any] | None,
    facts: list[str] | None = None,
) -> dict[str, Any]:
    if script:
        return {"mode": "script", "script": _script_safe(script)}
    if facts:
        return {"mode": "semantic_facts", "facts": _normalize_semantic_facts(facts)}
    if commands is not None:
        return {"mode": "inline_commands", "commands": list(commands)}
    raise ValueError("explicit_commands_facts_or_script_required")


def _restore_command_plan(
    task: dict[str, Any],
) -> tuple[list[str] | None, dict[str, Any] | None, list[str] | None]:
    plan = task.get("command_plan")
    if not isinstance(plan, dict):
        raise ValueError("inspection_command_plan_missing")
    mode = str(plan.get("mode") or "")
    if mode == "script":
        script = plan.get("script")
        if not isinstance(script, dict) or not script.get("script_id"):
            raise ValueError("inspection_script_snapshot_invalid")
        return None, dict(script), None
    if mode == "semantic_facts":
        facts = plan.get("facts")
        if not isinstance(facts, list):
            raise ValueError("inspection_semantic_facts_invalid")
        return None, None, _normalize_semantic_facts(facts)
    if mode == "inline_commands":
        commands = plan.get("commands")
        if not isinstance(commands, list):
            raise ValueError("inspection_inline_commands_invalid")
        return list(commands), None, None
    raise ValueError("inspection_command_plan_invalid")


def _build_inspection_task(
    targets: list[dict[str, Any]],
    commands: list[str] | None,
    script: dict[str, Any] | None,
    *,
    facts: list[str] | None = None,
    job_id: str = "",
) -> dict[str, Any]:
    if sum((commands is not None, script is not None, bool(facts))) != 1:
        raise ValueError("exactly_one_of_commands_facts_or_script_required")
    for target in targets:
        if facts:
            # Validate vocabulary now, but defer vendor command selection to
            # the live session after runtime driver detection.
            _normalize_semantic_facts(facts)
        else:
            commands_for(target, commands, script)
    task_id = _id("inspection")
    is_connection_task = all(bool(item.get("connection_id")) for item in targets)
    target_ids = [_inspection_target_id(item) for item in targets]
    task = {
        "task_id": task_id,
        "job_id": job_id,
        "status": "queued",
        "target_kind": "connection" if is_connection_task else "asset",
        # Results remain attributable after an intentional hard delete. These
        # snapshots contain identity and routing metadata, never credentials.
        "target_snapshots": {
            identifier: _safe_inspection_target(item)
            for identifier, item in zip(target_ids, targets)
        },
        "total": len(targets),
        "completed": 0,
        "succeeded": 0,
        "partial": 0,
        "failed": 0,
        "results": {},
        "artifact_id": "",
        "command_plan": _command_plan(commands, script, facts),
        "script": _script_safe(script)
        if script
        else {
            "script_id": "semantic-facts" if facts else "inline-commands",
            "name": "语义事实采集" if facts else "临时只读命令",
            "commands": list(commands or []),
            "facts": list(facts or []),
        },
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    if is_connection_task:
        task["connection_ids"] = target_ids
        task["device_ids"] = [str(item.get("device_id") or "") for item in targets]
    else:
        task["asset_ids"] = target_ids
        # Internal legacy tasks keep their historical field without leaking it
        # into the registered-connection path.
        task["asset_snapshots"] = dict(task["target_snapshots"])
    return task


def _new_inspection_task(
    workspace_id: str,
    asset_ids: list[str] | None,
    commands: list[str] | None,
    script_id: str,
    *,
    job_id: str = "",
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any] | None]:
    assets = _inspection_assets(workspace_id, asset_ids)
    script = _resolve_script(workspace_id, script_id)
    task = _build_inspection_task(assets, commands, script, job_id=job_id)
    return task, assets, script


def _new_connection_inspection_task(
    workspace_id: str,
    connection_ids: list[str] | None,
    commands: list[str] | None,
    script_id: str,
    *,
    facts: list[str] | None = None,
    job_id: str = "",
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any] | None]:
    if commands is not None and facts:
        raise ValueError("commands_and_facts_are_mutually_exclusive")
    targets = _inspection_connections(workspace_id, connection_ids)
    script = _resolve_script(workspace_id, script_id)
    if script and facts:
        raise ValueError("script_and_facts_are_mutually_exclusive")
    task = _build_inspection_task(targets, commands, script, facts=facts, job_id=job_id)
    return task, targets, script
