"""Operational container references survive; host paths and credentials do not."""
import json

from core.tools.project_execution import (
    DockerProjectEnvironment,
    public_container_temp_paths,
)
from core.tools.redaction import redact_tool_output
from storage.context_epoch_store import read_epoch, save_epoch
from storage.redaction import redact_value


def test_container_redaction_preserves_tmp_references_without_exposing_secrets():
    data = {"stdout": "/tmp/noc/server.pid /Users/operator/private.txt /tmp/../../etc/passwd",
            "api_key": "private-canary-value", "nested": ["token=private-canary-value"]}
    for redact in (redact_tool_output, redact_value):
        ordinary = redact(data)
        scoped = redact(data, container_paths=True)
        assert "/tmp/noc/server.pid" not in ordinary["stdout"]
        assert "/tmp/noc/server.pid" in scoped["stdout"]
        assert "/Users/operator" not in str(scoped)
        assert "/tmp/../../etc" not in str(scoped)
        assert "private-canary-value" not in str(scoped)
    assert data["api_key"] == "private-canary-value"


def test_container_visibility_requires_actual_live_server_binding(monkeypatch, tmp_path):
    from core.tools import project_execution
    from storage.paths import workspace_root

    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setattr(project_execution, "environment_for", lambda _ws: None)
    assert not public_container_temp_paths("ws", "exec.run")
    project = workspace_root("ws") / "files/data/project"
    project.mkdir(parents=True)
    monkeypatch.setenv("LZCORE_CODING_DOCKER_COMMAND", '["unused-test-docker-client"]')
    environment = DockerProjectEnvironment("ws", project, 18879)
    environment.image_id = "sha256:" + "a" * 64
    environment.started = True
    monkeypatch.setattr(project_execution, "environment_for", lambda _ws: environment)
    assert public_container_temp_paths("ws", "exec.run")
    assert public_container_temp_paths("ws", "system.manage", "context_read")
    assert not public_container_temp_paths("ws", "system.manage", "local_info")
    assert not public_container_temp_paths("ws", "workspace.file", "read")
    environment.closed = True
    assert not public_container_temp_paths("ws", "exec.run")


def test_archive_preserves_only_container_tool_references_and_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    args = json.dumps({"action": "shell", "command": "cat /tmp/noc/server.pid"})
    call = {"id": "read", "function": {"name": "exec__run", "arguments": args}}
    messages = [
        {"role": "user", "content": "host input /tmp/private-user-file"},
        {"role": "assistant", "content": "", "tool_calls": [call],
         "protocol": {"openai": {"tool_calls": [call]}, "anthropic": [
             {"type": "tool_use", "name": "exec__run", "input": json.loads(args)}]}},
        {"role": "tool", "tool_call_id": "read", "content": json.dumps({
            "stdout": "/tmp/noc/server.pid", "api_key": "private-canary-value"})},
        {"role": "tool", "tool_call_id": "host-tool", "content": "/tmp/private-host-file"},
    ]
    scoped = save_epoch("ws", "session", "request", messages, {}, container_paths=True)
    stored = read_epoch("ws", "session", scoped["checkpoint_id"])["payload"]["messages"]
    assert "/tmp/private-user-file" not in stored[0]["content"]
    assert json.loads(stored[1]["tool_calls"][0]["function"]["arguments"]) == json.loads(args)
    assert stored[1]["protocol"]["openai"]["tool_calls"][0]["function"]["arguments"] == args
    assert stored[1]["protocol"]["anthropic"][0]["input"] == json.loads(args)
    assert json.loads(stored[2]["content"])["stdout"] == "/tmp/noc/server.pid"
    assert "private-canary-value" not in str(stored)
    assert "/tmp/private-host-file" not in stored[3]["content"]
    default = save_epoch("ws", "session", "ordinary", messages, {})
    assert "/tmp/noc/server.pid" not in str(default)
