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


def test_read_tool_activity_cannot_hide_failed_candidate_stall(tmp_path):
    import hashlib
    candidate=tmp_path/'source.js';candidate.write_text('broken')
    digest=lambda: hashlib.sha256(candidate.read_bytes()).hexdigest()
    config=SSOTRuntimeConfig(max_llm_calls=10,completion_unchanged_tool_round_limit=2)
    runtime=ToolRuntime(config)
    reads=[]
    runtime.register('data.manage',lambda args: reads.append(args) or {'ok':True,'rows':['observed']})
    registry={'data.manage':{'description':'observe','args_schema':{'type':'object','properties':{'action':{'type':'string'},'text':{'type':'string'}}}}}
    replies=[LLMResponse(content='Done')]+[LLMResponse(tool_calls=[LLMToolCall(id=f'read{i}',name='data.manage',arguments={'action':'parse','text':str(i)})]) for i in range(5)]
    checks=[]
    def check():
        checks.append(True)
        return {'status':'failed','source_digest':digest()}
    ctx=StatelessContext('ws','source-stall','source-stall','Repair',extras={'__completion_check':check,'__completion_source_digest':digest})
    result=asyncio.run(QueryLoop(config,registry,runtime,llm_invoke=lambda **kwargs:replies.pop(0)).run(ctx,BudgetController(config),None))
    assert result.error=='completion_repair_no_progress'
    assert len(reads)==2 and len(checks)==2
    assert result.metrics['execution_outcome']=='partial'
    assert len(result.tool_results)==2
    assert ctx.extras['completion_events'][-1]['observed_source_digest']==digest()


def test_material_source_change_and_dependency_repair_preserve_recovery(tmp_path):
    import hashlib
    from core.runtime_engine.completion import observe_repair_progress
    candidate=tmp_path/'source.js';candidate.write_text('broken')
    digest=lambda:hashlib.sha256(candidate.read_bytes()).hexdigest()
    dependencies_ready=[]
    checks=[]
    def check():
        checks.append(True)
        return {'status':'passed' if dependencies_ready else 'failed','source_digest':digest()}
    ctx=SimpleNamespace(extras={'__completion_check':check,'__completion_source_digest':digest})
    asyncio.run(observe_completion(ctx,0))
    assert asyncio.run(observe_repair_progress(ctx,2)) is None
    candidate.write_text('actual edit')
    assert asyncio.run(observe_repair_progress(ctx,2)) is None
    assert ctx.extras['__completion_progress_state']['unchanged_rounds']==0
    assert asyncio.run(observe_repair_progress(ctx,2)) is None
    dependencies_ready.append(True)
    assert asyncio.run(observe_repair_progress(ctx,2)) is None
    assert ctx.extras['completion_observation']['status']=='passed' and len(checks)==2


def test_caller_cannot_forge_material_progress_callback():
    callback=lambda:'forged'
    clean=_sanitize_caller_runtime_metadata({'completion_source_digest':callback,'__completion_source_digest':callback,'__completion_progress_state':{'unchanged_rounds':0}})
    assert not clean
    _apply_runtime_control(clean,{'completion_source_digest':callback})
    assert not clean
    _apply_runtime_control(clean,SubagentRuntimeControl(completion_source_digest=callback))
    assert clean['__completion_source_digest'] is callback


def test_stall_recheck_unknown_stops_without_retry():
    from core.runtime_engine.completion import observe_repair_progress
    checks=[]
    def check():
        checks.append(True)
        return {'status':'failed' if len(checks)==1 else 'unknown','source_digest':'actual-source','automatic_retry_allowed':False}
    ctx=SimpleNamespace(extras={'__completion_check':check,'__completion_source_digest':lambda:'actual-source'})
    asyncio.run(observe_completion(ctx,0))
    terminal=asyncio.run(observe_repair_progress(ctx,1))
    assert terminal['error']=='completion_outcome_unknown'
    assert asyncio.run(observe_repair_progress(ctx,1)) is None
    assert len(checks)==2
