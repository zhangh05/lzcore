"""Repeatable does not mean immutable: read-back must observe current state."""
from types import SimpleNamespace

import pytest

from agent.llm.schemas import LLMToolCall
from core.runtime_engine.query_loop import QueryLoop
from core.runtime_engine.contracts import is_read_only_call


@pytest.mark.parametrize("tool,action", [("browser.manage", "extract"), ("browser.manage", "snapshot"),
    ("workspace.file", "read"), ("network.operations.topology", "read"), ("system.manage", "health")])
def test_live_observations_are_not_reused_as_current_evidence(tool, action):
    loop = QueryLoop.__new__(QueryLoop)
    loop._executor = SimpleNamespace(_is_read_only_call=lambda call: is_read_only_call(call.name, call.arguments))
    call = LLMToolCall(id="new-read", name=tool, arguments={"action": action})
    ctx = SimpleNamespace(extras={"task_state_execution_manifest": [{
        "call_key": loop._durable_call_key(call), "ok": True,
    }]})
    executable, note = loop._suppress_repeated_tool_calls(ctx, [call])
    assert executable == [call] and not note


def test_failed_write_can_be_corrected_after_state_changes_but_unknown_is_not_deduped():
    loop = QueryLoop.__new__(QueryLoop)
    loop._executor = SimpleNamespace(_is_read_only_call=lambda call: False)
    call = LLMToolCall(id="new-create", name="workspace.file", arguments={"action": "create"})
    prior = {"call_key": loop._durable_call_key(call), "ok": False, "state_revision": 2}
    ctx = SimpleNamespace(extras={"task_state_execution_manifest": [prior], "tool_state_revision": 2})
    assert loop._suppress_repeated_tool_calls(ctx, [call])[0] == []
    ctx.extras["tool_state_revision"] = 3
    assert loop._suppress_repeated_tool_calls(ctx, [call])[0] == [call]
    prior["execution_may_continue"] = True
    ctx.extras["tool_state_revision"] = 2
    # Uncertain effects remain the responsibility of the operation ledger,
    # never converted into a deterministic cached failure by this filter.
    assert loop._suppress_repeated_tool_calls(ctx, [call])[0] == [call]
