"""Approval continuation restores executable state without replaying operations."""

import asyncio
from copy import deepcopy

import pytest

from agent.llm.schemas import LLMMessage, LLMResponse, LLMToolCall
from core.runtime_engine.budget_controller import BudgetController
from core.runtime_engine.cognitive_state import initialize_cognitive_state
from core.runtime_engine.context_continuation import ContextContinuation
from core.runtime_engine.loop_messages import serialize_loop_message, serialize_streaming_tool_result
from core.runtime_engine.models import SSOTRuntimeConfig, StatelessContext
from core.runtime_engine.query_loop import QueryLoop, StreamingToolResult
from core.runtime_engine.tool_runtime import ToolRuntime


def _ctx(extras=None):
    return StatelessContext("test", "approval", "request", "继续原任务", extras=extras or {})


def _registry():
    return {"data.manage": {
        "args_schema": {"type": "object", "properties": {
            "action": {"type": "string"}, "text": {"type": "string"},
            "rows": {"type": "array"},
        }},
        "metadata": {"bindable_inputs": {"stats": ["rows"]},
                     "referenceable_outputs": {"parse": ["rows"], "stats": ["rows"]}},
    }}


def test_pause_checkpoint_then_resume_consumes_preapproval_and_approved_results(monkeypatch):
    import extensions.approval.service as approval

    checkpoint = {}

    def save(_workspace, **kwargs):
        checkpoint.update(deepcopy(kwargs))
        return {"checkpoint_id": "checkpoint-test", "operation_ids": ["op-test"]}

    monkeypatch.setattr(approval, "attach_continuation_checkpoint", save)
    config = SSOTRuntimeConfig(max_llm_calls=8, max_retries_per_node=0)
    runtime = ToolRuntime(config)
    executed = []

    def handler(args):
        executed.append(deepcopy(args))
        if args["action"] == "parse":
            return {"ok": True, "rows": [42]}
        if args["rows"] == [42]:
            return {"ok": False, "status": "waiting_external_input",
                    "external_interruption": {"interruption_id": "op-test"}}
        return {"ok": True, "received": args["rows"]}

    runtime.register("data.manage", handler)
    proposals = iter([
        LLMResponse(tool_calls=[LLMToolCall(
            id="provider-source", name="data.manage", step_id="source",
            arguments={"action": "parse", "text": "42"},
        )]),
        LLMResponse(tool_calls=[LLMToolCall(
            id="provider-approval", name="data.manage", step_id="approved",
            arguments={"action": "stats"}, depends_on=["source"],
            result_bindings={"rows": "steps.source.output.rows"}, goal_ids=["saved-goal"],
        )]),
    ])
    loop = QueryLoop(config, _registry(), runtime, llm_invoke=lambda **_: next(proposals))
    paused = asyncio.run(loop.run(_ctx(), BudgetController(config), None))
    assert paused.metrics["response_outcome"] == "waiting_external_input"
    saved_call = checkpoint["tool_calls"][0]
    assert saved_call["step_id"] == "approved"
    assert saved_call["depends_on"] == ["source"]
    assert saved_call["result_bindings"] == {"rows": "steps.source.output.rows"}
    assert saved_call["goal_ids"] == ["saved-goal"]
    state = checkpoint["context_window_state"]["runtime_orchestration"]
    assert state["version"] == 1 and state["depths"] == {"source": 1, "approved": 2}

    checkpoint["operations"] = [{"call_id": "provider-approval", "status": "executed",
                                  "execution": {"result": {"ok": True, "rows": [84]}}}]
    followups = iter([
        LLMResponse(tool_calls=[LLMToolCall(
            id="provider-consume", name="data.manage", step_id="consume",
            arguments={"action": "stats"}, depends_on=["source", "approved"],
            result_bindings={"rows": "steps.approved.output.rows"},
        )]),
        LLMResponse(content="已使用审批结果，原步骤没有重跑。"),
    ])
    resumed_ctx = _ctx({"approval_continuation_resume": checkpoint})
    resumed = asyncio.run(QueryLoop(
        config, _registry(), runtime, llm_invoke=lambda **_: next(followups),
    ).run(resumed_ctx, BudgetController(config), None))
    assert resumed.error is None
    assert [args["rows"] for args in executed if "rows" in args] == [[42], [84]]
    assert len(executed) == 3
    assert resumed_ctx.extras["orchestration_depths"]["consume"] == 3
    assert resumed_ctx.extras["orchestration_evidence"]["approved"].output["rows"] == [84]
    assert any(item["call_id"] == "provider-approval" and item["status"] == "succeeded"
               for item in resumed_ctx.extras["goal_loop_observations"])
    assert any(item["source_call_id"] == "provider-source" for item in resumed_ctx.extras["evidence_ledger"])


@pytest.mark.parametrize("status,ok", [("executed", True), ("unknown", False)])
def test_legacy_resume_reconstructs_dependency_evidence_without_reexecution(status, ok):
    config = SSOTRuntimeConfig()
    loop = QueryLoop(config, _registry(), object())
    ctx = _ctx()
    loop._context_continuation = ContextContinuation(loop._build_initial(ctx))
    prior = StreamingToolResult("data.manage", "old-provider", {"rows": [42], "_runtime_readback": {"action": "parse"}, "_orchestration": {
        "step_id": "source", "depends_on": [],
    }}, True)
    pending = StreamingToolResult("data.manage", "approval-provider", {"_orchestration": {
        "step_id": "approved", "depends_on": ["source"],
    }}, False)
    resume = {
        "messages": [serialize_loop_message(LLMMessage(role="user", content="original task"))],
        "tool_calls": [{"id": "approval-provider", "name": "data.manage", "arguments": {"action": "stats"}}],
        "prior_results": [serialize_streaming_tool_result(prior)],
        "round_results": [serialize_streaming_tool_result(pending)],
        "operations": [{"call_id": "approval-provider", "status": status,
                        "execution": {"result": {"ok": True, "rows": [84]}}}],
    }
    results = []
    loop._resume_approval(ctx, resume, [], results, initialize_cognitive_state(
        turn_id="r", trace_id="r", user_input="continue"))
    assert "approval_resume_error" not in ctx.extras
    assert len(results) == 2
    assert ctx.extras["orchestration_evidence"]["source"].output["rows"] == [42]
    assert ctx.extras["orchestration_evidence"]["approved"].ok is ok
    assert ctx.extras["orchestration_depths"]["approved"] == 2
    call = LLMToolCall(id="next", name="data.manage", step_id="next",
                       arguments={"action": "stats"}, depends_on=["source"],
                       result_bindings={"rows": "steps.source.output.rows"})
    assert loop._prepare_tool_calls(ctx, [call])["ok"] is True


@pytest.mark.parametrize("runtime_state", [
    {"version": 99},
    {"version": 1, "depths": {"source": 0}, "evidence": [{
        "step_id": "source", "call_id": "prior", "tool_id": "data.manage", "ok": True, "output": {},
    }]},
    {"version": 1, "depths": {"source": 1}, "evidence": [{
        "step_id": "source", "call_id": "prior", "tool_id": "data.manage", "ok": True,
        "output": {"_orchestration": {"depends_on": ["missing"]}},
    }]},
])
def test_invalid_approval_checkpoint_fails_closed_before_any_model_or_tool_call(runtime_state):
    calls = []
    config = SSOTRuntimeConfig()
    ctx = _ctx({"approval_continuation_resume": {"context_window_state": {
        "anchors": [{"role": "user", "content": "original"}],
        "runtime_orchestration": runtime_state,
    }, "messages": [{"role": "user", "content": "original"}],
        "tool_calls": [{"id": "x", "name": "data.manage", "arguments": {}}],
        "round_results": [{"call_id": "x", "tool_name": "data.manage", "output": {}, "ok": False}],
    }})
    result = asyncio.run(QueryLoop(config, {}, object(), llm_invoke=lambda **_: calls.append(1)).run(
        ctx, BudgetController(config), None))
    assert result.error == "approval_resume_error" and result.hard_block is True
    assert calls == []
