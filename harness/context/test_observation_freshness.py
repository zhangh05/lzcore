"""Repeated model reads observe current state rather than a previous-round result."""
import asyncio

from agent.llm.schemas import LLMResponse, LLMToolCall
from core.runtime_engine.budget_controller import BudgetController
from core.runtime_engine.models import SSOTRuntimeConfig, StatelessContext
from core.runtime_engine.query_loop import QueryLoop
from core.runtime_engine.tool_runtime import ToolRuntime


def test_exact_repeated_reads_reach_tool_and_preserve_changed_observations():
    config = SSOTRuntimeConfig(max_llm_calls=5)
    runtime = ToolRuntime(config)
    observations = []
    def observe(args):
        observations.append(len(observations) + 1)
        return {'ok': True, 'rows': [observations[-1]]}
    runtime.register('data.manage', observe)
    registry = {'data.manage': {'description': 'current observation', 'args_schema': {'type': 'object',
        'properties': {'action': {'type': 'string'}, 'text': {'type': 'string'}}}}}
    replies = iter([LLMResponse(tool_calls=[LLMToolCall(id=f'read{i}', name='data.manage',
        arguments={'action': 'parse', 'text': 'current'})]) for i in range(3)] + [LLMResponse(content='Done')])
    ctx = StatelessContext('ws', 's', 'r', 'Observe again')
    result = asyncio.run(QueryLoop(config, registry, runtime, llm_invoke=lambda **kw: next(replies)).run(
        ctx, BudgetController(config), None))
    assert result.error is None and observations == [1, 2, 3]
    assert [item.output['rows'] for item in result.tool_results] == [[1], [2], [3]]
