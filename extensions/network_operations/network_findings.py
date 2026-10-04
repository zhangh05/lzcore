"""Network findings domain; shared persistence and transport contracts stay explicit."""

from __future__ import annotations

import hashlib
import re
from typing import Any

from storage.time_utils import now_iso

from .network_execution import list_assets
from .network_observations import list_baselines
from .network_planning import _inspection_target_id
from .network_records import _store


def _finding_id(target_id: str, category: str, rule_id: str) -> str:
    digest = hashlib.sha256(f"{target_id}|{category}|{rule_id}".encode()).hexdigest()[
        :20
    ]
    return f"finding_{digest}"


def _finding_view(record: dict[str, Any]) -> dict[str, Any]:
    """Project a finding without leaking command output or encrypted secrets."""
    allowed = (
        "finding_id",
        "target_id",
        "connection_id",
        "device_id",
        "target_name",
        "target_host",
        "asset_id",
        "asset_name",
        "asset_host",
        "category",
        "rule_id",
        "title",
        "description",
        "severity",
        "status",
        "first_seen_at",
        "last_seen_at",
        "last_seen_task_id",
        "evidence",
        "occurrences",
        "state_history",
        "updated_at",
    )
    return {key: record.get(key) for key in allowed if key in record}


def _upsert_finding(
    workspace_id: str,
    *,
    asset: dict[str, Any],
    category: str,
    rule_id: str,
    title: str,
    description: str,
    severity: str,
    task: dict[str, Any],
    evidence: dict[str, Any],
) -> dict[str, Any]:
    """Record an evidence-backed observation while preserving human decisions.

    A re-observed resolved finding becomes open again.  An acknowledged or
    suppressed finding remains in its human-selected state; the new evidence is
    visible through ``last_seen_*`` rather than silently overriding that choice.
    """
    store = _store(workspace_id)
    target_id = _inspection_target_id(asset)
    finding_id = _finding_id(target_id, category, rule_id)
    previous = store.get("findings", finding_id) or {}
    previous_status = str(previous.get("status") or "")
    status = "open" if previous_status in {"", "resolved"} else previous_status
    occurrences = int(previous.get("occurrences") or 0) + 1
    record = {
        **previous,
        "finding_id": finding_id,
        "target_id": target_id,
        "target_name": asset.get("name", ""),
        "target_host": asset.get("host", ""),
        "category": category,
        "rule_id": rule_id,
        "title": title,
        "description": description,
        "severity": severity,
        "status": status,
        "first_seen_at": previous.get("first_seen_at") or now_iso(),
        "last_seen_at": now_iso(),
        "last_seen_task_id": task["task_id"],
        "evidence": evidence,
        "occurrences": occurrences,
        "state_history": list(previous.get("state_history") or []),
        "updated_at": now_iso(),
    }
    if asset.get("connection_id"):
        record["connection_id"] = str(asset.get("connection_id") or "")
        record["device_id"] = str(asset.get("device_id") or "")
        for legacy_key in ("asset_id", "asset_name", "asset_host"):
            record.pop(legacy_key, None)
    else:
        record["asset_id"] = target_id
        record["asset_name"] = asset.get("name", "")
        record["asset_host"] = asset.get("host", "")
    store.save("findings", finding_id, record)
    return _finding_view(record)


def _derive_findings(
    workspace_id: str, task: dict[str, Any], raw_outputs: dict[str, dict[str, str]]
) -> list[dict[str, Any]]:
    """Turn a completed read-only inspection into stable, traceable findings."""
    is_connection_task = task.get("target_kind") == "connection" or bool(
        task.get("connection_ids")
    )
    current_targets = (
        {}
        if is_connection_task
        else {item["asset_id"]: item for item in list_assets(workspace_id)}
    )
    snapshots = (
        task.get("target_snapshots")
        if isinstance(task.get("target_snapshots"), dict)
        else {}
    )
    if not snapshots and isinstance(task.get("asset_snapshots"), dict):
        snapshots = task["asset_snapshots"]
    checks = list((task.get("script") or {}).get("checks") or [])
    baseline = next(
        (
            item
            for item in list_baselines(workspace_id)
            if item.get("current") and item.get("confirmed")
        ),
        None,
    )
    findings: list[dict[str, Any]] = []
    for target_id, result in sorted((task.get("results") or {}).items()):
        asset = current_targets.get(target_id) or snapshots.get(target_id)
        if not asset:
            continue
        result_status = str(result.get("status") or "")
        evidence = {
            "task_id": task["task_id"],
            "artifact_id": task.get("artifact_id", ""),
            "output_hash": result.get("output_hash", ""),
            "result_status": result_status,
        }
        if result_status == "failed":
            findings.append(
                _upsert_finding(
                    workspace_id,
                    asset=asset,
                    category="connectivity",
                    rule_id="inspection-failed",
                    title="设备巡检未完成",
                    description="设备无法完成本次只读巡检；请结合连接阶段和凭据状态人工核查。",
                    severity="high",
                    task=task,
                    evidence={
                        **evidence,
                        "error": str(result.get("error") or "")[:240],
                    },
                )
            )
            continue
        raw = raw_outputs.get(target_id) or {}
        joined_output = "\n".join(
            f"{command}\n{output}" for command, output in sorted(raw.items())
        )
        for check in checks:
            if re.search(str(check["pattern"]), joined_output, re.IGNORECASE):
                findings.append(
                    _upsert_finding(
                        workspace_id,
                        asset=asset,
                        category="inspection_rule",
                        rule_id=str(check["check_id"]),
                        title=str(check["name"]),
                        description=str(check["description"]),
                        severity=str(check["severity"]),
                        task=task,
                        evidence={
                            **evidence,
                            "check_id": check["check_id"],
                            "check_version": int(
                                (task.get("script") or {}).get("version") or 0
                            ),
                        },
                    )
                )
        before = (
            (baseline or {}).get("devices", {}).get(target_id) if baseline else None
        )
        after = {"status": result_status, "output_hash": result.get("output_hash", "")}
        if before is not None and before != after:
            findings.append(
                _upsert_finding(
                    workspace_id,
                    asset=asset,
                    category="baseline_change",
                    rule_id="state-diff",
                    title="状态与已确认基线不一致",
                    description="本次巡检输出或设备状态与当前人工确认基线不同；该结果需要人工判断是否为预期变更。",
                    severity="medium",
                    task=task,
                    evidence={
                        **evidence,
                        "baseline_id": baseline.get("baseline_id", ""),
                        "before": before,
                        "after": after,
                    },
                )
            )
    return findings


def list_findings(
    workspace_id: str,
    *,
    status: str = "",
    severity: str = "",
    asset_id: str = "",
    limit: int = 200,
) -> list[dict[str, Any]]:
    records = _store(workspace_id).list("findings", limit=max(1, min(limit, 1000)))
    filtered = [
        record
        for record in records
        if (
            (not status or str(record.get("status") or "") == status)
            and (not severity or str(record.get("severity") or "") == severity)
            and (not asset_id or str(record.get("asset_id") or "") == asset_id)
        )
    ]
    severity_rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    # Stable two-pass ordering: current high-severity findings first, newest
    # evidence first within the same business priority.
    filtered.sort(key=lambda item: str(item.get("last_seen_at") or ""), reverse=True)
    filtered.sort(
        key=lambda item: (
            str(item.get("status") or "") not in {"open", "acknowledged"},
            severity_rank.get(str(item.get("severity") or ""), 9),
        )
    )
    return [_finding_view(record) for record in filtered]
