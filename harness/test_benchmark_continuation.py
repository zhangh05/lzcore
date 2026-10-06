"""Benchmark feedback cannot silently orphan a preserved coding candidate."""

import json
import sys

from agent.runtime.task_state import commit_task_state, load_task_state
from scripts.benchmark_continuation import continuation_preflight
from storage.message_store import SessionMessageStore


def test_continuation_requires_known_parent_and_compatible_current_request(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    state = commit_task_state(
        workspace_id="owned", session_id="session", run_id="run-original",
        user_input="Implement a complete application", final_response="Candidate retained", run_ok=True,
        runtime_metadata={}, tool_calls=[],
    )
    task_id = state["task"]["task_id"]
    store = SessionMessageStore("session", "owned")
    store.write_message("run-original", "user", "Implement a complete application")
    store.write_message("run-original", "assistant", "Candidate retained")
    before = load_task_state("owned", "session")
    valid = continuation_preflight("owned", "session", "继续同一工程，先准确QA。", task_id)
    assert valid["status"] == "READY" and valid["resolved_task_id"] == task_id
    for expected, prompt, reason in [
        ("", "继续同一工程。", "explicit_parent_task_identity_required"),
        ("another-parent", "继续同一工程。", "parent_task_identity_mismatch"),
        (task_id, "纠正上一轮结论并继续原任务。" + "Detailed contract. " * 100, "request_would_start_another_task"),
        (task_id, "Create a different new application", "request_would_start_another_task"),
    ]:
        result = continuation_preflight("owned", "session", prompt, expected)
        assert result["status"] == "BLOCKED" and result["reason"] == reason
        assert load_task_state("owned", "session") == before
    assert continuation_preflight("other", "session", "继续同一工程。", task_id)["status"] == "BLOCKED"
    assert continuation_preflight("owned", "other-session", "继续同一工程。", task_id)["status"] == "BLOCKED"


def test_driver_blocks_unbound_resume_before_provider_or_environment(monkeypatch, tmp_path):
    from scripts.run_coding_benchmark import main

    monkeypatch.setattr("agent.llm.config.resolve_provider_config", lambda: {"provider": "test", "model": "test"})
    calls = []

    def preflight(_config):
        calls.append("provider")
        return {"status": "BLOCKED", "reason": "test-provider"}

    monkeypatch.setattr("scripts.benchmark_preflight.provider_preflight", preflight)
    monkeypatch.setattr(sys, "argv", ["run_coding_benchmark.py", "--case", "rts", "--output", str(tmp_path),
        "--workspace-id", "owned", "--session-id", "session", "--port", "21501"])
    assert main() == 2
    reports = list((tmp_path / "reports/owned").glob("*/verdict.json"))
    assert len(reports) == 1
    verdict = json.loads(reports[0].read_text())
    assert verdict["stage"] == "task_continuation_preflight"
    assert not verdict["agent_started"] and not verdict["execution_environment_started"]
    assert calls == []
