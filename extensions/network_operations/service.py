"""service domain; shared persistence and transport contracts stay explicit."""

from __future__ import annotations

from typing import Any

from extensions.network_operations.device_drivers import semantic_catalog
from extensions.sdk import ExtensionDataStore, ExtensionSecretStore
from storage.time_utils import now_iso

from .device_drivers import SEMANTIC_FACTS
from .device_tools import probe_target, resolve_source_address
from .network_execution import (
    _safe_asset,
    _target_for,
    collect_connection,
    commands_for,
    get_asset,
    list_assets,
)
from .network_findings import (
    _derive_findings,
    _finding_id,
    _finding_view,
    _upsert_finding,
    list_findings,
)
from .network_inspection_lifecycle import cancel_inspection, retry_inspection
from .network_inspections import (
    _INSPECTION_JOB_TERMINAL_STATUSES,
    _DurableCancellation,
    _enqueue_prepared_inspection,
    _execute_inspection,
    _save_evidence_artifact,
    enqueue_connection_inspection,
    execute_queued_inspection,
    finalize_inspection_job,
)
from .network_inventory import (
    _canonical_connection,
    _connection_identity,
    _connection_target,
    _delete_connection_record,
    _device_identity,
    _normalize_semantic_facts,
    _raw_connections,
    _reconcile_duplicate_connections_unlocked,
    _referenced_connection_ids,
    _replace_connection_references,
    _save_connection_unlocked,
    _save_or_delete_depleted_skill,
    _with_skill_base_capability,
    delete_connection,
    delete_device,
    delete_region,
    delete_skill,
    get_connection,
    get_device,
    get_skill,
    list_connections,
    list_devices,
    list_regions,
    list_skills,
    reconcile_duplicate_connections,
    save_connection,
    save_device,
    save_region,
    save_skill,
    test_connection,
    workbench_skill_catalog,
)
from .network_observations import (
    _command_experience_connections,
    _command_experience_id,
    _normalize_command_experience_command,
    delete_command_experience,
    delete_command_experiences,
    delete_observation,
    delete_observations,
    delete_reference,
    delete_references,
    inspection_evidence_summary,
    list_baselines,
    list_command_experience,
    list_observations,
    list_references,
    operational_context,
    record_command_experience,
    record_inspection_observation,
    transition_reference,
)
from .network_planning import (
    _build_inspection_task,
    _command_plan,
    _inspection_assets,
    _inspection_connections,
    _inspection_target_id,
    _new_connection_inspection_task,
    _new_inspection_task,
    _restore_command_plan,
    _safe_inspection_target,
)
from .network_records import (
    EXTENSION_ID,
    INTERNAL_SCAN_LIMIT,
    SKILL_BASE_TOOL_ID,
    SKILL_TOOL_IDS,
    _connection_lock,
    _connection_transaction,
    _id,
    _public_connection,
    _store,
    _valid_host,
    get_inspection,
    list_inspections,
)
from .network_scripts import (
    _CHECK_SEVERITIES,
    STARTER_SCRIPTS,
    _ensure_starter_scripts,
    _normalize_checks,
    _resolve_script,
    _script_id,
    _script_safe,
    delete_inspection_script,
    get_inspection_script,
    list_inspection_scripts,
    save_inspection_script,
)


def resolve_workbench_selection(
    workspace_id: str, selection: dict[str, Any]
) -> dict[str, Any]:
    """Resolve authorization and saved metadata only; never contact selected devices."""
    if not isinstance(selection, dict):
        raise ValueError("invalid_workbench_skill_selection")
    if str(selection.get("skill_id") or "").startswith("drawing:"):
        from .topology_skill import resolve_selection

        return resolve_selection(workspace_id, selection)
    with _connection_lock(workspace_id):
        skill_id = str(selection.get("skill_id") or "").strip()
        skill = get_skill(workspace_id, skill_id)
        if not skill or not skill.get("enabled", True):
            raise ValueError("workbench_skill_not_available")
        allowed_devices = set(skill.get("device_ids") or [])
        raw_resources = (
            selection.get("resource_ids")
            if "resource_ids" in selection
            else selection.get("device_ids")
        )
        if raw_resources is not None and not isinstance(raw_resources, list):
            raise ValueError("workbench_skill_resources_must_be_an_array")
        if isinstance(raw_resources, list) and len(raw_resources) > 100:
            raise ValueError("workbench_skill_resource_limit_exceeded")
        selected = list(
            dict.fromkeys(
                str(item).strip() for item in (raw_resources or []) if str(item).strip()
            )
        )
        if raw_resources is None:
            selected = list(skill.get("device_ids") or [])
        if not selected or not set(selected).issubset(allowed_devices):
            raise ValueError("workbench_skill_device_forbidden")
        devices = [get_device(workspace_id, item) for item in selected]
        connection_allowlist = set(skill.get("connection_ids") or [])
        visible_connections = {
            str(item.get("connection_id") or ""): item
            for item in list_connections(workspace_id)
            if item.get("connection_id") in connection_allowlist
            and item.get("device_id") in selected
        }
        connections = [
            visible_connections[connection_id]
            for connection_id in skill.get("connection_ids") or []
            if connection_id in visible_connections
        ]
        if not connections:
            raise ValueError("workbench_skill_has_no_configured_connection")

    return {
        "extension_id": EXTENSION_ID,
        "skill_id": skill_id,
        "skill_name": str(skill.get("name") or ""),
        "instructions": str(skill.get("instructions") or ""),
        "allowed_tool_ids": list(skill.get("allowed_tool_ids") or []),
        "approval_enabled": bool(skill.get("approval_enabled", False)),
        "device_ids": selected,
        "connection_ids": [
            str(item.get("connection_id") or "") for item in connections
        ],
        "connection_policy": "on_demand",
        "devices": [
            {
                "device_id": item.get("device_id"),
                "name": item.get("name"),
                "host": item.get("host"),
                "vendor": item.get("vendor"),
            }
            for item in devices
            if item
        ],
        "connections": [
            {
                "connection_id": item.get("connection_id"),
                "device_id": item.get("device_id"),
                "protocol": item.get("protocol"),
                "port": item.get("port"),
                "last_observed_status": str(item.get("status") or "untested"),
                "last_tested_at": str(item.get("last_tested_at") or ""),
                "current_reachability": "not_checked",
                "driver_id": item.get("driver_id"),
                "detected_vendor": item.get("detected_vendor"),
                "os_family": item.get("os_family"),
                "semantic_facts": list(item.get("semantic_facts") or []),
                "profile_detected_from": item.get("profile_detected_from"),
            }
            for item in connections
        ],
        "semantic_catalog": semantic_catalog(),
        "operational_context": operational_context(
            workspace_id,
            connection_ids=[
                str(item.get("connection_id") or "") for item in connections
            ],
        ),
        "network_runtime_version": "network.cli.v3",
        "source": "server_validated_extension_context",
    }


def reconcile_network_state() -> int:
    """Explicit startup maintenance: migrate endpoints and reconcile durable jobs.

    Reads never trigger migrations. Each principal/workspace is migrated under
    the same transaction lock used by connection and Skill mutations.
    """
    from backend.core.identity import get_user
    from jobs.store import get_job, list_jobs
    from storage.principal import known_storage_principals, storage_principal
    from storage.workspace_store import list_workspace_ids

    reconciled = 0
    workspace_ids = list_workspace_ids(include_system=False) or ["default"]
    for principal in known_storage_principals() or [""]:
        identity = get_user(principal)
        scoped_workspaces = (
            list(identity.get("workspace_ids") or [])
            if isinstance(identity, dict)
            else workspace_ids
        )
        with storage_principal(principal):
            for workspace_id in sorted(set(scoped_workspaces)):
                reconcile_duplicate_connections(workspace_id)
                store = _store(workspace_id)
                for task in store.list("inspections", limit=INTERNAL_SCAN_LIMIT):
                    if task.get("status") not in {"queued", "running"}:
                        continue
                    job_id = str(task.get("job_id") or "")
                    if not job_id:
                        continue
                    job = get_job(workspace_id, job_id)
                    if not job or job.status not in {"failed", "cancelled"}:
                        continue
                    task.update(
                        {
                            "status": "cancelled"
                            if job.status == "cancelled"
                            else "failed",
                            "error": ""
                            if job.status == "cancelled"
                            else str(job.error or "backend_restart_during_job"),
                            "finished_at": str(job.finished_at or now_iso()),
                            "updated_at": now_iso(),
                        }
                    )
                    store.save("inspections", task["task_id"], task)
                    reconciled += 1
                # Previous releases retained finished worker implementation
                # Jobs. Remove those generic records while preserving the
                # extension-owned inspection and evidence records.
                for job in list_jobs(
                    workspace_id,
                    job_type="network_inspection",
                    limit=INTERNAL_SCAN_LIMIT,
                ):
                    if (
                        str(job.get("status") or "")
                        not in _INSPECTION_JOB_TERMINAL_STATUSES
                    ):
                        continue
                    if finalize_inspection_job(
                        workspace_id,
                        str((job.get("payload") or {}).get("task_id") or ""),
                        str(job.get("job_id") or ""),
                    ):
                        reconciled += 1
    return reconciled
