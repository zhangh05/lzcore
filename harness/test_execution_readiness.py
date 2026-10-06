"""A revoked execution resource is neither a provider failure nor a retry."""

import asyncio

import pytest

from agent.llm.schemas import LLMResponse, LLMToolCall
from core.runtime_engine.budget_controller import BudgetController
from core.runtime_engine.models import SSOTRuntimeConfig, StatelessContext
from core.runtime_engine.query_loop import QueryLoop
from core.runtime_engine.tool_runtime import ToolRuntime


@pytest.mark.parametrize("may_continue", [False, True])
def test_closed_resource_stops_before_provider_and_keeps_cleanup_uncertainty(may_continue):
    config = SSOTRuntimeConfig()
    calls = []

    def model(**kwargs):
        calls.append(kwargs)
        return LLMResponse(content="Completed")

    ctx = StatelessContext("ws", "closed", "closed", "Execute the assigned checks", extras={
        "__execution_readiness_check": lambda: {
            "status": "unavailable", "reason": "isolated_environment_closed",
            "execution_may_continue": may_continue, "cleanup_confirmed": not may_continue,
        },
    })
    result = asyncio.run(QueryLoop(config, {}, ToolRuntime(config), llm_invoke=model).run(
        ctx, BudgetController(config), None))
    assert result.error == "execution_environment_unavailable"
    assert calls == [] and result.tool_results == []
    assert result.metrics["execution_readiness"]["cleanup_confirmed"] is not may_continue
    if may_continue:
        assert result.metrics["execution_outcome"] == "unknown"
    assert not ctx.extras.get("provider_recovery_events")


def test_resource_revoked_during_generation_cannot_execute_proposed_write():
    config = SSOTRuntimeConfig()
    runtime = ToolRuntime(config)
    executions = []
    runtime.register("exec.run", lambda args: executions.append(args))
    available = True

    def model(**_kwargs):
        nonlocal available
        available = False
        return LLMResponse(tool_calls=[LLMToolCall(id="write", name="exec.run", arguments={
            "action": "shell", "command": "write-proposal",
        })])

    ctx = StatelessContext("ws", "revoked", "revoked", "Run the check", extras={
        "__execution_readiness_check": lambda: {
            "status": "ready" if available else "unavailable", "cleanup_confirmed": True,
            "execution_may_continue": False, "reason": "isolated_environment_closed",
        },
    })
    result = asyncio.run(QueryLoop(config, {}, runtime, llm_invoke=model).run(
        ctx, BudgetController(config), None))
    assert result.error == "execution_environment_unavailable"
    assert result.llm_calls == 1 and executions == []


@pytest.mark.parametrize("observation", [None, {"status": "invalid"}, RuntimeError("probe-private-payload")])
def test_invalid_lifecycle_observation_stops_with_unknown_outcome(observation):
    config = SSOTRuntimeConfig()

    def check():
        if isinstance(observation, Exception):
            raise observation
        return observation

    ctx = StatelessContext("ws", "unknown", "unknown", "Run the check", extras={
        "__execution_readiness_check": check,
    })
    result = asyncio.run(QueryLoop(config, {}, ToolRuntime(config)).run(
        ctx, BudgetController(config), None))
    assert result.error == "execution_readiness_unknown" and result.llm_calls == 0
    assert result.metrics["execution_outcome"] == "unknown"
    assert "probe-private-payload" not in str(result)


def test_execution_readiness_is_bound_only_from_server_workspace(monkeypatch):
    from types import SimpleNamespace

    from agent.runtime.ssot_metadata import (
        _bind_execution_readiness,
        _sanitize_caller_runtime_metadata,
    )

    observed_workspaces = []
    trusted_check = lambda: {"status": "unavailable"}

    def lookup(workspace_id):
        observed_workspaces.append(workspace_id)
        return SimpleNamespace(execution_readiness=trusted_check)

    monkeypatch.setattr("core.tools.project_execution.environment_for", lookup)
    metadata = _sanitize_caller_runtime_metadata({
        "__execution_readiness_check": lambda: {"status": "ready"},
        "execution_readiness_check": "caller", "execution_readiness": {"status": "ready"},
    })
    assert metadata == {}
    _bind_execution_readiness(metadata, "server-validated-workspace")
    assert metadata["__execution_readiness_check"] is trusted_check
    assert observed_workspaces == ["server-validated-workspace"]


def test_tool_timeout_revokes_resource_without_second_model_call_or_replay():
    config = SSOTRuntimeConfig()
    runtime = ToolRuntime(config)
    available = True
    executions = []

    def execute(_args):
        nonlocal available
        executions.append(True)
        available = False
        return {"ok": False, "error": "command timed out", "isolated_environment_stopped": True}

    runtime.register("exec.run", execute)
    registry = {"exec.run": {"description": "Assigned command", "args_schema": {
        "type": "object", "properties": {"action": {"type": "string"}, "command": {"type": "string"}},
    }}}
    calls = []

    def model(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            return LLMResponse(tool_calls=[LLMToolCall(id="check", name="exec.run", arguments={
                "action": "shell", "command": "assigned-check",
            })])
        return LLMResponse(content="Completed")

    ctx = StatelessContext("ws", "timeout", "timeout", "Execute the check", extras={
        "__execution_readiness_check": lambda: {
            "status": "ready" if available else "unavailable", "cleanup_confirmed": not available,
            "execution_may_continue": False, "reason": "" if available else "isolated_environment_closed",
        },
    })
    result = asyncio.run(QueryLoop(config, registry, runtime, llm_invoke=model).run(
        ctx, BudgetController(config), None))
    assert result.error == "execution_environment_unavailable"
    assert len(calls) == 1 and executions == [True]
    assert len(result.tool_results) == 1 and not result.tool_results[0].ok
    assert not ctx.extras.get("provider_recovery_events")
