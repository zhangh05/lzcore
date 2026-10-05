"""A proposed final answer must satisfy trusted completion observations."""

import asyncio
from types import SimpleNamespace

import pytest

from agent.llm.schemas import LLMResponse, LLMToolCall
from agent.runtime.ssot_metadata import _apply_runtime_control, _sanitize_caller_runtime_metadata
from core.runtime_engine.budget_controller import BudgetController
from core.runtime_engine.completion import observe_completion
from core.runtime_engine.models import SSOTRuntimeConfig, StatelessContext, SubagentRuntimeControl
from core.runtime_engine.query_loop import QueryLoop
from core.runtime_engine.tool_runtime import ToolRuntime


def test_failed_completion_keeps_same_worker_open_for_governed_repair():
    config = SSOTRuntimeConfig(max_llm_calls=5)
    runtime = ToolRuntime(config)
    repaired = []

    def repair(_args):
        repaired.append(True)
        return {"ok": True, "rows": ["repaired"]}

    runtime.register("data.manage", repair)
    registry = {"data.manage": {"description": "repair", "args_schema": {
        "type": "object", "properties": {"action": {"type": "string"}}}}}
    responses = [LLMResponse(content="I will finish later"),
                 LLMResponse(tool_calls=[LLMToolCall(id="repair", name="data.manage",
                             arguments={"action": "parse", "text": "repair"})]),
                 LLMResponse(content="Completed after repair")]
    calls = []

    def model(**kwargs):
        calls.append(kwargs)
        return responses.pop(0)

    ctx = StatelessContext("ws", "same-worker", "completion", "Finish the task", extras={
        "__completion_check": lambda: {"status": "passed" if repaired else "failed",
                                        "checks": [{"exit_code": 0 if repaired else 1}]}})
    result = asyncio.run(QueryLoop(config, registry, runtime, llm_invoke=model).run(
        ctx, BudgetController(config), None))
    assert result.error is None and result.final_response == "Completed after repair"
    assert len(repaired) == 1 and len(calls) == 3
    assert [event["status"] for event in ctx.extras["completion_events"]] == ["failed", "passed"]
    assert len(result.tool_results) == 1  # Server observations are not invented model tool results.


def test_unknown_completion_stops_without_retry_or_a_second_model_call():
    config = SSOTRuntimeConfig(max_llm_calls=5)
    calls = []

    def model(**kwargs):
        calls.append(kwargs)
        return LLMResponse(content="Done")

    ctx = StatelessContext("ws", "unknown", "unknown", "Finish", extras={
        "__completion_check": lambda: {"status": "unknown", "automatic_retry_allowed": False}})
    result = asyncio.run(QueryLoop(config, {}, object(), llm_invoke=model).run(
        ctx, BudgetController(config), None))
    assert result.error == "completion_outcome_unknown" and len(calls) == 1
    assert result.metrics["execution_outcome"] == "unknown"


def test_caller_cannot_forge_completion_callback():
    callback = lambda: {"status": "passed"}
    clean = _sanitize_caller_runtime_metadata({"completion_check": callback,
                                              "__completion_check": callback})
    assert not clean
    _apply_runtime_control(clean, {"completion_check": callback})
    assert not clean
    _apply_runtime_control(clean, SubagentRuntimeControl(completion_check=callback))
    assert clean["__completion_check"] is callback


@pytest.mark.parametrize("observation", [None, {"status": "unrecognized"}])
def test_invalid_completion_is_unknown_not_passed(observation):
    ctx = SimpleNamespace(extras={"__completion_check": lambda: observation})
    result = asyncio.run(observe_completion(ctx))
    assert result["status"] == "unknown" and not result["automatic_retry_allowed"]


def test_repeated_completion_promises_stop_without_replaying_checks():
    config = SSOTRuntimeConfig(max_llm_calls=10)
    model_calls, checks = [], []

    def model(**kwargs):
        model_calls.append(kwargs)
        return LLMResponse(content='Continuing implementation and fixing the build.')

    def check():
        checks.append(True)
        return {'status': 'failed', 'checks': [{'exit_code': 1}]}

    ctx = StatelessContext('ws', 'no-action', 'completion', 'Complete implementation', extras={
        '__completion_check': check})
    result = asyncio.run(QueryLoop(config, {}, object(), llm_invoke=model).run(
        ctx, BudgetController(config), None))
    assert result.error == 'completion_no_action'
    assert result.metrics['execution_outcome'] == 'failed'
    assert len(model_calls) == 3 and len(checks) == 1
    assert not result.tool_results
    assert ctx.extras['completion_events'][-1]['repair_stalled']


def test_real_tool_observation_resets_no_action_recovery():
    checks = []
    def check():
        checks.append(True)
        return {'status': 'failed'}
    ctx = SimpleNamespace(extras={'__completion_check': check})
    asyncio.run(observe_completion(ctx, 0))
    assert asyncio.run(observe_completion(ctx, 0))['no_action_replies'] == 1
    assert not asyncio.run(observe_completion(ctx, 1)).get('repair_stalled')
    assert asyncio.run(observe_completion(ctx, 1))['no_action_replies'] == 1
    assert len(checks) == 2
