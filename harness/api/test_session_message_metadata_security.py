from __future__ import annotations

import json
from types import SimpleNamespace

import pytest


def test_message_metadata_is_deeply_redacted_before_persistence(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))

    from storage.message_store import SessionMessageStore

    secret = "sk-test-secret-abcdefghijklmnopqrstuvwxyz"
    store = SessionMessageStore(session_id="session-metadata", ws_id="default")
    store.write_message(
        "run_metadata",
        "assistant",
        "已完成受控诊断。",
        metadata={
            "llm_metadata": {"headers": {"Authorization": f"Bearer {secret}"}},
            "tool_context": {"api_key": secret},
        },
    )

    persisted = json.loads(store._msg_path("run_metadata", "assistant").read_text(encoding="utf-8"))
    serialized = json.dumps(persisted, ensure_ascii=False)
    assert secret not in serialized
    assert "[REDACTED_SECRET]" in serialized


def test_server_validated_workbench_skill_metadata_is_returned_to_chat_ui(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))

    from agent.runtime.message_identity import workbench_message_metadata
    from storage.message_store import SessionMessageStore

    store = SessionMessageStore(session_id="session-skill", ws_id="default")
    metadata = workbench_message_metadata({
        "workbench_context": {"skill_id": "skill-1", "skill_name": "生产巡检"},
    })
    store.write_message("run_skill", "user", "检查设备", metadata={"created_at": "2026-08-29T10:00:00Z", **metadata})

    message = store.get_messages()[0]
    assert message["metadata"]["workbench_skill"] == {"skill_id": "skill-1", "name": "生产巡检"}


@pytest.mark.parametrize("outcome,cancelled", [("unknown", False), ("partial", False), ("failed", True)])
def test_runtime_display_facts_survive_persistence_and_message_get(monkeypatch, tmp_path, outcome, cancelled):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    from flask import Flask
    from agent.runtime.result import AgentResult
    from agent.runtime.turn_persistence import persist_run_record
    from backend.api.session_routes import handle_session_messages
    from storage.session_store import create_session

    session = create_session("default")
    sid = session["session_id"]
    unknown = {"tool_id": "network.operations.device.manage", "call_id": "call-1",
               "error_code": "execution_unknown", "execution_may_continue": True}
    result = AgentResult(
        ok=False, final_response="本轮需核对。", turn_id="run-display", session_id=sid,
        errors=["cancelled_by_user"] if cancelled else [],
        metadata={"execution_outcome": outcome, "tool_execution_outcome": "partial",
                  "unknown_outcome": unknown if outcome == "unknown" else {},
                  "task_state": {"task_id": "task-display"}},
        tool_calls=[{
            "tool_id": unknown["tool_id"], "call_id": "call-1", "ok": False, "duration_ms": 0,
            "summary": "请核对写入", "arguments": {"password": "not-for-display"},
            "result": {"approval_operation_id": "op-1", "approval": {"operation_id": "op-1"},
                       "presentation": {"kind": "network_device", "state": "unknown", "action": "configure",
                                        "target": {"name": "R1", "connection_id": "conn-1"},
                                        "command_results": [{"command": "display version", "complete": False,
                                                             "output": "raw output must not appear"}]}},
            "artifacts": [{"artifact_id": "art-1"}],
        }, {
            "tool_id": "agent.manage", "call_id": "call-2", "ok": True,
            "result": {"observations": [{"result": {
                "subtask_id": "sub-1", "task_status": "running", "observation_revision": 2,
                "profile_id": "research_agent", "content_complete": False,
                "tracking": {"domain": "subagent", "task_id": "sub-1", "auto_polling": "stopped"},
                "progress": {"event": "tool_result", "tool_results": 1},
            }}]},
        }],
    )
    assert persist_run_record(
        SimpleNamespace(session_id=sid, workspace_id="default"),
        SimpleNamespace(turn_id="run-display", op=SimpleNamespace(user_input="检查设备", metadata={}), context={}),
        result, SimpleNamespace(metadata={}),
    ) is True
    app = Flask(__name__)
    app.add_url_rule("/api/sessions/<session_id>/messages", view_func=handle_session_messages)
    response = app.test_client().get(f"/api/sessions/{sid}/messages?workspace_id=default")
    assert response.status_code == 200
    assistant = next(m for m in response.get_json()["messages"] if m["role"] == "assistant")
    meta = assistant["metadata"]
    assert meta["execution_outcome"] == outcome
    assert meta["tool_execution_outcome"] == "partial"
    assert meta["task_id"] == "task-display"
    assert meta["output_artifacts"] == ["art-1"]
    if outcome == "unknown":
        assert meta["unknown_outcome"] == unknown
    else:
        assert "unknown_outcome" not in meta  # {} would make the UI report unknown.
    assert meta.get("cancelled", False) == cancelled
    first, second = meta["tool_calls"]
    assert first["duration_ms"] == 0
    assert "arguments" not in first
    assert first["result"]["approval_operation_id"] == "op-1"
    assert first["result"]["presentation"]["command_results"] == [{"command": "display version", "complete": False}]
    observation = second["result"]["observations"][0]["result"]
    assert observation["subtask_id"] == "sub-1"
    assert observation["tracking"]["auto_polling"] == "stopped"
    assert observation["progress"]["tool_results"] == 1


def test_display_projection_is_bounded_and_removes_credentials_and_raw_output():
    from agent.runtime.message_projection import MAX_TOOL_CALLS, message_display_metadata
    secret = "test-credential-value"
    call = {
        "tool_id": "test.tool", "call_id": "call", "ok": True, "duration_ms": -1,
        "summary": f"password={secret} " + "x" * 20_000,
        "arguments": {"password": secret},
        "result": {"output": "raw payload", "presentation": {
            "password": secret, "source_config": "raw config", "headers": {"Authorization": secret},
            "diagnostic": {"summary": f"password={secret}", "private_key": secret,
                           "next_step": "/Users/example/private-file"},
            "devices": [{"name": "x" * 20_000, "raw_output": "raw payload"}] * 1000,
        }},
    }
    meta = message_display_metadata(SimpleNamespace(metadata={}, tool_calls=[call] * 1000, errors=[]), [])
    encoded = json.dumps(meta)
    assert secret not in encoded
    assert "/Users/example" not in encoded
    assert "raw payload" not in encoded and "raw config" not in encoded
    assert len(meta["tool_calls"]) == MAX_TOOL_CALLS
    assert meta["tool_calls_truncated"] == 1000 - MAX_TOOL_CALLS
    assert len(encoded) < 150_000
    assert len(meta["tool_calls"][0]["summary"]) <= 513
    assert "duration_ms" not in meta["tool_calls"][0]


def test_legacy_message_does_not_gain_synthetic_display_facts():
    from storage.message_store import SessionMessageStore
    store = SessionMessageStore(session_id="session-legacy", ws_id="default")
    store.write_message("run-legacy", "assistant", "历史回复", metadata={"intent": "chat"})
    meta = store.get_messages()[0]["metadata"]
    for key in ("execution_outcome", "unknown_outcome", "tool_execution_outcome", "tool_calls",
                "task_id", "cancelled", "output_artifacts"):
        assert key not in meta
