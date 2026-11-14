"""Tagged private text never reaches public streaming or persisted answers."""
import json
from io import BytesIO

import pytest
import requests

from agent.llm import provider
from agent.llm.prompt_guard import sanitize_provider_output
from agent.llm.reasoning_filter import ReasoningFilter
from agent.llm.schemas import LLMRequest


@pytest.mark.parametrize("text,expected", [
    ("公开前缀<think>synthetic private reasoning", "公开前缀"),
    ("<ThInK>private</tHiNk>PUBLIC", "PUBLIC"),
    ("<reasoning>private<think>nested</think>still private</reasoning>OK", "OK"),
    ("public<thi", "public"),
    ("思考过程：按钮名称\n点击“思考过程”后保存。", "思考过程：按钮名称\n点击“思考过程”后保存。"),
    ("Reasoning: an ordinary heading\nKeep this text.", "Reasoning: an ordinary heading\nKeep this text."),
    ("```xml\n<think>literal example</think>\n```", "```xml\n<think>literal example</think>\n```"),
    ("~~~xml\n<reasoning>literal</reasoning>\n~~~", "~~~xml\n<reasoning>literal</reasoning>\n~~~"),
    ("Use `<think>example</think>` here.", "Use `<think>example</think>` here."),
    ("> <think>quoted example</think>\nPublic", "> <think>quoted example</think>\nPublic"),
    (r"Use \<think> as an escaped literal.", r"Use \<think> as an escaped literal."),
])
def test_final_and_incremental_projection_agree_for_every_split(text, expected):
    cleaned, stripped = sanitize_provider_output(text)
    assert cleaned == expected
    assert stripped is (expected != text)
    for split in range(len(text) + 1):
        projection = ReasoningFilter()
        public = projection.feed(text[:split]) + projection.feed(text[split:]) + projection.feed("", final=True)
        assert public == expected
    projection = ReasoningFilter()
    assert "".join(projection.feed(char) for char in text) + projection.feed("", final=True) == expected


class Stream:
    status_code = 200

    def __init__(self, events, failure=None):
        self.events, self.failure = events, failure

    def iter_lines(self, **kwargs):
        for event in self.events:
            yield "data: " + (event if isinstance(event, str) else json.dumps(event))
        if self.failure:
            raise self.failure

    def close(self):
        pass


@pytest.mark.parametrize("protocol", ["openai", "anthropic"])
@pytest.mark.parametrize("closed", [True, False])
@pytest.mark.parametrize("ending", ["complete", "eof", "error"])
def test_stream_hides_split_private_tags_but_keeps_native_content(monkeypatch, protocol, closed, ending):
    tokens = ["PUBLIC", "<", "Th", "InK>", "PRIVATE"]
    if closed:
        tokens += ["</t", "hink", ">", "ANSWER"]
    if protocol == "openai":
        events = [{"choices": [{"delta": {"content": t}}]} for t in tokens] + ["[DONE]"]
    else:
        events = [
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            *[{"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": t}} for t in tokens],
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn"}},
            {"type": "message_stop"},
        ]
    if ending != "complete":
        events = events[:-1] if protocol == "openai" else events[:-3]
    monkeypatch.setattr(provider, "_post_llm", lambda *a, **kw: Stream(
        events, ConnectionResetError("synthetic disconnect") if ending == "error" else None,
    ))
    displayed = []
    monkeypatch.setattr(provider, "_push_stream_token", displayed.append)
    req = LLMRequest(task="assistant_chat", metadata={"stream_to_user": True})
    cfg = {"provider": "test", "model": "test", "api_key": "synthetic"}
    if protocol == "openai":
        result = provider._api_generate_stream("https://invalid", {}, cfg, req)
    else:
        result = provider._anthropic_messages_stream("https://invalid", {}, {}, cfg, req)
    assert bool(result.error) is (ending != "complete")
    assert "".join(displayed) == "PUBLIC" + ("ANSWER" if closed else "")
    assert "PRIVATE" in result.content
    if ending == "complete":
        assert "PRIVATE" in json.dumps(result.protocol)
    else:
        assert not result.protocol and not result.tool_calls


def test_anthropic_stream_decodes_utf8_text_and_tool_arguments(monkeypatch):
    events = [
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "中文测试"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "t", "name": "search", "input": {}}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '{"query":"中文参数"}'}},
        {"type": "content_block_stop", "index": 1},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use"}},
        {"type": "message_stop"},
    ]
    response = requests.Response()
    response.status_code = 200
    response.headers["Content-Type"] = "text/event-stream"
    response.encoding = requests.utils.get_encoding_from_headers(response.headers)
    assert response.encoding == "ISO-8859-1"
    response.raw = BytesIO("".join("data: " + json.dumps(e, ensure_ascii=False) + "\n\n" for e in events).encode("utf-8"))
    monkeypatch.setattr(provider, "_post_llm", lambda *a, **kw: response)
    result = provider._anthropic_messages_stream("https://invalid", {}, {}, {}, LLMRequest(task="test"))
    assert result.error is None and result.content == "中文测试"
    assert result.tool_calls[0].arguments == {"query": "中文参数"}
    assert response.raw.closed


@pytest.mark.parametrize("text,expected", [
    ("公开<think>private", "公开"),
    ("思考过程：按钮名称\n保存", "思考过程：按钮名称\n保存"),
    ("```xml\n<think>literal</think>\n```", "```xml\n<think>literal</think>\n```"),
])
def test_message_storage_uses_same_reasoning_projection(text, expected):
    from storage.message_store import SessionMessageStore
    store = SessionMessageStore("reasoning-test", "reasoning-ws")
    store.write_message("run1", "assistant", text)
    assert store.get_messages()[0]["content"] == expected
