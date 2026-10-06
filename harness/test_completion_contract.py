"""Final checks report physical outcomes without imposing a model work cadence."""

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


@pytest.mark.parametrize('status,error', [('passed', None), ('failed', 'completion_check_failed'),
                                        ('unknown', 'completion_outcome_unknown')])
def test_final_checks_preserve_model_reply_and_actual_outcome(status, error):
    config = SSOTRuntimeConfig(max_llm_calls=5)
    calls, checks = [], []

    def model(**kwargs):
        calls.append(kwargs)
        return LLMResponse(content='Model report with its own wording.')

    def check():
        checks.append(True)
        return {'status': status, 'automatic_retry_allowed': status != 'unknown'}

    ctx = StatelessContext('ws', 'final', 'final', 'Implement', extras={'__completion_check': check})
    result = asyncio.run(QueryLoop(config, {}, object(), llm_invoke=model).run(
        ctx, BudgetController(config), None))
    assert result.error == error
    assert result.final_response == 'Model report with its own wording.'
    assert len(calls) == len(checks) == 1
    assert ctx.extras['completion_events'][0]['status'] == status
    if status == 'unknown':
        assert result.metrics['execution_outcome'] == 'unknown'


@pytest.mark.parametrize('outcome', ['read', 'failure', 'noop', 'truncated'])
def test_working_rounds_do_not_trigger_checks_or_count_based_stops(outcome):
    config = SSOTRuntimeConfig(max_llm_calls=25)
    runtime = ToolRuntime(config)
    runtime.register('data.manage', lambda args: ({'ok': False, 'error': 'same error'}
        if outcome == 'failure' else {'ok': True, 'rows': ['observed'], 'changed': False}))
    registry = {'data.manage': {'description': 'observe', 'args_schema': {'type': 'object',
        'properties': {'action': {'type': 'string'}, 'text': {'type': 'string'}}}}}
    calls, checks = [], []

    def model(**kwargs):
        calls.append(kwargs)
        if len(calls) > 15:
            return LLMResponse(content='Done in my chosen sequence.')
        if outcome == 'truncated':
            return LLMResponse(finish_reason='length', metadata={'output_truncated': True})
        return LLMResponse(tool_calls=[LLMToolCall(id=f'call-{len(calls)}', name='data.manage',
            arguments={'action': 'parse', 'text': 'same requested observation'})])

    def check():
        checks.append(len(calls))
        return {'status': 'passed'}

    ctx = StatelessContext('ws', outcome, outcome, 'Implement', extras={'__completion_check': check})
    result = asyncio.run(QueryLoop(config, registry, runtime, llm_invoke=model).run(
        ctx, BudgetController(config), None))
    assert result.error is None and len(calls) == 16 and checks == [16]
    assert len(result.tool_results) == (0 if outcome == 'truncated' else 15)


def test_caller_cannot_forge_completion_control_or_removed_callbacks():
    callback = lambda: {'status': 'passed'}
    clean = _sanitize_caller_runtime_metadata({'completion_check': callback, '__completion_check': callback,
        'completion_source_digest': callback, 'completion_proposal_check': callback,
        'caller_type': 'subagent', 'requested_by': 'subagent',
        '__completion_progress_state': {'unchanged_rounds': 0}})
    assert not clean
    _apply_runtime_control(clean, {'completion_check': callback})
    assert not clean
    _apply_runtime_control(clean, SubagentRuntimeControl(completion_check=callback))
    assert clean['__completion_check'] is callback


@pytest.mark.parametrize('observation', [None, {'status': 'unrecognized'}])
def test_invalid_completion_is_unknown_not_passed(observation):
    ctx = SimpleNamespace(extras={'__completion_check': lambda: observation})
    result = asyncio.run(observe_completion(ctx))
    assert result['status'] == 'unknown' and not result['automatic_retry_allowed']
