"""Native provider state is distinct from the public conversation projection."""
import json
import pytest

from agent.llm import provider
from agent.llm.schemas import LLMRequest, LLMResponse
from agent.runtime.ssot_runtime import _append_context_message
from core.runtime_engine.models import SSOTRuntimeConfig
from core.runtime_engine.query_loop import QueryLoop
from harness.test_llm_stream_cancellation import _FakeStreamResponse, _install_requests


def test_anthropic_native_blocks_survive_tool_round():
    blocks = [
        {"type": "thinking", "thinking": "private state", "signature": "signed"},
        {"type": "redacted_thinking", "data": "opaque"},
        {"type": "text", "text": "Checking now"},
        {"type": "tool_use", "id": "c1", "name": "test__read", "input": {}},
    ]
    response = provider._parse_anthropic_messages_response({"content": blocks}, {})
    loop = QueryLoop(SSOTRuntimeConfig(), {}, None)
    messages = loop._append_tool_round([], response.tool_calls, [], response=response)
    body = provider._to_anthropic_messages_request(LLMRequest(task="assistant_chat", messages=messages), {})
    assert body["messages"][0]["content"] == blocks
    assert response.content == "Checking now"
    assert "private state" not in repr(messages[0])


@pytest.mark.parametrize("arguments", ['{"command":"unterminated', [], None])
def test_rejected_native_tool_input_does_not_break_validation_feedback_request(arguments):
    from agent.llm.schemas import LLMMessage
    native = [
        {"type": "thinking", "thinking": "private state", "signature": "signed"},
        {"type": "tool_use", "id": "bad", "name": "exec__run", "input": arguments},
    ]
    response = provider._parse_anthropic_messages_response({"content": native}, {})
    message = response.assistant_message()
    request = LLMRequest(task="assistant_chat", messages=[message,
        LLMMessage(role="tool", tool_call_id="bad", content="INVALID_TOOL_ARGUMENTS_JSON: resend complete arguments")])
    body = provider._to_anthropic_messages_request(request, {})
    sent = body["messages"][0]["content"]
    assert sent[0] == native[0]
    assert isinstance(sent[1]["input"], dict)
    assert "__invalid_tool_arguments_json__" in sent[1]["input"]
    assert native[1]["input"] == arguments  # no mutation of private history
    assert body["messages"][1]["content"][0]["tool_use_id"] == "bad"
    loop = QueryLoop(SSOTRuntimeConfig(), {}, None)
    parsed = loop._parse_tool_calls(response.tool_calls)
    assert "__invalid_tool_arguments_json__" in parsed[0].arguments


def test_anthropic_stream_reassembles_thinking_signature_and_tool_input(monkeypatch):
    events = [
        {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}},
        *[{"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": value}} for value in ["part1", "part2"]],
        {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig"}},
        {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "public"}},
        {"type": "content_block_start", "index": 2, "content_block": {"type": "tool_use", "id": "c1", "name": "read", "input": {}}},
        {"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": '{"x":1}'}},
    ]
    _install_requests(monkeypatch, _FakeStreamResponse(["data: " + json.dumps(e) for e in events]))
    displayed = []
    monkeypatch.setattr(provider, "_push_stream_token", displayed.append)
    response = provider._anthropic_messages_stream("url", {}, {}, {}, LLMRequest(task="assistant_chat", metadata={"stream_to_user": True}))
    blocks = response.protocol["anthropic"]
    assert blocks[0] == {"type": "thinking", "thinking": "part1part2", "signature": "sig"}
    assert blocks[1]["text"] == "public"
    assert blocks[2]["input"] == {"x": 1}
    assert "_partial_json" not in blocks[2]
    assert displayed == ["public"]


def test_think_tags_are_hidden_but_returned_to_model():
    original = "<think>private</think>Public"
    response = LLMResponse(content=original, protocol={"openai": {"content": original, "reasoning_details": [{"text": "native"}]}})
    loop = QueryLoop(SSOTRuntimeConfig(), {}, None)
    response = loop._coerce_llm_response(response)
    assert response.content == "Public"
    wire = provider._format_message(response.assistant_message())
    assert wire["content"] == original
    assert wire["reasoning_details"] == [{"text": "native"}]


def test_minimax_stream_reasoning_snapshots_not_duplicated(monkeypatch):
    lines = ["data: " + json.dumps({"choices": [{"delta": {"reasoning_details": [{"text": value}]}}]}) for value in ["one", "one two"]]
    _install_requests(monkeypatch, _FakeStreamResponse(lines))
    response = provider._api_generate_stream("url", {}, {"api_key": "test", "provider": "minimax"}, LLMRequest(task="assistant_chat"))
    assert response.protocol["openai"]["reasoning_details"] == [{"text": "one two"}]


def test_later_turn_keeps_all_public_stages_and_tool_facts():
    messages = []
    long_text = "x" * 1000 + "END"
    _append_context_message(messages, set(), {"role": "assistant", "content": "final", "metadata": {
        "stage_outputs": [{"text": "first stage"}, {"text": "final"}],
        "tool_context": [{"tool_id": f"tool{i}", "ok": False, "summary": long_text, "errors": [long_text] * 3} for i in range(12)],
    }})
    content = messages[0]["content"]
    assert "first stage" in content
    assert "tool11" in content
    assert content.count(long_text) == 12
    assert content.count("final") == 1


def test_runtime_adapter_preserves_protocol(monkeypatch):
    from agent.runtime.ssot_runtime import _invoke_llm_for_ssot_runtime
    captured = {}

    def invoke(**kwargs):
        captured.update(kwargs)
        return LLMResponse(content="ok")

    monkeypatch.setattr("agent.llm.runtime.invoke_llm", invoke)
    state = {"openai": {"content": "public", "reasoning_content": "private"}}
    message = LLMResponse(content="public", protocol=state).assistant_message()
    _invoke_llm_for_ssot_runtime(messages=[message])
    assert captured["messages"][0].protocol == state


def test_runtime_adapter_keeps_explicitly_rejected_native_calls(monkeypatch):
    from agent.runtime.ssot_runtime import _invoke_llm_for_ssot_runtime
    captured = {}
    def invoke(**kwargs):
        captured.update(kwargs)
        return LLMResponse(content="ok")
    monkeypatch.setattr("agent.llm.runtime.invoke_llm", invoke)
    message = LLMResponse(content="proposal", protocol={"anthropic": [
        {"type": "tool_use", "id": "not_executed", "name": "exec__run", "input": {}}]}).assistant_message([])
    _invoke_llm_for_ssot_runtime(messages=[message])
    assert captured["messages"][0].tool_calls == []


def test_provider_switch_never_sends_other_providers_private_state():
    original = {"provider": "one", "base_url": "https://one", "model": "m1"}
    message = LLMResponse(content="public", protocol={
        "owner": provider._protocol_owner(original),
        "openai": {"content": "public", "reasoning_content": "private"},
    }).assistant_message()
    assert provider._format_message(message, original)["reasoning_content"] == "private"
    assert provider._format_message(message, {**original, "model": "m2"}) == {"role": "assistant", "content": "public"}


def test_native_projection_uses_compiled_contract_and_preserves_original_evidence():
    from copy import deepcopy
    from agent.llm.schemas import LLMMessage

    native = [
        {"type": "thinking", "thinking": "opaque", "signature": "signature"},
        {"type": "tool_use", "id": "a", "name": "test__read", "input": {"index": 1}},
        {"type": "tool_use", "id": "b", "name": "test__read", "input": {"index": 2}},
    ]
    evidence = deepcopy(native)
    effective = [{"id": "a_i2_1", "type": "function", "function": {
        "name": "test__read", "arguments": json.dumps({"action": "read_batch", "start_index": 1, "limit": 2})}}]
    response = provider._parse_anthropic_messages_response({"content": native}, {})
    messages = [response.assistant_message(effective), LLMMessage(role="tool", tool_call_id="a_i2_1", content="observed result")]
    body = provider._to_anthropic_messages_request(LLMRequest(task="assistant_chat", messages=messages), {})
    blocks = body["messages"][0]["content"]
    assert blocks[0] == evidence[0]
    assert len(blocks) == 2
    assert blocks[1]["id"] == body["messages"][1]["content"][0]["tool_use_id"] == "a_i2_1"
    assert blocks[1]["input"] == {"action": "read_batch", "start_index": 1, "limit": 2}
    assert response.protocol["anthropic"] == evidence


@pytest.mark.parametrize("protocol_type", ["anthropic", "openai"])
def test_suppressed_proposal_has_no_unanswered_wire_calls(protocol_type):
    from agent.llm.schemas import LLMMessage

    if protocol_type == "anthropic":
        state = {"anthropic": [
            {"type": "thinking", "thinking": "opaque", "signature": "sig"},
            {"type": "text", "text": "proposal"},
            {"type": "tool_use", "id": "not_executed", "name": "exec__run", "input": {"action": "shell"}},
        ]}
    else:
        state = {"openai": {"content": "proposal", "reasoning_content": "opaque", "tool_calls": [
            {"id": "not_executed", "type": "function", "function": {"name": "exec__run", "arguments": "{}"}}]}}
    response = LLMResponse(content="proposal", protocol=state)
    message = response.assistant_message([])
    if protocol_type == "anthropic":
        body = provider._to_anthropic_messages_request(LLMRequest(task="assistant_chat", messages=[
            message, LLMMessage(role="user", content="Proposal not executed; choose a different action.")]), {})
        assert [b["type"] for b in body["messages"][0]["content"]] == ["thinking", "text"]
        assert body["messages"][0]["content"][0]["signature"] == "sig"
        assert state["anthropic"][-1]["id"] == "not_executed"
    else:
        body = provider._format_message(message)
        assert "tool_calls" not in body
        assert body["reasoning_content"] == "opaque"
        assert state["openai"]["tool_calls"][0]["id"] == "not_executed"


def test_rejected_native_proposal_remains_rejected_after_durable_restart():
    from core.runtime_engine.loop_messages import serialize_loop_message, deserialize_loop_message
    response = LLMResponse(content="proposal", protocol={"anthropic": [
        {"type": "tool_use", "id": "not_executed", "name": "exec__run", "input": {}}]})
    restored = deserialize_loop_message(serialize_loop_message(response.assistant_message([])))
    assert restored.tool_calls == []
    body = provider._to_anthropic_messages_request(LLMRequest(task="assistant_chat", messages=[restored]), {})
    assert body["messages"] == []
    assert restored.protocol["anthropic"][0]["id"] == "not_executed"


def test_query_loop_suppresses_repeated_native_proposal_without_protocol_orphans(tmp_path, monkeypatch):
    import asyncio
    from agent.llm.schemas import LLMToolCall
    from core.runtime_engine.budget_controller import BudgetController
    from core.runtime_engine.models import StatelessContext
    from core.runtime_engine.tool_runtime import ToolRuntime

    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    config = SSOTRuntimeConfig(max_query_loop_iterations=10)
    runtime = ToolRuntime(config)
    observed = []
    runtime.register("data.manage", lambda args: observed.append(args["text"]) or {"ok": True, "value": args["text"]})
    registry = {"data.manage": {"description": "parse data", "args_schema": {
        "type": "object", "required": ["action", "text"], "properties": {"action": {"type": "string"}, "text": {"type": "string"}}}}}
    requests = []
    def model(**kwargs):
        wire = provider._to_anthropic_messages_request(LLMRequest(task="assistant_chat", messages=kwargs["messages"]), {})
        pending = set()
        for message in wire["messages"]:
            if message["role"] == "assistant":
                assert not pending
                pending = {b["id"] for b in message["content"] if b["type"] == "tool_use"}
            else:
                results = [b["tool_use_id"] for b in message["content"] if b["type"] == "tool_result"]
                for result in results:
                    assert result in pending
                    pending.remove(result)
                assert not pending
        assert not pending
        requests.append(wire)
        if len(requests) > 2:
            return LLMResponse(content="Parsed the data once.")
        call = LLMToolCall(id="reused", name="data__manage", arguments={"action": "parse", "text": "source"})
        return LLMResponse(content="Parsing", tool_calls=[call], protocol={"anthropic": [
            {"type": "thinking", "thinking": "opaque", "signature": "sig"},
            {"type": "text", "text": "Parsing"},
            {"type": "tool_use", "id": call.id, "name": call.name, "input": call.arguments}]})
    loop = QueryLoop(config, registry, runtime, llm_invoke=model)
    ctx = StatelessContext("protocol", "session", "request", "Parse source once.")
    result = asyncio.run(loop.run(ctx, BudgetController(config), None))
    assert result.error is None, result.error
    assert observed == ["source"]
    assert len(requests) == 3


def test_failure_structure_detects_protocol_errors_without_logging_content():
    from agent.llm.protocol_projection import anthropic_request_structure
    body = {"model": "test", "messages": [
        {"role": "assistant", "content": [{"type": "thinking", "thinking": "private secret", "signature": "opaque signature"},
            {"type": "tool_use", "id": "c", "name": "exec__run", "input": {"password": "private credential"}}]},
        {"role": "user", "content": [{"type": "text", "text": "private request"}]},
    ]}
    result = anthropic_request_structure(body)
    assert result["violations"] == {"user_before_all_results": 1, "unanswered_calls": 1}
    assert result["blocks"] == {"thinking": 1, "tool_use": 1, "text": 1}
    assert len(result["sha256"]) == 64
    assert "private" not in json.dumps(result)
    assert "opaque" not in json.dumps(result)
