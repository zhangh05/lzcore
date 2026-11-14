"""R1 regressions: write claims, causal read-back and terminal truth (all offline)."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from agent.llm.schemas import LLMResponse, LLMToolCall
from core.runtime_engine.budget_controller import BudgetController
from core.runtime_engine.engine import SSOTRuntimeEngine
from core.runtime_engine.loop_messages import StreamingToolResult
from core.runtime_engine.models import SSOTRuntimeConfig, StatelessContext
from core.runtime_engine.operation_ledger import finish_operation, plan_operation, start_operation
from core.runtime_engine.query_loop import QueryLoop, StreamingToolExecutor
from core.runtime_engine.tool_runtime import ToolRuntime


def _ctx():
    return StatelessContext("r1", "session", "turn", "Execute and verify")


def _write(call_id="write", content="a"):
    return LLMToolCall(id=call_id, name="workspace.file", arguments={
        "action": "write", "filename": "example.txt", "content": content,
    })


def _engine(responses, handler=None, tool_id="workspace.file"):
    config = SSOTRuntimeConfig()
    runtime = ToolRuntime(config)
    if handler:
        runtime.register(tool_id, handler)
    registry = {tool_id: {"description": "offline test tool", "args_schema": {
        "type": "object", "properties": {"action": {"type": "string"}},
        "additionalProperties": True,
    }}}
    return SSOTRuntimeEngine(config=config, tool_runtime=runtime, tool_registry=registry,
                             llm_invoke=lambda **_: responses.pop(0))


def test_operation_ledger_claim_is_atomic_and_validates_identity():
    ctx, call = _ctx(), _write()
    operation = plan_operation(ctx, call.name, call.id, call.arguments)
    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda _: start_operation(ctx.workspace_id, operation["operation_id"]), range(2)))
    assert sum(record["execution_claimed"] for record in claims) == 1
    assert not start_operation(ctx.workspace_id, operation["operation_id"])["execution_claimed"]
    with pytest.raises(ValueError, match="operation_identity_conflict"):
        plan_operation(ctx, call.name, call.id, {**call.arguments, "content": "changed"})
    with pytest.raises(ValueError, match="operation_identity_conflict"):
        plan_operation(ctx, "other.tool", call.id, call.arguments)


@pytest.mark.parametrize("state", ["running", "unknown"])
@pytest.mark.parametrize("new_id", ["write", "renamed"])
def test_write_ledger_blocks_inflight_or_unknown_replay(state, new_id):
    ctx, call = _ctx(), _write()
    operation = plan_operation(ctx, call.name, call.id, call.arguments)
    start_operation(ctx.workspace_id, operation["operation_id"])
    if state == "unknown":
        finish_operation(ctx.workspace_id, operation["operation_id"], StreamingToolResult(
            call.name, call.id, {}, False, execution_may_continue=True))
    executions = []
    executor = StreamingToolExecutor(SimpleNamespace(invoke_raw=lambda *args: executions.append(args)))
    result = asyncio.run(executor.execute([_write(new_id)], ctx=ctx))[0]
    assert executions == []
    assert not result.ok and result.execution_may_continue
    assert result.error_code == "OPERATION_OUTCOME_UNKNOWN"
    assert result.output["operation_id"] == operation["operation_id"]
    # A distinct write is still allowed; the fence is not a turn-wide ban.
    different = plan_operation(ctx, call.name, "different", _write(content="b").arguments)
    assert different["operation_id"] != operation["operation_id"]


def test_completed_write_returns_durable_redacted_result_without_execution():
    ctx, call = _ctx(), _write()
    operation = plan_operation(ctx, call.name, call.id, call.arguments)
    start_operation(ctx.workspace_id, operation["operation_id"])
    finish_operation(ctx.workspace_id, operation["operation_id"], StreamingToolResult(
        call.name, call.id, {"ok": True, "value": 42, "password": "test-only-secret"}, True))
    executor = StreamingToolExecutor(SimpleNamespace(invoke_raw=lambda *_: pytest.fail("write replayed")))
    result = asyncio.run(executor.execute([call], ctx=ctx))[0]
    assert result.ok and result.output["value"] == 42
    assert result.output["password"] != "test-only-secret"
    assert result.output["operation_reused"]
    # A new call after a definite completion can express an intentional new write.
    assert plan_operation(ctx, call.name, "new-authorized-write", call.arguments)["status"] == "planned"


def test_ledger_resolution_without_result_fails_closed_instead_of_replaying():
    from core.runtime_engine.operation_ledger import settle_operation
    ctx, call = _ctx(), _write()
    operation = plan_operation(ctx, call.name, call.id, call.arguments)
    settle_operation(ctx.workspace_id, operation["operation_id"], status="succeeded", resolved_by="test")
    executor = StreamingToolExecutor(SimpleNamespace(invoke_raw=lambda *_: pytest.fail("write replayed")))
    result = asyncio.run(executor.execute([call], ctx=ctx))[0]
    assert not result.ok and result.error_code == "OPERATION_RESULT_UNAVAILABLE"


def test_completed_write_is_reused_in_same_executor_context():
    executions = []
    def invoke(*_):
        executions.append(True)
        return {"ok": True, "value": 42}
    executor = StreamingToolExecutor(SimpleNamespace(invoke_raw=invoke))
    ctx, call = _ctx(), _write()
    first = asyncio.run(executor.execute([call], ctx=ctx))[0]
    second = asyncio.run(executor.execute([call], ctx=ctx))[0]
    assert first.ok and second.ok and len(executions) == 1
    assert first.output["value"] == second.output["value"] == 42
    assert second.output["operation_reused"]


def test_ledger_persistence_failure_prevents_write_start(monkeypatch):
    def fail(*_args):
        raise OSError("test storage unavailable")
    monkeypatch.setattr("core.runtime_engine.operation_ledger.atomic_write_json", fail)
    executor = StreamingToolExecutor(SimpleNamespace(invoke_raw=lambda *_: pytest.fail("write started")))
    with pytest.raises(OSError, match="test storage unavailable"):
        asyncio.run(executor.execute([_write()], ctx=_ctx()))


@pytest.mark.parametrize("renamed", [False, True])
def test_query_loop_cannot_replay_unknown_write_after_provider_id_normalization(renamed):
    executed = []
    def handler(args):
        executed.append(args)
        return {"ok": False, "error_code": "TOOL_TIMEOUT_UNCERTAIN", "execution_may_continue": True}
    engine = _engine([
        LLMResponse(tool_calls=[_write()]),
        LLMResponse(tool_calls=[_write("new-id" if renamed else "write")]),
        LLMResponse(content="The write remains unknown; reconcile first."),
    ], handler)
    result = asyncio.run(engine.run("Write once", workspace_id="r1", session_id="test"))
    assert len(executed) == 1
    assert result.metadata["execution_outcome"] == "unknown" and not result.success
    assert result.node_results[list(result.node_results)[-1]].data["operation_reused"]


@pytest.mark.parametrize("partial", [{"partial": True}, {"coverage_status": "partial"}])
def test_runtime_partial_coverage_never_returns_success(partial):
    engine = _engine([LLMResponse(tool_calls=[_write()]), LLMResponse(content="Partial report.")],
                     lambda _: {"ok": True, **partial})
    result = asyncio.run(engine.run("Complete all targets", workspace_id="r1", session_id="partial"))
    assert result.metadata["tool_execution_outcome"] == "partial"
    assert result.metadata["execution_outcome"] == "partial" and not result.success


def test_runtime_empty_final_response_is_failed_but_normal_response_still_succeeds():
    config = SSOTRuntimeConfig()
    ctx = _ctx()
    result = asyncio.run(QueryLoop(config, {}, ToolRuntime(config), llm_invoke=lambda **_: LLMResponse()).run(
        ctx, BudgetController(config), None))
    assert result.error == "empty_final_response"
    assert result.metrics["response_outcome"] == "failed"
    assert result.metrics["execution_outcome"] == "failed"
    failed = asyncio.run(_engine([LLMResponse()]).run("Answer", workspace_id="r1", session_id="empty"))
    assert not failed.success and failed.errors
    normal = asyncio.run(_engine([LLMResponse(content="A complete answer.")]).run(
        "Answer", workspace_id="r1", session_id="normal"))
    assert normal.success and normal.metadata["execution_outcome"] == "complete"


NETWORK_TOOL = "network.operations.device.manage"


def _network_call(call_id, action, connection_id="test-device"):
    return LLMToolCall(id=call_id, name=NETWORK_TOOL, arguments={
        "action": action, "connection_id": connection_id, "commands": ["test command"],
    })


def _network_handler(args):
    if args["action"] == "configure":
        return {"ok": False, "error_code": "TOOL_TIMEOUT_UNCERTAIN", "execution_may_continue": True}
    return {"ok": True, "connection_ok": True, "connection_id": args["connection_id"],
            "requested_action": args["action"], "evidence_claims": [{
                "status": "collected", "target": {"connection_id": args["connection_id"]},
            }]}


@pytest.mark.parametrize("late_read", [False, True])
def test_runtime_projection_requires_readback_after_unknown_write(late_read):
    responses = [
        LLMResponse(tool_calls=[_network_call("old-read", "read")]),
        LLMResponse(tool_calls=[_network_call("write", "configure")]),
    ]
    if late_read:
        responses.append(LLMResponse(tool_calls=[_network_call("late-read", "read")]))
    responses.append(LLMResponse(content="Report the observed evidence."))
    result = asyncio.run(_engine(responses, _network_handler, NETWORK_TOOL).run(
        "Execute and verify", workspace_id="r1", session_id="causal-read"))
    assert result.metadata["tool_execution_outcome"] == "unknown"
    assert result.metadata["execution_outcome"] == ("complete" if late_read else "unknown")
    assert result.metadata["unknown_outcome"]["status"] == ("reconciled" if late_read else "unknown")
    assert result.success is late_read


def test_runtime_reconciled_write_does_not_mask_another_unknown_write():
    result = asyncio.run(_engine([
        LLMResponse(tool_calls=[_network_call("write-a", "configure", "a")]),
        LLMResponse(tool_calls=[_network_call("write-b", "configure", "b")]),
        LLMResponse(tool_calls=[_network_call("read-a", "read", "a")]),
        LLMResponse(content="Device b still needs verification."),
    ], _network_handler, NETWORK_TOOL).run("Execute and verify", workspace_id="r1", session_id="two-writes"))
    assert result.metadata["unknown_outcome"]["status"] == "reconciled"
    assert result.metadata["execution_outcome"] == "unknown" and not result.success


def test_runtime_reconciled_write_does_not_mask_completion_failure():
    config = SSOTRuntimeConfig()
    runtime = ToolRuntime(config)
    runtime.register(NETWORK_TOOL, _network_handler)
    responses = [
        LLMResponse(tool_calls=[_network_call("write", "configure")]),
        LLMResponse(tool_calls=[_network_call("readback", "read")]),
        LLMResponse(content="Some requested criteria failed."),
    ]
    ctx = _ctx()
    ctx.extras["__completion_check"] = lambda: {"status": "failed"}
    result = asyncio.run(QueryLoop(config, {}, runtime, llm_invoke=lambda **_: responses.pop(0)).run(
        ctx, BudgetController(config), None))
    assert result.error == "completion_check_failed"
    assert result.metrics["execution_outcome"] == "partial"


def test_readback_cannot_use_result_order_to_override_actual_timestamps():
    from core.runtime_engine.loop_recovery import LoopFailureRecovery
    write = StreamingToolResult(NETWORK_TOOL, "write", {}, False, execution_may_continue=True)
    read = StreamingToolResult(NETWORK_TOOL, "read", {
        **_network_handler({"action": "read", "connection_id": "test-device"}),
        "_runtime_readback": {"action": "read", "connection_id": "test-device",
                              "started_at": "2026-01-01T00:00:00+00:00"},
    }, True)
    pending = {"tool_id": NETWORK_TOOL, "call_id": "write", "connection_id": "test-device",
               "operation_finished_at": "2026-01-01T00:00:01+00:00"}
    assert not LoopFailureRecovery._has_late_network_readback([read, write], pending)
    assert not LoopFailureRecovery._has_late_network_readback([write, read], pending)
    read.output["_runtime_readback"]["started_at"] = "2026-01-01T00:00:02+00:00"
    assert LoopFailureRecovery._has_late_network_readback([write, read], pending)
