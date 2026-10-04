"""Dedicated tools keep one contract through every execution projection."""

import asyncio

import pytest

from core.tools.execution_contracts import declared_action_contract, execution_timeout_seconds, validate_execution_time_budget
from core.runtime_engine.contracts import ToolContract, is_read_only_call, get_contract, BUILTIN_CONTRACTS
from core.runtime_engine.models import SSOTRuntimeConfig, ExecutionNode, StatelessContext
from core.runtime_engine.tool_runtime import ToolRuntime


def test_dedicated_wait_contract_is_the_same_with_and_without_catalog_metadata():
    from extensions.runtime import get_extension_tool_specs
    from core.tools.catalog_snapshot import build_action_profiles_for_tool
    from core.tools.policy import ToolPolicy
    from core.tools.schemas import ToolInvocation
    spec = next(s for s, _ in get_extension_tool_specs() if s.tool_id == 'network.operations.wait')
    declared = spec.metadata['action_execution_contracts']
    assert declared_action_contract(spec.input_schema, declared, {'seconds': 30})['read_only']
    assert is_read_only_call(spec.tool_id, {'seconds': 30})
    profiles = build_action_profiles_for_tool(spec.tool_id, input_schema=spec.input_schema,
        category=spec.category, base_permission=spec.permission_action, action_contracts=declared)
    assert len(profiles) == 1 and profiles[0]['read_only']
    assert profiles[0]['permission_action'] == 'network'  # no authority expansion
    decision = ToolPolicy().check(spec, ToolInvocation(tool_id=spec.tool_id, workspace_id='default', arguments={'seconds': 30}))
    assert decision.allowed
    assert profiles[0]['idempotency'] == 'safe_to_retry'
    rule = get_contract(spec.tool_id).execution_time_budget
    assert execution_timeout_seconds(spec.timeout_seconds, {'seconds': 30}, rule) == 32


def test_missing_merged_action_cannot_inherit_an_innocuous_sole_contract():
    schema = {'properties': {'action': {'type': 'string', 'enum': ['read', 'write']}}}
    declared = {'read': {'read_only': True}}
    assert declared_action_contract(schema, declared, {}) == {}
    assert declared_action_contract({}, declared, {}) == {}


@pytest.mark.parametrize('rule', [
    {'duration_argument': 'missing', 'guard_seconds': 1},
    {'duration_argument': 'seconds', 'guard_seconds': True},
    {'duration_argument': 'seconds', 'guard_seconds': float('nan')},
    {'duration_argument': 'seconds', 'guard_seconds': -1},
])
def test_invalid_server_timing_declarations_are_rejected(rule):
    with pytest.raises(ValueError):
        validate_execution_time_budget(rule, {'properties': {'seconds': {'type': 'number'}}})


def test_declared_duration_reserves_transport_guard_but_never_lifts_request_cap(monkeypatch):
    name = 'test.duration'
    monkeypatch.setitem(BUILTIN_CONTRACTS, name, ToolContract(name=name, timeout_seconds=1,
        execution_time_budget={'duration_argument': 'seconds', 'guard_seconds': 0.2}))
    async def wait(args):
        await asyncio.sleep(args['seconds'])
        return {'ok': True, 'elapsed_seconds': args['seconds']}
    async def run():
        ctx = StatelessContext('timing', 'session', 'request', 'wait')
        runtime = ToolRuntime(SSOTRuntimeConfig(single_node_timeout_ms=2000))
        runtime.register(name, wait)
        result = await runtime.execute_node(ExecutionNode('duration', name, {'seconds': 1.1}), ctx, {})
        assert result.success and result.data['elapsed_seconds'] == 1.1
        capped = ToolRuntime(SSOTRuntimeConfig(single_node_timeout_ms=20))
        capped.register(name, wait)
        result = await capped.execute_node(ExecutionNode('capped', name, {'seconds': 0.1}), ctx, {})
        assert not result.success and result.error_code == 'TOOL_TIMEOUT_UNCERTAIN'
        await asyncio.sleep(0.15)  # observe detached completion before closing loop
    asyncio.run(run())
