"""Durable, redacted operation state for side-effecting canonical tools."""
from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any

from storage.atomic_io import atomic_write_json
from storage.locking import FileLock
from storage.records import workspace_record_file
from storage.redaction import redact_text, redact_value


logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def operation_id(workspace_id: str, turn_id: str, call_id: str) -> str:
    source = f"{workspace_id}:{turn_id}:{call_id}"
    return f"op_{hashlib.sha256(source.encode()).hexdigest()[:24]}"


def _path(workspace_id: str, op_id: str):
    if not re.fullmatch(r"op_[a-f0-9]{24}", str(op_id or "")):
        raise ValueError("invalid_operation_id")
    return workspace_record_file(workspace_id, "operations", f"{op_id}.json")


def _digest(arguments: dict[str, Any]) -> str:
    raw = json.dumps(arguments or {}, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


def _read_plan_json(path, *, error_code: str, missing_ok: bool = False):
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(record, dict):
            raise ValueError("non_object_operation_record")
        return record
    except (OSError, ValueError) as exc:
        if missing_ok and isinstance(exc, FileNotFoundError):
            return None
        logger.warning("%s", type(exc).__name__)
        raise RuntimeError(error_code) from None


def plan_operation(ctx, tool_id: str, call_id: str, arguments: dict[str, Any]) -> dict[str, Any]:
    workspace_id = str(getattr(ctx, "workspace_id", ""))
    turn_id = str(getattr(ctx, "request_id", ""))
    session_id = str(getattr(ctx, "session_id", ""))
    extras = getattr(ctx, "extras", {}) or {}
    op_id = operation_id(workspace_id, turn_id, call_id)
    path = _path(workspace_id, op_id)
    arguments_sha256 = _digest(arguments)
    alias_key = json.dumps([workspace_id, turn_id, tool_id, arguments_sha256])
    alias_id = hashlib.sha256(alias_key.encode()).hexdigest()
    alias_path = path.parent / f"alias_{alias_id}.json"
    # Serialize aliases within this turn as well as retries of one call id.
    turn_lock = _path(workspace_id, operation_id(workspace_id, turn_id, "__turn__"))
    with FileLock(turn_lock.with_suffix(".plan.lock")):
        record = _read_plan_json(path, error_code="operation_record_unreadable", missing_ok=True)
        if record is not None:
            if record.get("canonical_tool") != tool_id or record.get("arguments_sha256") != arguments_sha256:
                raise ValueError("operation_identity_conflict")
            return record
        alias = _read_plan_json(alias_path, error_code="operation_alias_unreadable", missing_ok=True)
        if alias is not None:
            try:
                if set(alias) != {"operation_id"}:
                    raise ValueError("invalid_operation_alias")
                target_path = _path(workspace_id, alias["operation_id"])
                record = _read_plan_json(target_path, error_code="operation_alias_target_unreadable")
                if (
                    record.get("operation_id") != alias["operation_id"]
                    or record.get("workspace_id") != workspace_id
                    or record.get("turn_id") != turn_id
                    or record.get("canonical_tool") != tool_id
                    or record.get("arguments_sha256") != arguments_sha256
                    or record.get("status") not in {
                        "planned", "running", "unknown", "indeterminate",
                        "succeeded", "failed", "blocked", "reconciled",
                    }
                ):
                    raise ValueError("invalid_operation_alias_target")
            except (TypeError, ValueError) as exc:
                logger.warning("%s", type(exc).__name__)
                raise RuntimeError("operation_alias_invalid") from None
            if record["status"] in {"planned", "running", "unknown", "indeterminate"}:
                return record
        now = _now()
        record = {
            "schema": "lzcore.operation_ledger.v1",
            "operation_id": op_id,
            "turn_id": turn_id,
            "workspace_id": workspace_id,
            "session_id": session_id,
            "canonical_tool": tool_id,
            "call_id": call_id,
            "arguments_sha256": arguments_sha256,
            "read_only": False,
            "risk_level": str(extras.get("risk_level") or "unknown"),
            "idempotency": "unknown",
            "status": "planned",
            "planned_at": now,
            "updated_at": now,
        }
        # Publish the fence first: an interrupted record write leaves a dangling
        # alias that refuses replay rather than permitting an unindexed write.
        atomic_write_json(alias_path, {"operation_id": op_id})
        atomic_write_json(path, record)
        return record


def start_operation(workspace_id: str, op_id: str) -> dict[str, Any]:
    path = _path(workspace_id, op_id)
    with FileLock(path.with_suffix(".lock")):
        record = json.loads(path.read_text(encoding="utf-8"))
        if record.get("status") != "planned":
            return {**record, "execution_claimed": False}
        now = _now()
        record.update({"status": "running", "started_at": now, "updated_at": now})
        atomic_write_json(path, record)
        return {**record, "execution_claimed": True}


def finish_operation(workspace_id: str, op_id: str, result) -> dict[str, Any]:
    path = _path(workspace_id, op_id)
    with FileLock(path.with_suffix(".lock")):
        record = json.loads(path.read_text(encoding="utf-8"))
        if record.get("status") not in {"planned", "running", "unknown"}:
            return record
        may_continue = bool(getattr(result, "execution_may_continue", False))
        output = getattr(result, "output", {}) or {}
        not_started = output.get("executed") is False
        status = (
            "unknown" if may_continue else
            "blocked" if not_started else
            "succeeded" if bool(getattr(result, "ok", False)) else "failed"
        )
        if record.get("status") == "unknown" and status == "unknown":
            return record
        now = _now()
        record.update({
            "status": status,
            "finished_at": now,
            "updated_at": now,
            "error_code": str(getattr(result, "error_code", "") or "")[:120],
            "error": redact_text(str(getattr(result, "error", "") or ""))[:500],
            "result_summary": redact_text(str(output.get("summary") or ""))[:800],
            "result": redact_value({
                "ok": bool(getattr(result, "ok", False)),
                "output": output,
                "error": str(getattr(result, "error", "") or ""),
                "error_code": str(getattr(result, "error_code", "") or ""),
                "summary": str(getattr(result, "summary", "") or ""),
                "execution_may_continue": may_continue,
            }),
        })
        atomic_write_json(path, record)
        return record


def link_operation_resource(
    workspace_id: str,
    op_id: str,
    *,
    resource_kind: str,
    resource_id: str,
) -> dict[str, Any] | None:
    """Attach a durable resource identity without exposing it to model input."""
    kind = str(resource_kind or "").strip().lower()
    identifier = str(resource_id or "").strip()
    if not kind or not identifier:
        return None
    path = _path(workspace_id, op_id)
    if not path.is_file():
        return None
    with FileLock(path.with_suffix(".lock")):
        record = json.loads(path.read_text(encoding="utf-8"))
        current_kind = str(record.get("resource_kind") or "")
        current_id = str(record.get("resource_id") or "")
        if (current_kind or current_id) and (current_kind != kind or current_id != identifier):
            raise RuntimeError("operation_resource_conflict")
        record.update({
            "resource_kind": kind,
            "resource_id": identifier,
            "updated_at": _now(),
        })
        atomic_write_json(path, record)
        return record


def settle_operation(
    workspace_id: str,
    op_id: str,
    *,
    status: str,
    resolved_by: str,
    error_code: str = "",
    error: str = "",
    result_summary: str = "",
    resource_kind: str = "",
    resource_id: str = "",
    resolution_reason: str = "",
    require_unresolved: bool = False,
) -> dict[str, Any]:
    """Resolve planned/running/unknown state from durable or human evidence."""
    return _settle_operation(
        workspace_id, op_id,
        status=status,
        resolved_by=resolved_by,
        error_code=error_code,
        error=error,
        result_summary=result_summary,
        resource_kind=resource_kind,
        resource_id=resource_id,
        resolution_reason=resolution_reason,
        require_unresolved=require_unresolved,
    )


def _settle_operation(
    workspace_id: str,
    op_id: str,
    *,
    status: str,
    resolved_by: str,
    error_code: str = "",
    error: str = "",
    result_summary: str = "",
    resource_kind: str = "",
    resource_id: str = "",
    resolution_reason: str = "",
    require_unresolved: bool = False,
    allow_indeterminate: bool = False,
) -> dict[str, Any]:
    """Settle under one lock; only the manual entry point may replace indeterminate."""
    if status not in {"succeeded", "failed", "blocked", "reconciled", "indeterminate"}:
        raise ValueError("invalid_operation_resolution_status")
    path = _path(workspace_id, op_id)
    if not path.is_file():
        raise FileNotFoundError(op_id)
    with FileLock(path.with_suffix(".lock")):
        record = json.loads(path.read_text(encoding="utf-8"))
        current = str(record.get("status") or "")
        replacing_indeterminate = allow_indeterminate and current == "indeterminate"
        if current in {"succeeded", "failed", "blocked", "reconciled", "indeterminate"} and not replacing_indeterminate:
            if require_unresolved:
                raise RuntimeError("operation_already_resolved")
            return record
        if current not in {"planned", "running", "unknown"} and not replacing_indeterminate:
            raise RuntimeError("operation_not_resolvable")
        if replacing_indeterminate:
            record["previous_status"] = current
            for field in ("error_code", "error", "result_summary"):
                if field in record:
                    record[f"previous_{field}"] = record[field]
        now = _now()
        record.update({
            "status": status,
            "finished_at": str(record.get("finished_at") or now),
            "resolved_at": now,
            "resolved_by": str(resolved_by or "system")[:80],
            "resolution_reason": redact_text(str(resolution_reason or ""))[:500],
            "error_code": str(error_code or "")[:120] if status not in {"succeeded", "reconciled"} else "",
            "error": redact_text(str(error or ""))[:500] if status not in {"succeeded", "reconciled"} else "",
            "result_summary": redact_text(str(result_summary or ""))[:800],
            "updated_at": now,
        })
        if resource_kind and resource_id:
            record["resource_kind"] = str(resource_kind)[:80]
            record["resource_id"] = str(resource_id)[:160]
        atomic_write_json(path, record)
        return record


def resolve_operation_manually(
    workspace_id: str,
    op_id: str,
    *,
    status: str,
    reason: str,
) -> dict[str, Any]:
    reason = str(reason or "").strip()
    if not reason:
        raise ValueError("resolution_reason_required")
    return _settle_operation(
        workspace_id, op_id,
        status=status,
        resolved_by="manual",
        resolution_reason=reason,
        result_summary="人工核对完成",
        require_unresolved=True,
        allow_indeterminate=True,
    )


def _started_before(record: dict[str, Any], boundary: str) -> bool:
    """Return whether an unresolved record belongs to an earlier process."""
    if not boundary:
        return False
    candidate = str(
        record.get("started_at")
        or record.get("planned_at")
        or record.get("updated_at")
        or ""
    )
    if not candidate:
        return False
    try:
        return datetime.fromisoformat(candidate.replace("Z", "+00:00")) < datetime.fromisoformat(
            str(boundary).replace("Z", "+00:00")
        )
    except (TypeError, ValueError):
        return False


def reconcile_operations(workspace_id: str, *, started_before: str = "") -> dict[str, int]:
    """Resolve durable operations and close records orphaned by a prior process.

    ``unknown`` remains actionable while its owning runtime can still produce a
    read-back or detached result.  After a backend restart, an unlinked record
    has no remaining resolver.  It becomes the honest terminal state
    ``indeterminate`` instead of occupying the live unresolved queue forever.
    """
    records = list_operations(workspace_id, limit=5000)
    outcome = {"checked": 0, "resolved": 0, "pending": 0, "indeterminate": 0}
    for record in records:
        if record.get("status") not in {"planned", "running", "unknown"}:
            continue
        outcome["checked"] += 1
        kind = str(record.get("resource_kind") or "")
        identifier = str(record.get("resource_id") or "")
        resource_status = ""
        summary = ""
        resource_found = False
        if kind == "subagent":
            from agent.runtime.durable.subagent import get_subagent_task
            resource = get_subagent_task(workspace_id, identifier)
            if resource:
                resource_found = True
                resource_status = str(resource.get("status") or "")
                summary = str(resource.get("summary") or "")
        elif kind == "job":
            from jobs.store import get_job
            resource = get_job(workspace_id, identifier)
            if resource:
                resource_found = True
                resource_status = str(resource.status or "")
                summary = str((resource.result_summary or {}).get("status") or resource.error or "")

        if resource_status in {"succeeded", "failed", "cancelled", "canceled"}:
            settle_operation(
                workspace_id,
                str(record["operation_id"]),
                status="succeeded" if resource_status == "succeeded" else "failed",
                resolved_by="durable_resource",
                resource_kind=kind,
                resource_id=identifier,
                result_summary=summary,
                error_code="" if resource_status == "succeeded" else f"{kind.upper()}_{resource_status.upper()}",
            )
            outcome["resolved"] += 1
            continue

        # An existing durable job/subagent remains a valid resolver across a
        # backend restart.  Only orphaned records are closed at the boundary.
        if resource_found:
            outcome["pending"] += 1
            continue

        if not _started_before(record, started_before):
            outcome["pending"] += 1
            continue

        status = "blocked" if record.get("status") == "planned" else "indeterminate"
        settle_operation(
            workspace_id,
            str(record["operation_id"]),
            status=status,
            resolved_by="startup_reconciliation",
            result_summary=(
                "前一运行进程未开始执行该操作"
                if status == "blocked"
                else "前一运行进程结束且没有可继续核验的关联资源；保留结果不确定事实"
            ),
            error_code=(
                "OPERATION_NOT_STARTED_BEFORE_RESTART"
                if status == "blocked"
                else "OPERATION_RESULT_INDETERMINATE_AFTER_RESTART"
            ),
            error=(
                "operation was not started before backend restart"
                if status == "blocked"
                else "operation result cannot be determined after backend restart"
            ),
            resolution_reason="previous_process_has_no_live_reconciliation_source",
        )
        outcome["resolved"] += 1
        if status == "indeterminate":
            outcome["indeterminate"] += 1
    return outcome


def list_operations(
    workspace_id: str,
    *,
    status: str = "",
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Return redacted durable write-operation summaries for diagnostics only."""
    from storage.records import list_json_records

    records = [
        item for item in list_json_records(workspace_id, ("operations",), limit=5000)
        if item.get("schema") == "lzcore.operation_ledger.v1"
    ]
    if status:
        records = [item for item in records if str(item.get("status") or "") == status]
    return [_public_operation_record(item) for item in records[:max(1, min(limit, 5000))]]


def operation_counts(workspace_id: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for record in list_operations(workspace_id, limit=5000):
        state = str(record.get("status") or "unknown")
        counts[state] = counts.get(state, 0) + 1
    return counts


def reconcile_all_operations(*, started_before: str = "") -> dict[str, dict[str, int]]:
    """Reconcile every principal/workspace after restart without crossing scope."""
    from backend.core.identity import get_user
    from storage.principal import known_storage_principals, storage_principal
    from storage.workspace_store import list_workspace_ids

    results: dict[str, dict[str, int]] = {}
    fallback_workspaces = list_workspace_ids(include_system=False) or ["default"]
    for principal in known_storage_principals() or [""]:
        identity = get_user(principal)
        workspace_ids = list(identity.get("workspace_ids") or []) if isinstance(identity, dict) else fallback_workspaces
        with storage_principal(principal):
            for workspace_id in sorted(set(workspace_ids)):
                results[f"{principal}:{workspace_id}"] = reconcile_operations(
                    workspace_id,
                    started_before=started_before,
                )
    return results


def _public_operation_record(record: dict[str, Any]) -> dict[str, Any]:
    """Expose a stable, secret-free ledger projection; never return arguments."""
    allowed = (
        "schema", "operation_id", "turn_id", "workspace_id", "session_id",
        "canonical_tool", "call_id", "read_only", "risk_level",
        "idempotency", "status", "planned_at",
        "started_at", "finished_at", "updated_at", "error_code",
        "resource_kind", "resource_id", "resolved_at", "resolved_by",
        "resolution_reason",
    )
    public = {key: record[key] for key in allowed if key in record}
    public["error"] = redact_text(str(record.get("error") or ""))[:500]
    public["result_summary"] = redact_text(str(record.get("result_summary") or ""))[:800]
    return public
