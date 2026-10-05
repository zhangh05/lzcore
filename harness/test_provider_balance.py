"""Billing cannot recover by automatically repeating the same paid request."""

import asyncio
import pytest

from agent.llm.schemas import LLMRequest, LLMResponse, LLMToolCall
from core.runtime_engine.budget_controller import BudgetController
from core.runtime_engine.models import SSOTRuntimeConfig, StatelessContext
from core.runtime_engine.query_loop import QueryLoop
from core.runtime_engine.tool_runtime import ToolRuntime


@pytest.mark.parametrize(
    "error,status",
    [
        ("provider_http_402: balance_insufficient", 402),
        ("provider_http_429: insufficient_quota", 429),
        ("You account balance exceeded your current quota", None),
        ("Credit balance is too low", None),
        ("余额不足", None),
        ("private-canary", 402),
    ],
)
def test_billing_failure_stops_unbounded_loop_and_preserves_completed_tool_results(
    error, status
):
    config = SSOTRuntimeConfig(max_query_loop_iterations=0, max_llm_calls=5)
    runtime = ToolRuntime(config)
    executions = []
    runtime.register(
        "data.manage",
        lambda args: executions.append(args) or {"ok": True, "rows": ["preserved"]},
    )
    registry = {
        "data.manage": {
            "description": "fixture",
            "args_schema": {
                "type": "object",
                "properties": {
                    "action": {"type": "string"},
                    "text": {"type": "string"},
                },
            },
        }
    }
    calls = []

    def model(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            return LLMResponse(
                tool_calls=[
                    LLMToolCall(
                        id="one",
                        name="data.manage",
                        arguments={"action": "parse", "text": "preserve"},
                    )
                ]
            )
        return LLMResponse(error=error, metadata={"http_status": status})

    ctx = StatelessContext("ws", "billing", "billing", "Finish")
    result = asyncio.run(
        QueryLoop(config, registry, runtime, llm_invoke=model).run(
            ctx, BudgetController(config), None
        )
    )
    assert len(calls) == 2 and len(executions) == 1 and len(result.tool_results) == 1
    assert (
        result.error == "llm_balance_insufficient"
        and "余额或额度不足" in result.final_response
    )
    assert ctx.extras["response_outcome"] == "llm_balance_insufficient"
    assert "private-canary" not in result.final_response


@pytest.mark.parametrize(
    "error,status,exhausted",
    [
        ("provider_http_402: balance_insufficient", 402, True),
        ("provider_http_429: insufficient_quota", 429, True),
        ("provider_http_429: rate limit exceeded", 429, False),
    ],
)
def test_transport_retry_distinguishes_balance_from_temporary_rate_limit(
    monkeypatch, error, status, exhausted
):
    from agent.llm.runtime import _generate_with_retry

    calls = []

    def generate(*a):
        calls.append(True)
        return (
            LLMResponse(error=error, metadata={"http_status": status})
            if len(calls) == 1
            else LLMResponse(content="recovered")
        )

    monkeypatch.setattr("agent.llm.provider.generate", generate)
    monkeypatch.setattr("time.sleep", lambda *a: None)
    result = _generate_with_retry(
        LLMRequest(task="probe", messages=[]), {}, max_retries=1
    )
    assert len(calls) == (1 if exhausted else 2)
    assert bool(result.error) == exhausted
    if exhausted:
        assert result.metadata["retryable"] is False
