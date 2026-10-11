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


@pytest.mark.parametrize('requested, expected', [(None, 120), (180, 190), (600, 610)])
def test_command_timeout_reaches_the_runtime_with_return_guard(monkeypatch, requested, expected):
    """The published 180/600-second requests must not hit a hidden 120s cap."""
    from core.tools.canonical_registry import get_entry, to_tool_specs
    from core.tools.catalog_snapshot import build_catalog_snapshot

    contract = get_contract('exec.run')
    spec = next(spec for spec, _ in to_tool_specs() if spec.tool_id == 'exec.run')
    declared = get_entry('exec.run').execution_contract['execution_time_budget']
    assert contract.execution_time_budget == spec.metadata['execution_time_budget'] == declared
    item = next(item for item in build_catalog_snapshot()['tools'] if item['tool_id'] == 'exec.run')
    assert item['execution_time_budget'] == declared

    observed = []
    original_wait = asyncio.wait_for

    async def record_wait(awaitable, timeout):
        observed.append(timeout)
        return await original_wait(awaitable, timeout=timeout)

    monkeypatch.setattr(asyncio, 'wait_for', record_wait)

    async def handler(args):
        await asyncio.sleep(0.01)
        return {'ok': True, 'requested_timeout': args.get('timeout')}

    async def run():
        runtime = ToolRuntime(SSOTRuntimeConfig())
        runtime.register('exec.run', handler)
        args = {'action': 'shell', 'command': 'controlled fixture'}
        if requested is not None:
            args['timeout'] = requested
        result = await runtime.execute_node(
            ExecutionNode('command', 'exec.run', args),
            StatelessContext('timing', 'session', 'request', 'run'), {},
        )
        assert result.success and result.data['requested_timeout'] == requested

    asyncio.run(run())
    assert observed == [expected]


def test_production_entry_uses_the_same_command_caller_cap():
    from agent.runtime.ssot_runtime import _build_engine
    from core.tools.canonical_registry import get_entry

    engine = _build_engine(
        workspace_id='default', session_id='timing', run_id='timing', trace_id='timing',
        requested_by='test', prebuilt_registry={
            'exec.run': {'args_schema': get_entry('exec.run').input_schema},
        },
    )
    assert engine.config.single_node_timeout_ms == SSOTRuntimeConfig().single_node_timeout_ms
    assert engine.config.single_node_timeout_ms >= 610_000


def test_long_command_request_cannot_override_an_explicit_server_cap():
    calls = []

    async def command(_args):
        calls.append(True)
        await asyncio.sleep(0.06)
        return {'ok': True}

    async def run():
        runtime = ToolRuntime(SSOTRuntimeConfig(single_node_timeout_ms=20))
        runtime.register('exec.run', command)
        result = await runtime.execute_node(
            ExecutionNode('capped', 'exec.run', {'action': 'shell', 'command': 'fixture', 'timeout': 600}),
            StatelessContext('timing', 'session', 'request', 'run'), {},
        )
        assert not result.success and result.error_code == 'TOOL_TIMEOUT_UNCERTAIN'
        assert result.metadata['automatic_retry_allowed'] is False
        assert result.metadata['execution_may_continue'] is True
        await asyncio.sleep(0.08)

    asyncio.run(run())
    assert calls == [True]


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
