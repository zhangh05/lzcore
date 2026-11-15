from __future__ import annotations

import asyncio
import threading
import subprocess
import pytest


@pytest.mark.parametrize("has_callback", [False, True])
def test_direct_client_binds_cancel_callback_and_restores_parent_gate(has_callback):
    from core.tools.client import ToolRuntimeClient
    from core.tools.context import (ToolRuntimeContext, bind_runtime_cancel_check,
                                   reset_runtime_cancel_check, get_runtime_cancel_check)
    from core.tools.canonical_registry import to_tool_specs
    from core.tools.registry import ToolRegistry

    spec = next(spec for spec, _ in to_tool_specs() if spec.tool_id == "workspace.metadata.get")
    from core.tools.manifest_registry import get_manifest
    caller = get_manifest(spec.tool_id).allowed_callers[0]
    registry = ToolRegistry()
    def inspect_gate(_inv):
        gate = get_runtime_cancel_check()
        return {"ok": True, "cancel_observed": gate()}
    registry.register_tool(spec, inspect_gate)
    parent = lambda: False
    token = bind_runtime_cancel_check(parent)
    try:
        result = ToolRuntimeClient(registry).invoke(spec.tool_id, {}, context=ToolRuntimeContext(
            workspace_id="cancel_client", requested_by=caller,
            cancel_check=(lambda: True) if has_callback else None))
        assert result.status == "succeeded"
        assert result.output["cancel_observed"] is has_callback
        assert get_runtime_cancel_check() is parent
    finally:
        reset_runtime_cancel_check(token)


def test_shell_cancelled_before_start_never_dispatches(monkeypatch):
    from core.tools.general_tools.shared import _run_shell

    def unexpected_start(*_args, **_kwargs):
        raise AssertionError("cancelled command was dispatched")

    monkeypatch.setattr(subprocess, "Popen", unexpected_start)
    result = _run_shell("controlled command", cancel_check=lambda: True)
    assert result["error_code"] == "TOOL_CANCELLED"
    assert result["executed"] is False


def test_shell_timeout_retains_redacted_partial_output_and_uncertainty(monkeypatch):
    from core.tools.general_tools import shared, process_manager

    calls, timeouts = [], []
    class Process:
        pid = 424242
        def communicate(self, timeout):
            timeouts.append(timeout)
            if len(timeouts) == 1:
                raise subprocess.TimeoutExpired("fixture", 1)
            return "已完成部分操作\napi_key=fixture_sensitive_value\n", "等待超时"
        def kill(self):
            calls.append("kill")
        def wait(self, timeout):
            calls.append("wait")

    clock = iter([0, 0, 2])
    monkeypatch.setattr(shared.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(subprocess, "Popen", lambda *_a, **_k: Process())
    monkeypatch.setattr(process_manager, "kill_process_tree", lambda pid: calls.append(pid) or True)
    result = shared._run_shell("controlled command", timeout=1)
    assert not result["ok"] and result["executed"]
    assert result["execution_may_continue"] and result["automatic_retry_allowed"] is False
    assert result["error_code"] == "TOOL_TIMEOUT_UNCERTAIN"
    assert "已完成部分操作" in result["stdout"] and "等待超时" in result["stderr"]
    assert "fixture_sensitive_value" not in result["stdout"]
    assert 424242 in calls and len(timeouts) == 2


def test_shell_execution_cooperatively_cancels_process_tree(tmp_path):
    from core.tools.general_tools.shared import _run_shell

    cancelled = threading.Event()
    setter = threading.Timer(0.15, cancelled.set)
    setter.start()
    try:
        result = _run_shell(
            "python3 -c \"import time; time.sleep(10)\"",
            cwd=str(tmp_path),
            timeout=10,
            cancel_check=cancelled.is_set,
        )
    finally:
        setter.cancel()

    assert result["ok"] is False
    assert result["executed"] is True
    assert result["cancelled"] is True
    assert result["execution_may_continue"] is True
    assert result["automatic_retry_allowed"] is False
    assert result["error_code"] == "TOOL_CANCELLED_UNCERTAIN"
    assert result["process_tree_killed"] is True


def test_shell_execution_honors_runtime_cancel_gate(tmp_path):
    from core.tools.context import bind_runtime_cancel_check, reset_runtime_cancel_check
    from core.tools.general_tools.shared import _run_shell

    cancelled = threading.Event()
    setter = threading.Timer(0.15, cancelled.set)
    setter.start()
    token = bind_runtime_cancel_check(cancelled.is_set)
    try:
        result = _run_shell(
            "python3 -c \"import time; time.sleep(10)\"",
            cwd=str(tmp_path),
            timeout=10,
        )
    finally:
        setter.cancel()
        reset_runtime_cancel_check(token)

    assert result["cancelled"] is True
    assert result["error_code"] == "TOOL_CANCELLED_UNCERTAIN"
    assert result["process_tree_killed"] is True


def test_queryloop_runtime_binds_cancel_callback_to_canonical_invocation():
    from agent.runtime.ssot_runtime import _make_tool_handler
    from core.runtime_engine.models import ExecutionNode, SSOTRuntimeConfig, StatelessContext
    from core.runtime_engine.tool_runtime import ToolRuntime

    seen = {}

    class FakeResult:
        status = "succeeded"
        output = {"ok": True}
        summary = ""
        artifact_ids = []
        warnings = []
        errors = []
        duration_ms = 1
        redacted = False

    class FakeClient:
        def canonicalize_arguments(self, _tool_id, arguments):
            return dict(arguments)

        def invoke(self, tool_id, arguments, *, context):
            seen["tool_id"] = tool_id
            seen["cancel_check"] = context.cancel_check
            return FakeResult()

    cancelled = threading.Event()
    runtime = ToolRuntime(SSOTRuntimeConfig(single_node_timeout_ms=1_000))
    runtime.register(
        "workspace.metadata.get",
        _make_tool_handler(
            client=FakeClient(),
            tool_id="workspace.metadata.get",
            workspace_id="ws-cancel",
            session_id="session-cancel",
            run_id="run-cancel",
            trace_id="trace-cancel",
            requested_by="agent:ssot",
        ),
    )
    ctx = StatelessContext(
        workspace_id="ws-cancel",
        session_id="session-cancel",
        request_id="request-cancel",
        user_input="verify cancellation propagation",
        extras={"cancel_check": cancelled.is_set},
    )

    result = asyncio.run(
        runtime.execute_node(
            ExecutionNode(
                id="call-cancel",
                tool="workspace.metadata.get",
                args={},
            ),
            ctx,
            {},
        )
    )

    assert result.success is True
    assert seen["tool_id"] == "workspace.metadata.get"
    assert callable(seen["cancel_check"])
    assert seen["cancel_check"]() is False


def test_tool_runtime_does_not_start_handler_after_cancellation():
    from core.runtime_engine.models import ExecutionNode, SSOTRuntimeConfig, StatelessContext
    from core.runtime_engine.tool_runtime import ToolRuntime

    invoked = []
    runtime = ToolRuntime(SSOTRuntimeConfig(single_node_timeout_ms=1_000))
    runtime.register("workspace.metadata.get", lambda _args: invoked.append(True) or {"ok": True})
    ctx = StatelessContext(
        workspace_id="ws-cancel",
        session_id="session-cancel",
        request_id="request-cancel-before-start",
        user_input="verify cancellation preflight",
        extras={"cancel_check": lambda: True},
    )

    result = asyncio.run(
        runtime.execute_node(
            ExecutionNode(id="cancel-before-start", tool="workspace.metadata.get", args={}),
            ctx,
            {},
        )
    )

    assert result.success is False
    assert result.error_code == "TOOL_CANCELLED"
    assert result.data["executed"] is False
    assert invoked == []


def test_streaming_result_preserves_handler_uncertainty_for_operation_ledger():
    from core.runtime_engine.models import ToolResult
    from core.runtime_engine.query_loop import StreamingToolExecutor

    result = ToolResult(
        node_id="cancelled-write",
        tool="exec.run",
        success=False,
        data={
            "ok": False,
            "executed": True,
            "execution_may_continue": True,
            "error_code": "TOOL_CANCELLED_UNCERTAIN",
        },
        error="command cancelled after start; outcome requires verification",
        error_code="TOOL_CANCELLED_UNCERTAIN",
    )

    streaming = StreamingToolExecutor._from_tool_result(
        result,
        fallback_call_id="cancelled-write",
    )

    assert streaming.execution_may_continue is True
    assert streaming.output["execution_may_continue"] is True
