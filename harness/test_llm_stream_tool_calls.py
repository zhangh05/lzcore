"""Provider tool-call transport must preserve executable names and invalid JSON."""

import asyncio
import json
from types import SimpleNamespace

import pytest

from agent.llm import provider
from agent.llm.schemas import LLMRequest, LLMResponse
from core.runtime_engine.budget_controller import BudgetController
from core.runtime_engine.models import SSOTRuntimeConfig, StatelessContext
from core.runtime_engine.query_loop import QueryLoop
from extensions.network_operations import backend, topology_service as drawings


TOOL_NAME = "network__operations__topology"


def _stream(monkeypatch, deltas):
    chunks = [{"choices": [{"delta": delta, "finish_reason": None}]} for delta in deltas]
    chunks.append({"choices": [{"delta": {}, "finish_reason": "tool_calls"}]})
    lines = ["data: " + json.dumps(chunk) for chunk in chunks] + ["data: [DONE]"]
    response = SimpleNamespace(status_code=200, encoding=None, iter_lines=lambda **_kwargs: iter(lines))
    monkeypatch.setattr(provider, "_post_llm", lambda *_args, **_kwargs: response)
    return provider._api_generate_stream(
        "https://provider.invalid/v1/chat/completions", {}, {"api_key": "test", "provider": "test"},
        LLMRequest(task="assistant_chat", tools=[{"type": "function", "function": {"name": TOOL_NAME}}]),
    )


def _drawing_registry():
    spec = next(item for item in backend.register()["tools"] if item["tool_id"] == "network.operations.topology")
    return spec, {spec["tool_id"]: {
        "name": spec["name"], "input_schema": spec["input_schema"],
        "metadata": {"action_requirements": spec.get("action_requirements", {})},
    }}


def test_stream_assembles_fragmented_tool_name_and_preserves_early_call_id(monkeypatch):
    result = _stream(monkeypatch, [
        {"tool_calls": [{"index": 0, "id": "call-patch", "function": {"arguments": ""}}]},
        {"tool_calls": [{"index": 0, "function": {"name": "network__operations__", "arguments": '{"action":'}}]},
        {"tool_calls": [{"index": 0, "function": {"name": "topology", "arguments": '"patch"}'}}]},
    ])
    assert result.tool_calls[0].name == TOOL_NAME
    assert result.tool_calls[0].id == "call-patch"
    assert result.tool_calls[0].arguments == {"action": "patch"}


@pytest.mark.parametrize("transport", ["stream", "nonstream", "anthropic_stream", "anthropic_nonstream"])
@pytest.mark.parametrize("arguments", ['{"action":"patch","nodes":[', "[]", "null"])
def test_invalid_provider_arguments_cannot_turn_into_a_successful_drawing_read(monkeypatch, transport, arguments):
    if transport == "stream":
        result = _stream(monkeypatch, [{"tool_calls": [{
            "index": 0, "id": "bad", "function": {"name": TOOL_NAME, "arguments": arguments},
        }]}])
    elif transport == "nonstream":
        result = LLMResponse(tool_calls=provider._parse_tool_calls([{
            "id": "bad", "function": {"name": TOOL_NAME, "arguments": arguments},
        }]))
    elif transport == "anthropic_stream":
        events = [
            {"type": "content_block_start", "index": 0, "content_block": {
                "type": "tool_use", "id": "bad", "name": TOOL_NAME, "input": {},
            }},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": arguments}},
            {"type": "message_delta", "delta": {"stop_reason": "tool_use"}},
        ]
        response = SimpleNamespace(status_code=200, iter_lines=lambda **_kwargs: iter(
            ["data: " + json.dumps(event) for event in events],
        ))
        monkeypatch.setattr(provider, "_post_llm", lambda *_args, **_kwargs: response)
        result = provider._anthropic_messages_stream(
            "https://provider.invalid/v1/messages", {}, {}, {}, LLMRequest(task="assistant_chat"),
        )
    else:
        try:
            input_value = json.loads(arguments)
        except json.JSONDecodeError:
            input_value = arguments
        result = provider._parse_anthropic_messages_response({"content": [{
            "type": "tool_use", "id": "bad", "name": TOOL_NAME, "input": input_value,
        }]}, {})
    _, registry = _drawing_registry()
    loop = QueryLoop.__new__(QueryLoop)
    loop._tool_registry = registry
    calls = loop._parse_tool_calls(result.tool_calls)
    context = StatelessContext(workspace_id="stream-review", session_id="s", request_id="r", user_input="绘图")
    prepared = loop._prepare_tool_calls(context, calls)
    assert prepared["ok"] is False
    assert any(error["code"] == "INVALID_TOOL_ARGUMENTS_JSON" for error in prepared["validation_errors"])


def test_stream_does_not_silently_drop_a_call_with_a_missing_function_name(monkeypatch):
    result = _stream(monkeypatch, [{"tool_calls": [{
        "index": 0, "id": "nameless", "function": {"arguments": '{"action":"patch"}'},
    }]}])
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].id == "nameless"
    assert result.tool_calls[0].name == ""


@pytest.mark.parametrize("names", [[TOOL_NAME, TOOL_NAME], ["network__", TOOL_NAME]])
def test_stream_accepts_repeated_or_cumulative_published_full_names(monkeypatch, names):
    result = _stream(monkeypatch, [
        {"tool_calls": [{"index": 0, "id": "draw", "function": {"name": names[0], "arguments": '{"action":'}}]},
        {"tool_calls": [{"index": 0, "function": {"name": names[1], "arguments": '"read"}'}}]},
    ])
    assert result.tool_calls[0].name == TOOL_NAME
    assert result.tool_calls[0].arguments == {"action": "read"}


@pytest.mark.parametrize("truncated_first", [False, True])
def test_fragmented_drawing_call_saves_21_nodes_and_30_links_and_finishes(monkeypatch, truncated_first):
    from core.tools.executor import ToolExecutor
    from core.tools.registry import ToolRegistry
    from core.tools.schemas import ToolInvocation, ToolSpec

    workspace = "stream-drawing-review"
    drawing = drawings.save_topology(workspace, {"name": "Stream drawing", "nodes": [], "links": []})
    arguments = {
        "action": "patch", "version": drawing["version"],
        "nodes": [{"node_id": f"n{i}", "display_name": f"Router {i}"} for i in range(21)],
        "links": [{"source_node_id": f"n{i % 20}", "target_node_id": f"n{i % 20 + 1}",
                   "source_interface": f"GE0/{i}", "target_interface": f"GE0/{i}"} for i in range(30)],
    }
    encoded = json.dumps(arguments)
    response = _stream(monkeypatch, [
        {"tool_calls": [{"index": 0, "id": "draw", "function": {"name": "network__operations__", "arguments": encoded[:100]}}]},
        {"tool_calls": [{"index": 0, "function": {"name": "topology", "arguments": encoded[100:]}}]},
    ])
    spec, registry = _drawing_registry()
    gateway_registry = ToolRegistry()
    gateway_registry.register_tool(ToolSpec(
        tool_id=spec["tool_id"], category="ops", input_schema=spec["input_schema"], risk_level="medium",
    ), backend.topology_tool)
    gateway = ToolExecutor(gateway_registry)
    invoked = []

    class Runtime:
        def invoke_raw(self, tool_id, args):
            invoked.append(tool_id)
            return gateway.execute(ToolInvocation(
                tool_id=tool_id, workspace_id=workspace, skill=f"drawing:{drawing['topology_id']}", arguments=args,
            )).output

    prompts = []
    responses = [response, LLMResponse(content="已绘制 21 个节点和 30 条链路。")]
    if truncated_first:
        responses.insert(0, LLMResponse(
            content="准备绘制节点与链路。", tool_calls=response.tool_calls,
            finish_reason="length", metadata={"output_truncated": True},
        ))

    def llm(**kwargs):
        prompts.append(kwargs["messages"])
        return responses.pop(0) if responses else LLMResponse(error="LLM disabled")

    config = SSOTRuntimeConfig()
    context = StatelessContext(
        workspace_id=workspace, session_id="s", request_id="r", user_input="绘制 21 节点和 30 链路",
        extras={"workbench_context": {"extension_id": "network.operations", "skill_id": f"drawing:{drawing['topology_id']}"}},
    )
    result = asyncio.run(QueryLoop(config, registry, Runtime(), llm_invoke=llm).run(
        context, BudgetController(config), None,
    ))
    saved = drawings.get_topology(workspace, drawing["topology_id"])
    assert len(saved["nodes"]) == 21
    assert len(saved["links"]) == 30
    assert saved["version"] == drawing["version"] + 1
    assert invoked == [spec["tool_id"]]
    assert len(prompts) == (3 if truncated_first else 2)
    if truncated_first:
        assert "new complete native tool calls" in prompts[1][-1].content
        assert "None of those partial calls was executed" in prompts[1][-1].content
    assert result.error is None
