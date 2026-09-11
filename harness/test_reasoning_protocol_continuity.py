"""Native provider state is distinct from the public conversation projection."""
import json

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


def test_provider_switch_never_sends_other_providers_private_state():
    original = {"provider": "one", "base_url": "https://one", "model": "m1"}
    message = LLMResponse(content="public", protocol={
        "owner": provider._protocol_owner(original),
        "openai": {"content": "public", "reasoning_content": "private"},
    }).assistant_message()
    assert provider._format_message(message, original)["reasoning_content"] == "private"
    assert provider._format_message(message, {**original, "model": "m2"}) == {"role": "assistant", "content": "public"}
