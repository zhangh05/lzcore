"""Incomplete provider batches must never expose executable tool proposals."""

import json

import pytest
import requests

from agent.llm import provider
from agent.llm.runtime import _generate_with_retry
from agent.llm.schemas import LLMRequest


class Stream:
    status_code = 200
    encoding = None

    def __init__(self, events, failure=None):
        self.events = events
        self.failure = failure
        self.closed = False

    def iter_lines(self, **_kwargs):
        for event in self.events:
            if isinstance(event, dict) and event.get("type"):
                yield "event: " + event["type"]
            yield "data: " + (event if isinstance(event, str) else json.dumps(event))
        if self.failure:
            raise self.failure

    def close(self):
        self.closed = True


def _partial(protocol):
    if protocol == "openai":
        return [{"choices": [{"delta": {"content": "partial", "tool_calls": [{
            "index": 0, "id": "write-1", "function": {
                "name": "audit__write", "arguments": '{"action":"write"}',
            },
        }]}, "finish_reason": None}]}]
    return [
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "partial"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "content_block_start", "index": 1, "content_block": {
            "type": "tool_use", "id": "write-1", "name": "audit__write", "input": {},
        }},
        {"type": "content_block_delta", "index": 1, "delta": {
            "type": "input_json_delta", "partial_json": '{"action":"write"}',
        }},
    ]


def _invoke(protocol, req):
    cfg = {"provider": "test", "model": "test", "api_key": "synthetic"}
    if protocol == "openai":
        return provider._api_generate_stream("https://provider.invalid", {}, cfg, req)
    return provider._anthropic_messages_stream("https://provider.invalid", {}, {}, cfg, req)


@pytest.mark.parametrize("protocol", ["openai", "anthropic"])
@pytest.mark.parametrize("failure,error_type,retryable", [
    (None, provider.ERROR_TYPE_PROVIDER_NETWORK_ERROR, True),
    (ConnectionResetError("reset"), provider.ERROR_TYPE_PROVIDER_NETWORK_ERROR, True),
    (requests.exceptions.Timeout("timeout"), provider.ERROR_TYPE_PROVIDER_TIMEOUT, True),
    (RuntimeError("fault"), provider.ERROR_TYPE_PROVIDER_UNKNOWN, False),
])
def test_stream_failure_discards_complete_json_tool_calls(monkeypatch, protocol, failure, error_type, retryable):
    response = Stream(_partial(protocol), failure)
    monkeypatch.setattr(provider, "_post_llm", lambda *a, **kw: response)
    displayed = []
    monkeypatch.setattr(provider, "_push_stream_token", displayed.append)
    result = _invoke(protocol, LLMRequest(task="assistant_chat", metadata={"stream_to_user": True}))

    assert result.error
    assert result.metadata["error_type"] == error_type
    assert result.metadata["retryable"] is retryable
    assert result.content == "partial" and displayed == ["partial"]
    assert result.tool_calls == [] and result.protocol == {}
    assert response.closed


@pytest.mark.parametrize("protocol", ["openai", "anthropic"])
@pytest.mark.parametrize("kind,error_type,retryable", [
    ("overloaded_error", "provider_http_503", True),
    ("rate_limit_error", "provider_http_429", True),
    ("authentication_error", "provider_http_401", False),
    ("invalid_request_error", "provider_http_400", False),
])
def test_stream_error_event_is_failure_even_after_text(monkeypatch, protocol, kind, error_type, retryable):
    event = {"error": {"type": kind, "message": "synthetic raw provider detail"}}
    if protocol == "anthropic":
        event["type"] = "error"
    response = Stream(["ping", *_partial(protocol), ": keep-alive", "", event],
                      failure=AssertionError("must stop reading after error event"))
    monkeypatch.setattr(provider, "_post_llm", lambda *a, **kw: response)
    result = _invoke(protocol, LLMRequest(task="assistant_chat"))
    assert result.error and result.metadata["error_type"] == error_type
    assert result.metadata["retryable"] is retryable
    assert result.tool_calls == [] and result.protocol == {}
    assert "synthetic raw" not in result.error
    assert response.closed


@pytest.mark.parametrize("ending", [
    ["[DONE]"],
    [{"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}],
    [{"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
     {"choices": [{"delta": {}, "finish_reason": None}]}],
])
def test_openai_stream_accepts_explicit_gateway_completion(monkeypatch, ending):
    response = Stream([*_partial("openai"), *ending])
    monkeypatch.setattr(provider, "_post_llm", lambda *a, **kw: response)
    result = _invoke("openai", LLMRequest(task="assistant_chat"))
    assert result.error is None
    assert result.tool_calls[0].arguments == {"action": "write"}
    assert response.closed


@pytest.mark.parametrize("block_stopped,reason,message_stopped,success", [
    (True, "tool_use", True, True),
    (True, "tool_use", False, False),
    (True, None, True, False),
    (False, "tool_use", True, False),
])
def test_anthropic_stream_requires_message_and_block_completion(monkeypatch, block_stopped, reason, message_stopped, success):
    events = _partial("anthropic")
    if block_stopped:
        events.append({"type": "content_block_stop", "index": 1})
    events.append({"type": "message_delta", "delta": {"stop_reason": reason}})
    if message_stopped:
        events.append({"type": "message_stop"})
    monkeypatch.setattr(provider, "_post_llm", lambda *a, **kw: Stream(events))
    result = _invoke("anthropic", LLMRequest(task="assistant_chat"))
    assert (result.error is None) is success
    assert len(result.tool_calls) == (1 if success else 0)


@pytest.mark.parametrize("protocol", ["openai", "anthropic"])
@pytest.mark.parametrize("retryable", [True, False])
def test_stream_failure_retry_uses_typed_contract_and_returns_no_tools(monkeypatch, protocol, retryable):
    attempts, sleeps = [], []
    def generate(req, cfg):
        attempts.append(req)
        return _invoke(protocol, req)
    failure = ConnectionResetError("reset") if retryable else RuntimeError("fault")
    monkeypatch.setattr(provider, "_post_llm", lambda *a, **kw: Stream(_partial(protocol), failure))
    monkeypatch.setattr(provider, "generate", generate)
    monkeypatch.setattr("time.sleep", sleeps.append)
    result = _generate_with_retry(LLMRequest(task="assistant_chat"), {}, max_retries=2)
    assert result.error and result.tool_calls == [] and result.protocol == {}
    assert result.metadata["retryable"] is retryable
    assert len(attempts) == (3 if retryable else 1)
    assert sleeps == ([1.0, 2.0] if retryable else [])


@pytest.mark.parametrize("protocol,ending", [
    ("openai", ["[DONE]"]),
    ("openai", [{"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}]),
    ("anthropic", [
        {"type": "content_block_stop", "index": 1},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use"}},
        {"type": "message_stop"},
    ]),
])
def test_stream_skips_non_json_keepalives_when_completed(monkeypatch, protocol, ending):
    events = ["ping", "", ": keep-alive"]
    for chunk in [*_partial(protocol), *ending]:
        events.extend(["{invalid", chunk, ": keep-alive", ""])
    response = Stream(events)
    monkeypatch.setattr(provider, "_post_llm", lambda *a, **kw: response)
    displayed = []
    monkeypatch.setattr(provider, "_push_stream_token", displayed.append)
    result = _invoke(protocol, LLMRequest(task="assistant_chat", metadata={"stream_to_user": True}))

    assert result.error is None
    assert result.content == "partial" and displayed == ["partial"]
    assert result.tool_calls[0].arguments == {"action": "write"}
    assert result.protocol and response.closed


@pytest.mark.parametrize("protocol", ["openai", "anthropic"])
@pytest.mark.parametrize("partial", [False, True])
def test_stream_non_json_lines_without_completion_fail(monkeypatch, protocol, partial):
    response = Stream([*(_partial(protocol) if partial else []), "ping", ": keep-alive", "", "{invalid"])
    monkeypatch.setattr(provider, "_post_llm", lambda *a, **kw: response)
    result = _invoke(protocol, LLMRequest(task="assistant_chat"))
    assert result.error and result.tool_calls == [] and result.protocol == {}
    assert result.content == ("partial" if partial else "")
    assert result.metadata["error_type"] == provider.ERROR_TYPE_PROVIDER_NETWORK_ERROR
    assert result.metadata["retryable"] is True
    assert response.closed


def test_openai_stream_accepts_null_error_on_normal_chunks(monkeypatch):
    chunks = [
        *_partial("openai"),
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
    ]
    response = Stream([{**chunk, "error": None} for chunk in chunks] + ["[DONE]"])
    monkeypatch.setattr(provider, "_post_llm", lambda *a, **kw: response)
    result = _invoke("openai", LLMRequest(task="assistant_chat"))

    assert result.error is None
    assert result.content == "partial"
    assert result.finish_reason == "tool_calls"
    assert result.tool_calls[0].arguments == {"action": "write"}
    assert response.closed


@pytest.mark.parametrize("protocol", ["openai", "anthropic"])
@pytest.mark.parametrize("payload", [42, 3.5, None, True, [], ["error"], "error"])
@pytest.mark.parametrize("completed", [False, True])
def test_stream_skips_non_dict_json_without_bypassing_completion(monkeypatch, protocol, payload, completed):
    events = []
    for chunk in _partial(protocol):
        events.extend([json.dumps(payload), chunk])
    events.append(json.dumps(payload))
    if completed:
        events.extend(["[DONE]"] if protocol == "openai" else [
            {"type": "content_block_stop", "index": 1},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use"}},
            {"type": "message_stop"},
        ])
    response = Stream(events)
    monkeypatch.setattr(provider, "_post_llm", lambda *a, **kw: response)
    displayed = []
    monkeypatch.setattr(provider, "_push_stream_token", displayed.append)
    result = _invoke(protocol, LLMRequest(task="assistant_chat", metadata={"stream_to_user": True}))

    assert result.content == "partial" and displayed == ["partial"]
    if completed:
        assert result.error is None
        assert result.tool_calls[0].arguments == {"action": "write"}
        assert result.protocol
    else:
        assert result.error
        assert result.metadata["error_type"] == provider.ERROR_TYPE_PROVIDER_NETWORK_ERROR
        assert result.tool_calls == [] and result.protocol == {}
    assert response.closed
