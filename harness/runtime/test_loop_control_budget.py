"""R2: bounded stalls, cancellation precedence and explicit delegation budgets."""

import asyncio
import threading
from types import SimpleNamespace

import pytest

from agent.llm.schemas import LLMResponse, LLMToolCall
from core.runtime_engine.budget_controller import BudgetController
from core.runtime_engine.loop_tracking import NO_PROGRESS_LIMIT
from core.runtime_engine.models import SSOTRuntimeConfig, StatelessContext
from core.runtime_engine.query_loop import QueryLoop
from core.runtime_engine.tool_runtime import ToolRuntime


def registry():
    return {"data.manage": {"description": "observe", "args_schema": {
        "type": "object", "properties": {
            "action": {"type": "string", "enum": ["parse", "stats"]},
            "text": {"type": "string"}, "rows": {"type": "array"},
        }, "required": ["action"],
    }}}


def context(**extras):
    return StatelessContext("r2-test", "session", "request", "Observe evidence", extras=extras)


def run_model(model, *, config=None, ctx=None, handler=None):
    config = config or SSOTRuntimeConfig()
    runtime = ToolRuntime(config)
    runtime.register("data.manage", handler or (lambda _: {"ok": True, "rows": [7]}))
    return asyncio.run(QueryLoop(config, registry(), runtime, llm_invoke=model).run(
        ctx or context(), BudgetController(config), None))


@pytest.mark.parametrize("kind", ["invalid", "empty_truncated", "repeated_prefix", "repeated_read", "failure", "noop", "batch"])
def test_stalled_rounds_stop_without_caller_budget(kind):
    calls = []
    ctx = context(cancel_check=lambda: len(calls) > NO_PROGRESS_LIMIT + 2)
    if kind == "batch":
        ctx.user_input = "禁止批量调用，每个目标独立处理"

    def model(**_):
        calls.append(True)
        assert len(calls) <= NO_PROGRESS_LIMIT + 2, "unbounded stalled loop"
        if kind in {"empty_truncated", "repeated_prefix"}:
            return LLMResponse(content="prefix" if kind == "repeated_prefix" else "",
                               metadata={"output_truncated": True})
        action = "invalid" if kind == "invalid" else "parse_batch" if kind == "batch" else "parse"
        arguments = {"action": action, "text": "same input"}
        if kind == "failure":
            arguments["text"] = f"changed request with no new failure evidence {len(calls)}"
        if len(calls) % 2:
            arguments = dict(reversed(list(arguments.items())))
        return LLMResponse(tool_calls=[LLMToolCall(
            id=f"changing-id-{len(calls)}", name="data.manage",
            arguments=arguments)])

    result = run_model(model, ctx=ctx, config=SSOTRuntimeConfig(max_retries_per_node=0), handler=lambda _: (
        {"ok": False, "error": "same failure"} if kind == "failure"
        else {"ok": True, "rows": [7], "changed": False}))
    assert result.error == "loop_no_progress", [r.output for r in result.tool_results]
    assert result.metrics["response_outcome"] == "incomplete"
    assert result.metrics["execution_outcome"] != "complete"
    assert ctx.extras["loop_no_progress"]["consecutive_rounds"] == NO_PROGRESS_LIMIT
    assert len(calls) <= NO_PROGRESS_LIMIT + 1


def test_new_evidence_resets_stall_counter_and_keeps_unbounded_default():
    calls = []
    observations = iter([1, 1, 1, 2, 2, 2, 3, 3, 3, 4])

    def model(**_):
        calls.append(True)
        return LLMResponse(content="Done") if len(calls) == 11 else LLMResponse(tool_calls=[
            LLMToolCall(id=f"call-{len(calls)}", name="data.manage",
                        arguments={"action": "parse", "text": "same input"})])

    result = run_model(model, handler=lambda _: {"ok": True, "rows": [next(observations)]})
    assert result.error is None and len(calls) == 11
    assert len(result.tool_results) == 10


def test_fixed_invalid_arguments_can_be_corrected_before_stall_limit():
    responses = iter([
        *[LLMResponse(tool_calls=[LLMToolCall(id=str(i), name="data.manage",
                                            arguments={"action": "invalid"})]) for i in range(2)],
        LLMResponse(tool_calls=[LLMToolCall(id="fixed", name="data.manage",
                                          arguments={"action": "parse", "text": "valid"})]),
        LLMResponse(content="Done"),
    ])
    result = run_model(lambda **_: next(responses))
    assert result.error is None
    assert result.tool_results[-1].ok


@pytest.mark.parametrize("when", ["before", "during", "on_pass"])
def test_completion_cancellation_has_priority(when):
    cancelled, entered, release = threading.Event(), threading.Event(), threading.Event()
    checks = []

    def check():
        checks.append(True)
        entered.set()
        if when == "on_pass":
            cancelled.set()
        elif when == "during":
            assert release.wait(3)
        return {"status": "passed"}

    async def scenario():
        config = SSOTRuntimeConfig()
        ctx = context(cancel_check=cancelled.is_set, __completion_check=check)
        if when == "before":
            cancelled.set()
        task = asyncio.create_task(QueryLoop(config, {}, object(), llm_invoke=lambda **_: LLMResponse(
            content="Successful prose")).run(ctx, BudgetController(config), None))
        try:
            if when == "during":
                for _ in range(100):
                    if entered.is_set():
                        break
                    await asyncio.sleep(0.005)
                assert entered.is_set()
                cancelled.set()
            result = await asyncio.wait_for(task, timeout=1)
            assert result.error == "cancelled_by_user"
            assert result.metrics["response_outcome"] == "cancelled"
            assert result.final_response != "Successful prose"
            if when == "before":
                assert checks == []
            if when == "during":
                assert ctx.extras["completion_observation"]["check_may_continue"] is True
        finally:
            release.set()

    asyncio.run(scenario())


def test_completion_timeout_is_unknown_and_late_pass_cannot_replace_it(monkeypatch):
    import core.runtime_engine.completion as completion
    monkeypatch.setattr(completion, "COMPLETION_CHECK_TIMEOUT_SECONDS", 0.02)
    release = threading.Event()

    def check():
        assert release.wait(3)
        return {"status": "passed"}

    async def scenario():
        ctx = context(__completion_check=check)
        try:
            result = await completion.observe_completion(ctx)
            assert result["status"] == "unknown"
            assert result["error"] == "completion_check_timeout"
            assert result["check_may_continue"] and not result["automatic_retry_allowed"]
        finally:
            release.set()
        await asyncio.sleep(0.01)
        assert ctx.extras["completion_observation"]["status"] == "unknown"

    asyncio.run(scenario())


def test_completion_remembers_cancel_when_budget_expires_at_same_time():
    config = SSOTRuntimeConfig(max_total_seconds=1)
    budget = BudgetController(config)
    signal = [False]

    def cancel_check():
        received = signal[0]
        signal[0] = False
        return received

    def check():
        signal[0] = True
        budget._start_time -= 2
        return {"status": "passed"}

    ctx = context(cancel_check=cancel_check, __completion_check=check)
    result = asyncio.run(QueryLoop(config, {}, object(), llm_invoke=lambda **_: LLMResponse(content="Done")).run(
        ctx, budget, None))
    assert result.error == "cancelled_by_user"
    assert result.metrics["response_outcome"] == "cancelled"


@pytest.mark.parametrize("stage", ["completion", "provider"])
def test_sync_bridge_returns_before_slow_observer_or_provider_finishes(monkeypatch, stage):
    from agent.runtime.ssot_provider import _run_async
    from core.runtime_engine.completion import observe_completion
    import core.runtime_engine.completion as completion

    release, returned = threading.Event(), threading.Event()
    results, errors = [], []

    def slow(**kwargs):
        assert release.wait(3)
        return {"status": "passed"} if stage == "completion" else LLMResponse(content="Late success")

    def bridge():
        try:
            if stage == "completion":
                results.append(_run_async(observe_completion(context(__completion_check=slow))))
            else:
                config = SSOTRuntimeConfig(max_total_seconds=0.02)
                results.append(_run_async(QueryLoop(config, {}, object(), llm_invoke=slow).run(
                    context(), BudgetController(config), None)))
        except BaseException as exc:
            errors.append(exc)
        finally:
            returned.set()

    monkeypatch.setattr(completion, "COMPLETION_CHECK_TIMEOUT_SECONDS", 0.02)
    thread = threading.Thread(target=bridge)
    thread.start()
    try:
        assert returned.wait(1), "sync bridge waited for the detached worker"
        assert not errors
        if stage == "completion":
            assert results[0]["status"] == "unknown" and results[0]["check_may_continue"]
        else:
            assert results[0].error == "budget_exhausted"
    finally:
        release.set()
        thread.join(3)


def test_tool_time_budget_preserves_completed_result_and_stops_next_model_call():
    config = SSOTRuntimeConfig(max_tool_seconds=1)
    budget = BudgetController(config)
    runtime = ToolRuntime(config)
    calls = []

    def tool(_):
        budget._tool_stage_started_at -= 2
        return {"ok": True, "rows": [7]}

    def model(**_):
        calls.append(True)
        return LLMResponse(tool_calls=[LLMToolCall(id="read", name="data.manage",
            arguments={"action": "parse", "text": "evidence"})])

    runtime.register("data.manage", tool)
    result = asyncio.run(QueryLoop(config, registry(), runtime, llm_invoke=model).run(context(), budget, None))
    assert result.error == "budget_exhausted" and len(calls) == 1
    assert result.metrics["budget_exhausted"] == "MAX_TOOL_SECONDS"
    assert result.tool_results[0].ok and result.tool_results[0].output["rows"] == [7]


def test_explicit_llm_budget_stops_next_call_and_preserves_evidence():
    calls = []

    def model(**_):
        calls.append(True)
        return LLMResponse(tool_calls=[LLMToolCall(id="read", name="data.manage",
            arguments={"action": "parse", "text": "evidence"})])

    result = run_model(model, config=SSOTRuntimeConfig(max_llm_calls=1))
    assert result.error == "budget_exhausted"
    assert result.metrics["budget_exhausted"] == "MAX_LLM_CALLS"
    assert len(calls) == result.llm_calls == 1
    assert result.tool_results[0].ok


def test_last_allowed_llm_call_can_complete_normally():
    result = run_model(lambda **_: LLMResponse(content="Done"),
                       config=SSOTRuntimeConfig(max_llm_calls=1))
    assert result.error is None and result.final_response == "Done"


@pytest.mark.parametrize("field,reason", [("max_total_seconds", "MAX_TOTAL_SECONDS"),
                                         ("max_tool_seconds", "MAX_TOOL_SECONDS")])
def test_positive_time_budget_expires_with_no_real_wait(field, reason):
    budget = BudgetController(SSOTRuntimeConfig(**{field: 1}))
    if field == "max_total_seconds":
        budget._start_time -= 2
    else:
        budget.begin_execution()
        budget._tool_stage_started_at -= 2
    assert not budget.check_execution().ok
    assert budget.exceeded == reason
    assert budget.remaining_execution_seconds() == 0


def test_node_budget_reservation_is_atomic_and_zero_is_unbounded():
    budget = BudgetController(SSOTRuntimeConfig(max_nodes=1))
    assert not budget.reserve_execution_batch(node_count=2, depth=1, parallel_width=1).ok
    assert budget.nodes_used == 0 and budget.remaining_node_capacity() == 1
    unlimited = BudgetController(SSOTRuntimeConfig())
    for _ in range(5):
        assert unlimited.check_llm_call().ok
        assert unlimited.reserve_execution_batch(node_count=100, depth=100, parallel_width=1).ok
    assert unlimited.llm_calls == 5 and unlimited.nodes_used == 500


def test_provider_wait_is_capped_by_explicit_deadline(monkeypatch):
    delays, calls = [], []
    config = SSOTRuntimeConfig(max_total_seconds=1)
    budget = BudgetController(config)

    async def wait(self, ctx, seconds):
        delays.append(seconds)
        budget._start_time -= seconds
        return False

    def model(**_):
        calls.append(True)
        return LLMResponse(error="provider_timeout")

    monkeypatch.setattr(QueryLoop, "_sleep_until_poll_or_cancel", wait)
    result = asyncio.run(QueryLoop(config, {}, object(), llm_invoke=model).run(context(), budget, None))
    assert result.error == "budget_exhausted"
    assert len(calls) == 3
    assert delays == pytest.approx([0.25, 0.5, 0.25], abs=0.05)


def test_explicit_deadline_interrupts_pending_provider_await(monkeypatch):
    from core.runtime_engine.loop_model import LoopModelGateway

    async def pending(self, messages, ctx, **kwargs):
        await asyncio.Event().wait()

    monkeypatch.setattr(LoopModelGateway, "_call_llm", pending)
    result = run_model(lambda **_: None, config=SSOTRuntimeConfig(max_total_seconds=0.02))
    assert result.error == "budget_exhausted"
    assert result.metrics["budget_exhausted"] == "MAX_TOTAL_SECONDS"


def test_synthesis_recovery_cannot_bypass_explicit_llm_budget():
    responses = iter([
        LLMResponse(tool_calls=[LLMToolCall(id="read", name="data.manage",
                                          arguments={"action": "parse", "text": "evidence"})]),
        LLMResponse(),
    ])
    result = run_model(lambda **_: next(responses), config=SSOTRuntimeConfig(max_llm_calls=2))
    assert result.error == "budget_exhausted"
    assert result.llm_calls == 2 and result.tool_results[0].ok


def test_engine_assembly_preserves_binding_and_batching_through_execution(monkeypatch):
    from agent.runtime import ssot_runtime

    seen = []

    class Client:
        def canonicalize_arguments(self, tool_id, args):
            return args

        def invoke(self, tool_id, args, **kwargs):
            seen.append((tool_id, args))
            output = {"ok": True, "rows": [{"value": 7}]} if args["action"] == "parse" else {"ok": True}
            return SimpleNamespace(output=output, status="succeeded", summary="",
                artifact_ids=[], warnings=[], errors=[], duration_ms=0, redacted=False)

    catalog = registry()
    catalog["data.manage"]["metadata"] = {"bindable_inputs": {"stats": ["rows"]},
        "referenceable_outputs": {"parse": ["rows"]}}
    catalog["web.manage"] = {"description": "weather", "args_schema": {"type": "object"},
        "metadata": {"batching": [{"source_action": "weather", "target_action": "weather_batch",
            "collect_arg": "location", "collection_arg": "locations", "max_batch_size": 8}]}}
    responses = iter([
        LLMResponse(tool_calls=[
            LLMToolCall(id="source", name="data.manage", arguments={"action": "parse", "text": "value\n7"}, step_id="source"),
            LLMToolCall(id="stats", name="data.manage", arguments={"action": "stats"}, step_id="stats",
                        depends_on=["source"], result_bindings={"rows": "steps.source.output.rows"}),
        ]),
        LLMResponse(tool_calls=[LLMToolCall(id=city, name="web.manage", arguments={"action": "weather", "location": city})
                               for city in ["Beijing", "Shanghai"]]),
        LLMResponse(content="Done"),
    ])
    monkeypatch.setattr(ssot_runtime, "_tool_runtime_client", Client)
    monkeypatch.setattr(ssot_runtime, "_invoke_llm_for_ssot_runtime", lambda **_: next(responses))
    engine = ssot_runtime._build_engine(workspace_id="r2-test", session_id="session", run_id="run",
                                       trace_id="trace", prebuilt_registry=catalog, requested_by="test")
    assert engine._tool_registry["data.manage"]["metadata"] == catalog["data.manage"]["metadata"]
    result = asyncio.run(engine.run("Observe evidence and weather", workspace_id="r2-test", session_id="session"))
    assert result.success, result.errors
    assert seen[1][1]["rows"] == [{"value": 7}]
    assert seen[2] == ("web.manage", {"action": "weather_batch", "locations": ["Beijing", "Shanghai"]})
    assert len(seen) == 3


def test_server_child_budget_is_distinct_from_provider_compatibility(monkeypatch):
    from agent.runtime import ssot_runtime
    monkeypatch.setattr(ssot_runtime, "_tool_runtime_client", lambda: object())
    engine = ssot_runtime._build_engine(workspace_id="r2-test", session_id="session", run_id="run",
        trace_id="trace", prebuilt_registry=registry(), requested_by="subagent",
        max_steps=1, max_tool_nodes=2, max_total_seconds=3)
    assert engine.config.max_llm_calls == 1
    assert engine.config.max_query_loop_iterations == 0
    assert engine.config.max_nodes == 2 and engine.config.max_total_seconds == 3


@pytest.mark.parametrize("limit,expected_calls,expected_tools", [
    ("turns", 1, 1), ("nodes", 2, 1), ("seconds", 1, 0),
])
def test_spawn_enforces_real_child_runtime_budget(monkeypatch, limit, expected_calls, expected_tools):
    from agent.runtime import ssot_runtime
    from agent.runtime.durable.subagent import BUILTIN_PROFILES, get_subagent_task
    from core.runtime_engine import engine as engine_module
    from core.tools.general_tools.agent_tools import handle_agent_spawn
    from core.tools.schemas import ToolInvocation

    calls, invocations = [], []
    budgets, runtime_results = [], []
    original_run = ssot_runtime.run_ssot_turn

    def run(*args, **kwargs):
        result = original_run(*args, **kwargs)
        runtime_results.append(result)
        return result

    monkeypatch.setattr(ssot_runtime, "run_ssot_turn", run)
    if limit == "nodes":
        monkeypatch.setattr(BUILTIN_PROFILES["research_agent"], "max_tool_nodes", 1)
    if limit == "seconds":
        monkeypatch.setattr(BUILTIN_PROFILES["research_agent"], "max_runtime_seconds", 1)

    def make_budget(config):
        budget = BudgetController(config)
        budgets.append(budget)
        return budget

    monkeypatch.setattr(engine_module, "BudgetController", make_budget)

    class Client:
        def canonicalize_arguments(self, tool_id, args):
            return args

        def invoke(self, tool_id, args, **kwargs):
            invocations.append(args)
            return SimpleNamespace(output={"ok": True, "rows": [7]}, status="succeeded", summary="",
                artifact_ids=[], warnings=[], errors=[], duration_ms=0, redacted=False)

    def model(**_):
        calls.append(True)
        if limit == "seconds":
            budgets[0]._start_time -= 2
        return LLMResponse(tool_calls=[LLMToolCall(id=f"read-{len(calls)}", name="data.manage",
            arguments={"action": "parse", "text": f"observation {len(calls)}"})])

    monkeypatch.setattr(ssot_runtime, "_tool_runtime_client", Client)
    monkeypatch.setattr(ssot_runtime, "_build_ssot_runtime_tool_registry", lambda *_: registry())
    monkeypatch.setattr(ssot_runtime, "_invoke_llm_for_ssot_runtime", model)
    result = handle_agent_spawn(ToolInvocation(tool_id="agent.manage", workspace_id="r2-child",
        session_id="parent", arguments={"action": "spawn", "profile_id": "research_agent",
        "instruction": "Observe evidence", "max_turns": 1 if limit == "turns" else 0, "background": False}))
    assert result["task_status"] == "failed", result
    snapshot = get_subagent_task("r2-child", result["subtask_id"], inspect_source=False)
    assert snapshot["status"] == "failed"
    assert any("budget_exhausted" in error for error in snapshot["errors"])
    assert len(calls) == expected_calls and len(invocations) == expected_tools
    metadata = runtime_results[0].metadata["ssot_runtime"]
    assert metadata["response_outcome"] == "budget_exhausted"
    assert metadata["budget_exhausted"] == {
        "turns": "MAX_LLM_CALLS", "nodes": "MAX_NODES", "seconds": "MAX_TOTAL_SECONDS",
    }[limit]
    assert metadata["structured_errors"][0]["code"] == {
        "turns": "BUDGET_LLM_EXCEEDED", "nodes": "BUDGET_NODES_EXCEEDED", "seconds": "BUDGET_TIME_EXCEEDED",
    }[limit]
