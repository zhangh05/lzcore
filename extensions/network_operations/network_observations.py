"""Network observations domain; shared persistence and transport contracts stay explicit."""

from __future__ import annotations

import hashlib
from typing import Any

from storage.time_utils import now_iso

from .network_records import (
    INTERNAL_SCAN_LIMIT,
    _connection_transaction,
    _id,
    _store,
    get_inspection,
)


def list_baselines(workspace_id: str) -> list[dict[str, Any]]:
    """Read confirmed references while preserving existing stored baselines."""
    references = [
        {
            **item,
            "baseline_id": item["reference_id"],
            "confirmed": item["state"] == "confirmed",
            "devices": dict(item.get("snapshot") or {}),
        }
        for item in list_references(workspace_id)
        if item.get("state") == "confirmed"
    ]
    known = {str(item.get("baseline_id") or "") for item in references}
    legacy = [
        item
        for item in _store(workspace_id).list("baselines", limit=200)
        if str(item.get("baseline_id") or "") not in known
    ]
    return [*references, *legacy]


@_connection_transaction
def record_command_experience(
    workspace_id: str,
    connection_id: str,
    output: dict[str, Any],
) -> list[dict[str, Any]]:
    """Remember read syntax outcomes as hints, never as an executable plan."""
    profile = (
        output.get("device_profile")
        if isinstance(output.get("device_profile"), dict)
        else {}
    )
    driver_id = str(profile.get("driver_id") or "unknown")
    recorded: list[dict[str, Any]] = []
    for item in output.get("command_results") or []:
        if not isinstance(item, dict):
            continue
        command = str(item.get("command") or "").strip()
        if not command:
            continue
        status = (
            "accepted"
            if item.get("complete")
            and not item.get("error_code")
            and not item.get("truncated")
            else "rejected"
        )
        # Syntax feedback belongs to a driver command, not to one connection.
        # Keeping a connection in the identity made the same `display` command
        # appear once per device in the management UI and made a row deletion
        # look ineffective.  Connection provenance remains an aggregated field.
        key = _command_experience_id(driver_id, command)
        previous = _store(workspace_id).get("command_experience", key) or {}
        previous_connections = {
            str(value) for value in (previous.get("connection_ids") or []) if str(value)
        }
        if previous.get("connection_id"):
            previous_connections.add(str(previous["connection_id"]))
        previous_connections.add(str(connection_id))
        record = {
            "experience_id": key,
            "connection_id": connection_id,
            "connection_ids": sorted(previous_connections),
            "driver_id": driver_id,
            "command": command,
            "status": status,
            "error_code": str(item.get("error_code") or ""),
            "device_error": str(item.get("device_error") or "")[:200],
            "observations": int(previous.get("observations") or 0) + 1,
            "last_observed_at": now_iso(),
            "advisory_only": True,
        }
        _store(workspace_id).save("command_experience", key, record)
        recorded.append(record)
    return recorded


def _normalize_command_experience_command(command: str) -> str:
    """One deterministic identity for command-feedback aggregation."""
    return " ".join(str(command or "").split()).casefold()


def _command_experience_id(driver_id: str, command: str) -> str:
    normalized = _normalize_command_experience_command(command)
    return hashlib.sha256(
        f"{str(driver_id or 'unknown').casefold()}|{normalized}".encode()
    ).hexdigest()[:24]


def _command_experience_connections(record: dict[str, Any]) -> set[str]:
    values = {
        str(value) for value in (record.get("connection_ids") or []) if str(value)
    }
    if record.get("connection_id"):
        values.add(str(record["connection_id"]))
    return values


def list_command_experience(
    workspace_id: str,
    *,
    connection_ids: list[str] | None = None,
    limit: int = 80,
) -> list[dict[str, Any]]:
    allowed = (
        None
        if connection_ids is None
        else {str(item) for item in connection_ids if str(item)}
    )
    # Aggregate before applying the display limit.  Otherwise a legacy duplicate
    # near the page boundary could hide a different command altogether.
    records = _store(workspace_id).list("command_experience", limit=INTERNAL_SCAN_LIMIT)
    grouped: dict[str, dict[str, Any]] = {}
    for item in records:
        if not isinstance(item, dict):
            continue
        connections = _command_experience_connections(item)
        if allowed is not None and not connections.intersection(allowed):
            continue
        driver_id = str(item.get("driver_id") or "unknown")
        command = str(item.get("command") or "").strip()
        if not command:
            continue
        experience_id = _command_experience_id(driver_id, command)
        current = grouped.get(experience_id)
        observed_at = str(item.get("last_observed_at") or "")
        if current is None:
            current = {
                **item,
                "experience_id": experience_id,
                "connection_ids": sorted(connections),
                "observations": 0,
            }
            grouped[experience_id] = current
        else:
            current["connection_ids"] = sorted(
                set(current.get("connection_ids") or []).union(connections)
            )
            if observed_at >= str(current.get("last_observed_at") or ""):
                # Latest real device outcome remains the advisory status.
                current.update(
                    {
                        key: value
                        for key, value in item.items()
                        if key
                        not in {"experience_id", "observations", "connection_ids"}
                    }
                )
                current["experience_id"] = experience_id
        current["observations"] = int(current.get("observations") or 0) + int(
            item.get("observations") or 0
        )
    result = list(grouped.values())
    result.sort(key=lambda item: str(item.get("last_observed_at") or ""), reverse=True)
    return result[:limit]


def record_inspection_observation(
    workspace_id: str, task: dict[str, Any]
) -> dict[str, Any]:
    """Persist one time-bound observation; never declare that it is normal."""
    from core.runtime_engine.context_contract import (
        normalize_observation_descriptor,
        normalize_reference_descriptor,
    )

    observation_id = _id("observation")
    target_ids = sorted(str(item) for item in (task.get("results") or {}).keys())
    snapshot = {
        target_id: {
            "status": str(
                (task.get("results") or {}).get(target_id, {}).get("status")
                or "unknown"
            ),
            "output_hash": str(
                (task.get("results") or {}).get(target_id, {}).get("output_hash") or ""
            ),
        }
        for target_id in target_ids
    }
    status = str(task.get("status") or "unknown")
    completeness = (
        "complete"
        if status == "succeeded"
        else "partial"
        if status == "partial"
        else "failed"
        if status in {"failed", "cancelled"}
        else "unknown"
    )
    scope_key = hashlib.sha256("|".join(target_ids).encode()).hexdigest()[:20]
    observation = normalize_observation_descriptor(
        {
            "observation_id": observation_id,
            "source_kind": "network_inspection",
            "source_id": str(task.get("task_id") or ""),
            "artifact_id": str(task.get("artifact_id") or ""),
            "observed_at": str(task.get("finished_at") or now_iso()),
            "completeness": completeness,
            "scope_key": scope_key,
            "target_ids": target_ids,
            "snapshot": snapshot,
            "created_at": now_iso(),
        }
    )
    _store(workspace_id).save("observations", observation_id, observation)
    candidate_id = ""
    if completeness in {"complete", "partial"}:
        candidate_id = _id("reference")
        candidate = normalize_reference_descriptor(
            {
                "reference_id": candidate_id,
                "name": f"巡检候选参考 {str(task.get('task_id') or '')[-8:]}",
                "state": "candidate",
                "authority": "observed",
                "current": False,
                "scope_key": scope_key,
                "target_ids": target_ids,
                "source_observation_ids": [observation_id],
                "snapshot": snapshot,
                "completeness": completeness,
                "created_at": now_iso(),
                "updated_at": now_iso(),
            }
        )
        _store(workspace_id).save("references", candidate_id, candidate)
        observation["candidate_reference_id"] = candidate_id
        _store(workspace_id).save("observations", observation_id, observation)
    return observation


def list_observations(workspace_id: str, *, limit: int = 100) -> list[dict[str, Any]]:
    records = _store(workspace_id).list("observations", limit=max(1, min(limit, 500)))
    records.sort(key=lambda item: str(item.get("observed_at") or ""), reverse=True)
    return records[:limit]


def list_references(workspace_id: str, *, limit: int = 200) -> list[dict[str, Any]]:
    records = _store(workspace_id).list("references", limit=max(1, min(limit, 500)))
    records.sort(
        key=lambda item: str(item.get("updated_at") or item.get("created_at") or ""),
        reverse=True,
    )
    return records[:limit]


@_connection_transaction
def delete_observation(workspace_id: str, observation_id: str) -> dict[str, Any]:
    """Hard-delete an observation and every reference that depends on it.

    A reference without its source observation is invalid evidence.  Deleting
    one therefore removes those dependent reference records in the same
    workspace transaction; inspection task history and artifacts are retained
    because they are separate execution/audit records.
    """
    store = _store(workspace_id)
    if not store.get("observations", observation_id):
        raise ValueError("observation_not_found")
    deleted_references = 0
    for reference in list_references(workspace_id, limit=INTERNAL_SCAN_LIMIT):
        source_ids = {
            str(item) for item in reference.get("source_observation_ids") or []
        }
        if observation_id in source_ids and store.delete(
            "references", str(reference["reference_id"])
        ):
            deleted_references += 1
    store.delete("observations", observation_id)
    return {
        "deleted": True,
        "observation_id": observation_id,
        "deleted_dependent_references": deleted_references,
    }


@_connection_transaction
def delete_observations(
    workspace_id: str, observation_ids: list[str]
) -> dict[str, Any]:
    """Hard-delete selected observations and all references depending on them."""
    ids = sorted(
        {
            str(observation_id or "").strip()
            for observation_id in observation_ids
            if str(observation_id or "").strip()
        }
    )
    if not ids or len(ids) > 500:
        raise ValueError("observation_ids_must_contain_1_to_500_items")
    store = _store(workspace_id)
    if any(not store.get("observations", observation_id) for observation_id in ids):
        raise ValueError("observation_not_found")
    selected = set(ids)
    dependent_reference_ids = [
        str(reference["reference_id"])
        for reference in list_references(workspace_id, limit=INTERNAL_SCAN_LIMIT)
        if selected.intersection(
            {str(item) for item in reference.get("source_observation_ids") or []}
        )
    ]
    for reference_id in dependent_reference_ids:
        if not store.delete("references", reference_id):
            raise RuntimeError("reference_delete_failed")
    for observation_id in ids:
        if not store.delete("observations", observation_id):
            raise RuntimeError("observation_delete_failed")
    return {
        "observation_ids": ids,
        "deleted_dependent_references": len(dependent_reference_ids),
    }


@_connection_transaction
def delete_reference(workspace_id: str, reference_id: str) -> bool:
    """Hard-delete a user-visible operational reference record."""
    return _store(workspace_id).delete("references", reference_id)


@_connection_transaction
def delete_references(workspace_id: str, reference_ids: list[str]) -> list[str]:
    """Hard-delete the selected user-visible operational reference records."""
    ids = sorted(
        {
            str(reference_id or "").strip()
            for reference_id in reference_ids
            if str(reference_id or "").strip()
        }
    )
    if not ids or len(ids) > 500:
        raise ValueError("reference_ids_must_contain_1_to_500_items")
    store = _store(workspace_id)
    if any(not store.get("references", reference_id) for reference_id in ids):
        raise ValueError("reference_not_found")
    for reference_id in ids:
        if not store.delete("references", reference_id):
            raise RuntimeError("reference_delete_failed")
    return ids


@_connection_transaction
def delete_command_experience(workspace_id: str, experience_id: str) -> bool:
    """Hard-delete a command feedback identity, including legacy duplicates."""
    store = _store(workspace_id)
    selected = store.get("command_experience", experience_id) or {}
    selected_identity = ""
    if selected:
        selected_identity = _command_experience_id(
            str(selected.get("driver_id") or "unknown"),
            str(selected.get("command") or ""),
        )
    deleted = False
    for record in store.list("command_experience", limit=INTERNAL_SCAN_LIMIT):
        if not isinstance(record, dict):
            continue
        record_id = str(record.get("experience_id") or "")
        identity = _command_experience_id(
            str(record.get("driver_id") or "unknown"),
            str(record.get("command") or ""),
        )
        if (
            record_id == experience_id
            or identity == experience_id
            or (selected_identity and identity == selected_identity)
        ):
            deleted = store.delete("command_experience", record_id) or deleted
    return deleted


@_connection_transaction
def delete_command_experiences(
    workspace_id: str, experience_ids: list[str]
) -> list[str]:
    """Hard-delete selected command feedback identities and legacy duplicates."""
    ids = sorted(
        {
            str(experience_id or "").strip()
            for experience_id in experience_ids
            if str(experience_id or "").strip()
        }
    )
    if not ids or len(ids) > 500:
        raise ValueError("experience_ids_must_contain_1_to_500_items")
    store = _store(workspace_id)
    records = [
        record
        for record in store.list("command_experience", limit=INTERNAL_SCAN_LIMIT)
        if isinstance(record, dict)
    ]
    selected_identities: set[str] = set()
    for experience_id in ids:
        selected = store.get("command_experience", experience_id)
        if selected:
            selected_identities.add(
                _command_experience_id(
                    str(selected.get("driver_id") or "unknown"),
                    str(selected.get("command") or ""),
                )
            )
            continue
        if any(
            _command_experience_id(
                str(record.get("driver_id") or "unknown"),
                str(record.get("command") or ""),
            )
            == experience_id
            for record in records
        ):
            selected_identities.add(experience_id)
            continue
        raise ValueError("command_experience_not_found")
    for record in records:
        identity = _command_experience_id(
            str(record.get("driver_id") or "unknown"), str(record.get("command") or "")
        )
        if (
            str(record.get("experience_id") or "") in ids
            or identity in selected_identities
        ):
            if not store.delete(
                "command_experience", str(record.get("experience_id") or "")
            ):
                raise RuntimeError("command_experience_delete_failed")
    return ids


@_connection_transaction
def transition_reference(
    workspace_id: str, reference_id: str, action: str
) -> dict[str, Any]:
    """Confirm or invalidate a candidate through an explicit human action."""
    from core.runtime_engine.context_contract import normalize_reference_descriptor

    record = _store(workspace_id).get("references", reference_id)
    if not record:
        raise ValueError("reference_not_found")
    action = str(action or "").lower()
    if action == "confirm":
        if record.get("state") != "candidate":
            raise ValueError("only_candidate_reference_can_be_confirmed")
        if record.get("completeness") != "complete":
            raise ValueError("complete_observation_required_for_confirmation")
        for current in list_references(workspace_id, limit=500):
            if (
                current.get("state") == "confirmed"
                and current.get("current")
                and current.get("scope_key") == record.get("scope_key")
            ):
                current.update(
                    {
                        "state": "superseded",
                        "current": False,
                        "updated_at": now_iso(),
                        "superseded_by": reference_id,
                    }
                )
                _store(workspace_id).save(
                    "references", current["reference_id"], current
                )
        record.update(
            {
                "state": "confirmed",
                "authority": "user_confirmed",
                "current": True,
                "confirmed_at": now_iso(),
                "updated_at": now_iso(),
            }
        )
    elif action == "invalidate":
        if record.get("state") not in {"candidate", "confirmed"}:
            raise ValueError("reference_cannot_be_invalidated")
        record.update(
            {
                "state": "invalidated",
                "current": False,
                "invalidated_at": now_iso(),
                "updated_at": now_iso(),
            }
        )
    else:
        raise ValueError("reference_action_must_be_confirm_or_invalidate")
    normalized = normalize_reference_descriptor(record)
    _store(workspace_id).save("references", reference_id, normalized)
    return normalized


def operational_context(
    workspace_id: str,
    *,
    connection_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Return bounded, source-labelled context without performing network IO."""
    allowed = (
        None
        if connection_ids is None
        else {str(item) for item in connection_ids if str(item)}
    )
    observations = list_observations(workspace_id, limit=24)
    references = list_references(workspace_id, limit=40)
    if allowed is not None:
        observations = [
            item
            for item in observations
            if set(item.get("target_ids") or []).intersection(allowed)
        ]
        references = [
            item
            for item in references
            if set(item.get("target_ids") or []).intersection(allowed)
        ]

    def bounded_record(item: dict[str, Any]) -> dict[str, Any]:
        target_ids = list(item.get("target_ids") or [])
        snapshot = (
            item.get("snapshot") if isinstance(item.get("snapshot"), dict) else {}
        )
        return {
            key: value
            for key, value in item.items()
            if key not in {"snapshot", "target_ids"}
        } | {
            "target_ids": target_ids[:20],
            "omitted_target_count": max(0, len(target_ids) - 20),
            "snapshot": {
                target_id: snapshot.get(target_id)
                for target_id in target_ids[:20]
                if target_id in snapshot
            },
        }

    command_experience = list_command_experience(
        workspace_id,
        connection_ids=None if allowed is None else list(allowed),
        limit=40,
    )
    return {
        "observations": [bounded_record(item) for item in observations[:12]],
        "references": [bounded_record(item) for item in references[:20]],
        "command_experience": command_experience,
        "sources": [
            {
                "source_id": "live_cli",
                "kind": "live_observation",
                "available": True,
                "authority": "observed",
            },
            {
                "source_id": "inspection_history",
                "kind": "historical_observation",
                "available": bool(observations),
                "authority": "observed",
            },
            {
                "source_id": "confirmed_reference",
                "kind": "comparison_reference",
                "available": any(
                    item.get("state") == "confirmed" and item.get("current")
                    for item in references
                ),
                "authority": "user_confirmed",
            },
            {
                "source_id": "command_experience",
                "kind": "syntax_feedback",
                "available": bool(command_experience),
                "authority": "observed",
                "advisory_only": True,
            },
        ],
        "reference_rule": "observations_describe_a_point_in_time; only_current_user_confirmed_references_describe_expected_state",
        "first_observation_rule": "never_assume_normal",
    }


def inspection_evidence_summary(workspace_id: str, task_id: str) -> dict[str, Any]:
    """Return a safe evidence index and an LLM-readable, redacted artifact."""
    task = get_inspection(workspace_id, task_id)
    if not task:
        raise ValueError("inspection_not_found")
    is_connection_task = task.get("target_kind") == "connection" or bool(
        task.get("connection_ids")
    )
    snapshots = (
        task.get("target_snapshots")
        if isinstance(task.get("target_snapshots"), dict)
        else {}
    )
    devices = []
    for target_id, result in sorted((task.get("results") or {}).items()):
        snapshot = (
            snapshots.get(target_id)
            if isinstance(snapshots.get(target_id), dict)
            else {}
        )
        item = {
            "name": result.get("name", ""),
            "host": result.get("host", ""),
            "status": result.get("status", ""),
            "command_count": len(result.get("commands") or []),
            "output_hash": result.get("output_hash", ""),
            "duration_ms": result.get("duration_ms", 0),
            "error": result.get("error", ""),
        }
        if is_connection_task:
            item["connection_id"] = target_id
            item["device_id"] = str(snapshot.get("device_id") or "")
            item["protocol"] = str(snapshot.get("protocol") or "")
        else:
            item["asset_id"] = target_id
        devices.append(item)
    return {
        "ok": True,
        "task_id": task_id,
        "artifact_id": task.get("artifact_id", ""),
        "artifact_sensitivity": "internal",
        "devices": devices,
    }
