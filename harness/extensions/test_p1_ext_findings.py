from __future__ import annotations

import time

import pytest

from extensions.network_operations import network_findings as findings


@pytest.fixture
def rule_task(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setattr(findings, "list_baselines", lambda *_: [])
    return {"task_id": "task_rule", "target_kind": "connection", "artifact_id": "art_evidence",
            "target_snapshots": {"c1": {"connection_id": "c1", "name": "test", "host": "192.0.2.1"}},
            "results": {"c1": {"status": "succeeded"}},
            "script": {"version": 1, "checks": [{"check_id": "log", "name": "日志告警",
                        "description": "日志关键字", "severity": "high", "pattern": r"\bERROR\b"}]}}


@pytest.mark.parametrize("output, expected", [("", 0), ("all healthy", 0), ("ERROR disk full", 1)])
def test_rules_match_only_device_output_not_command_labels(rule_task, output, expected):
    result = findings._derive_findings("ws", rule_task, {"c1": {"show logging | include ERROR|WARN": output}})
    assert len(result) == expected
    if result:
        assert result[0]["evidence"]["artifact_id"] == "art_evidence"


def test_backtracking_has_hard_timeout(rule_task, monkeypatch):
    rule_task["script"]["checks"][0]["pattern"] = r"(a|aa)+$"
    monkeypatch.setattr(findings, "_RULE_TIMEOUT_SECONDS", 0.01)
    started = time.monotonic()
    with pytest.raises(TimeoutError):
        findings._derive_findings("ws", rule_task, {"c1": {"show log": "a" * 20000 + "!"}})
    assert time.monotonic() - started < 2


def test_analysis_checks_cancellation_and_total_budget(rule_task, monkeypatch):
    with pytest.raises(TimeoutError, match="cancelled"):
        findings._derive_findings("ws", rule_task, {}, cancel_check=lambda: True)
    monkeypatch.setattr(findings, "_ANALYSIS_TIMEOUT_SECONDS", 0)
    with pytest.raises(TimeoutError, match="budget_exceeded"):
        findings._derive_findings("ws", rule_task, {})
