"""Window replacement, evidence retrieval and failure boundaries."""
import json
from dataclasses import asdict

import pytest

from agent.llm.schemas import LLMMessage
from core.runtime_engine.context_compaction import assert_tool_protocol, estimate_message_tokens
from core.runtime_engine.context_continuation import ContextContinuation, ContextContinuationError
from core.runtime_engine.models import StatelessContext
from storage.context_epoch_store import read_epoch, read_index, read_message_chunk, save_epoch


@pytest.fixture
def ctx(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    return StatelessContext("continuation", "session", "request", "Keep all requirements; never repeat writes.")


def round_messages(call_id, size=1800):
    return [LLMMessage("assistant", "", tool_calls=[{
        "id": call_id, "function": {"name": "workspace__file", "arguments": '{"action":"read"}'}}]),
        LLMMessage("tool", json.dumps({"ok": True, "output": "e" * size}), tool_call_id=call_id)]


def test_three_hundred_rounds_remain_bounded_and_all_evidence_retrievable(ctx):
    anchors = [LLMMessage("user", ctx.user_input)]
    lifecycle = ContextContinuation(anchors)
    messages = anchors.copy()
    ctx.extras["recovery_goals"] = [{"goal_id": "unknown-write", "status": "unknown", "next_action": "read_back"}]
    for n in range(310):
        messages.extend(round_messages(f"call-{n}"))
        lifecycle.prepare(messages, ctx, 1500)
        assert estimate_message_tokens(messages) <= 1500
        assert messages[0].content == ctx.user_input
        assert_tool_protocol(messages)
    assert len(lifecycle.epochs) > 20
    seen = set()
    for epoch in lifecycle.epochs:
        record = read_epoch(ctx.workspace_id, ctx.session_id, epoch["checkpoint_id"])
        assert record["payload"]["state"]["recovery_goals"][0]["status"] == "unknown"
        seen.update(m["tool_call_id"] for m in record["payload"]["messages"] if m["role"] == "tool")
    seen.update(m.tool_call_id for m in messages if m.role == "tool")
    assert seen == {f"call-{n}" for n in range(310)}


def test_archive_chunk_reconstructs_complete_redacted_source(ctx):
    source = [asdict(LLMMessage("user", "公司网关 " * 1000))]
    record = save_epoch(ctx.workspace_id, ctx.session_id, ctx.request_id, source, {})
    cid = record["checkpoint_id"]
    index = read_index(ctx.workspace_id, ctx.session_id, cid, limit=1)
    assert index["total"] == 1 and index["next_offset"] is None
    offset, chunks = 0, []
    while True:
        part = read_message_chunk(ctx.workspace_id, ctx.session_id, cid, 0, offset, 123)
        chunks.append(part["text_chunk"])
        if part["next_char_offset"] is None:
            break
        offset = part["next_char_offset"]
    assert json.loads("".join(chunks)) == source[0]


def test_archive_cannot_cross_session_or_principal(ctx):
    from storage.principal import storage_principal
    with storage_principal("owner-a"):
        record = save_epoch(ctx.workspace_id, ctx.session_id, ctx.request_id, [], {})
        with pytest.raises(ValueError, match="not_found"):
            read_epoch(ctx.workspace_id, "other-session", record["checkpoint_id"])
    with storage_principal("owner-b"), pytest.raises(ValueError, match="not_found"):
        read_epoch(ctx.workspace_id, ctx.session_id, record["checkpoint_id"])


def test_corrupted_checkpoint_never_becomes_evidence(ctx):
    from storage.context_epoch_store import _path
    record = save_epoch(ctx.workspace_id, ctx.session_id, ctx.request_id, [], {})
    path = _path(ctx.workspace_id, ctx.session_id, record["checkpoint_id"])
    changed = json.loads(path.read_text(encoding="utf-8"))
    changed["payload"]["state"]["forged_success"] = True
    path.write_text(json.dumps(changed), encoding="utf-8")
    with pytest.raises(ValueError, match="integrity_failed"):
        read_epoch(ctx.workspace_id, ctx.session_id, record["checkpoint_id"])


def test_storage_failure_does_not_replace_active_window(ctx, monkeypatch):
    from core.runtime_engine import context_continuation
    messages = [LLMMessage("user", ctx.user_input), *round_messages("c", 8000)]
    before = [asdict(message) for message in messages]
    def fail(*args, **kwargs):
        raise OSError("disk unavailable")
    monkeypatch.setattr(context_continuation, "save_epoch", fail)
    with pytest.raises(OSError):
        ContextContinuation(messages[:1]).prepare(messages, ctx, 1500)
    assert [asdict(message) for message in messages] == before
    assert "context_epochs" not in ctx.extras


def test_pending_tool_never_rolls_into_a_new_provider_window(ctx):
    messages = [LLMMessage("user", ctx.user_input), round_messages("pending", 9000)[0], LLMMessage("assistant", "x" * 6000)]
    with pytest.raises(ContextContinuationError, match="unsettled"):
        ContextContinuation(messages[:1]).prepare(messages, ctx, 1500)


def test_signed_native_tool_group_is_carried_intact(ctx):
    anchors = [LLMMessage("user", ctx.user_input)]
    recent = round_messages("recent", 100)
    recent[0].protocol = {"anthropic": [{"type": "thinking", "thinking": "reason", "signature": "signed"}]}
    messages = [*anchors, *round_messages("old", 9000), *recent]
    ContextContinuation(anchors).prepare(messages, ctx, 1500)
    assert messages[-2:] == recent
    assert_tool_protocol(messages)


def test_oversized_single_result_is_archived_with_an_explicit_source_reference(ctx):
    anchors = [LLMMessage("user", ctx.user_input)]
    messages = [*anchors, *round_messages("huge", 9000)]
    lifecycle = ContextContinuation(anchors)
    assert lifecycle.prepare(messages, ctx, 1500)
    assert len(messages) == 2
    assert lifecycle.parent_id in messages[1].content
    record = read_epoch(ctx.workspace_id, ctx.session_id, lifecycle.parent_id)
    assert len(json.loads(record["payload"]["messages"][2]["content"])["output"]) == 9000


def test_caller_cannot_retrieve_another_sessions_checkpoint(ctx):
    from core.tools.general_tools.context_tools import handle_context_archive
    from core.tools.schemas import ToolInvocation
    inv = ToolInvocation(tool_id="system.manage", workspace_id=ctx.workspace_id, session_id=ctx.session_id,
                         arguments={"action": "context_index", "session_id": "other", "checkpoint_id": "ctx_" + "0" * 32})
    result = handle_context_archive(inv)
    assert not result["ok"] and "scope_mismatch" in str(result)


def test_archive_read_passes_the_canonical_runtime_with_zero_message_index(ctx):
    from core.tools.context import ToolRuntimeContext
    from core.tools.integration import get_default_tool_runtime_client
    record = save_epoch(ctx.workspace_id, ctx.session_id, ctx.request_id,
                        [asdict(LLMMessage("user", "original evidence"))], {})
    result = get_default_tool_runtime_client().invoke("system.manage", {
        "action": "context_read", "checkpoint_id": record["checkpoint_id"],
        "message_index": 0, "char_limit": 30},
        context=ToolRuntimeContext(workspace_id=ctx.workspace_id, session_id=ctx.session_id, requested_by="turn_runner"))
    assert result.status == "succeeded", result


@pytest.mark.parametrize("cid", ["../escape", "ctx_bad", "ctx_" + "0" * 31])
def test_checkpoint_identifiers_are_validated(ctx, cid):
    with pytest.raises(ValueError, match="invalid_context_checkpoint"):
        read_epoch(ctx.workspace_id, ctx.session_id, cid)


def test_archives_discoverable_after_runtime_restart(ctx):
    from storage.context_epoch_store import list_epochs
    one = save_epoch(ctx.workspace_id, ctx.session_id, 'one', [asdict(LLMMessage('user', 'one'))], {})
    two = save_epoch(ctx.workspace_id, ctx.session_id, 'two', [asdict(LLMMessage('user', 'two'))], {}, one['checkpoint_id'])
    rows = list_epochs(ctx.workspace_id, ctx.session_id)['records']
    assert {row['checkpoint_id'] for row in rows} == {one['checkpoint_id'], two['checkpoint_id']}
    assert next(row for row in rows if row['checkpoint_id'] == two['checkpoint_id'])['parent_id'] == one['checkpoint_id']


def test_signed_provider_blocks_count_toward_window_capacity():
    plain = LLMMessage('assistant', 'response')
    signed = LLMMessage('assistant', 'response', protocol={'anthropic': [{'type': 'thinking', 'thinking': 'x' * 10000, 'signature': 'signed'}]})
    assert estimate_message_tokens([signed]) > estimate_message_tokens([plain]) + 1000


def test_full_query_loop_three_hundred_tool_rounds(ctx):
    """Deterministic provider, real graph executor and window lifecycle (not a live LLM)."""
    import asyncio
    from agent.llm.schemas import LLMResponse, LLMToolCall
    from core.runtime_engine.budget_controller import BudgetController
    from core.runtime_engine.models import SSOTRuntimeConfig
    from core.runtime_engine.query_loop import QueryLoop
    from core.runtime_engine.tool_runtime import ToolRuntime
    config = SSOTRuntimeConfig(context_window_tokens=24000, max_input_tokens=20000, max_output_tokens=1000, context_safety_tokens=1000)
    runtime = ToolRuntime(config)
    executed = []
    def read(arguments):
        executed.append(int(arguments['index']))
        return {'ok': True, 'index': arguments['index'], 'evidence': '事实' * 3000}
    runtime.register('data.manage', read)
    registry = {'data.manage': {'description': 'parse indexed data', 'args_schema': {'type': 'object', 'required': ['action', 'index'], 'properties': {'action': {'type': 'string'}, 'index': {'type': 'string'}, 'text': {'type': 'string'}}}}}
    invocations = []
    def model(**kwargs):
        from agent.llm.provider import _to_anthropic_messages_request
        from agent.llm.schemas import LLMRequest
        from agent.llm.protocol_projection import anthropic_request_structure
        i = len(invocations)
        invocations.append(estimate_message_tokens(kwargs['messages']))
        wire = _to_anthropic_messages_request(LLMRequest(task='assistant_chat', messages=kwargs['messages']), {})
        assert anthropic_request_structure(wire)['violations'] == {}
        assert ctx.user_input in kwargs['messages'][1].content
        if i == 310:
            return LLMResponse(content='310 indexed sources read, no write actions taken.')
        call = LLMToolCall(id='reused-provider-id', name='data__manage', arguments={'action': 'parse', 'index': str(i), 'text': f'item\n{i}'})
        return LLMResponse(tool_calls=[call], protocol={'anthropic': [
            {'type': 'thinking', 'thinking': f'opaque round {i}', 'signature': f'fixture-signature-{i}'},
            {'type': 'tool_use', 'id': call.id, 'name': call.name, 'input': call.arguments}]})
    result = asyncio.run(QueryLoop(config, registry, runtime, llm_invoke=model).run(ctx, BudgetController(config), None))
    assert result.error is None, result.error
    assert executed == list(range(310)), [(r.error, r.output) for r in result.tool_results[:1]]
    assert len(ctx.extras['context_epochs']) > 20
    assert max(invocations) < 22000
