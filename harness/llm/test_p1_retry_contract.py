"""Retry decisions use typed failures; waits are simulated, never real."""
import pytest

from agent.llm.runtime import _generate_with_retry
from agent.llm.schemas import LLMRequest, LLMResponse


@pytest.mark.parametrize("status", [408, 425, 429, 500, 502, 503, 504])
@pytest.mark.parametrize("source", ["http_status", "error_type"])
def test_transient_http_failures_retry_without_matching_error_text(monkeypatch, status, source):
    attempts, waits = [], []
    def generate(*a):
        attempts.append(True)
        return LLMResponse(error="temporary", metadata={source: status if source == "http_status" else f"provider_http_{status}"})
    monkeypatch.setattr("agent.llm.provider.generate", generate)
    monkeypatch.setattr("time.sleep", waits.append)
    result = _generate_with_retry(LLMRequest(task="test"), {})
    assert len(attempts) == 4 and waits == [1.0, 2.0, 4.0]
    assert result.metadata["retryable"] and result.metadata["retries_exhausted"]


@pytest.mark.parametrize("metadata", [
    {"retryable": True}, {"error_type": "provider_network_error"},
    {"error_type": "provider_timeout"},
])
def test_typed_transient_failure_recovers(monkeypatch, metadata):
    responses = iter([LLMResponse(error="opaque", metadata=metadata), LLMResponse(content="recovered")])
    waits = []
    monkeypatch.setattr("agent.llm.provider.generate", lambda *a: next(responses))
    monkeypatch.setattr("time.sleep", waits.append)
    result = _generate_with_retry(LLMRequest(task="test"), {})
    assert result.content == "recovered" and waits == [1.0]


@pytest.mark.parametrize("status,error,declared", [
    (400, "invalid", True), (401, "unauthorized", True), (403, "forbidden", True),
    (402, "opaque", True), (429, "insufficient_quota", True),
    (503, "explicitly permanent", False), (None, "request contains number 503", None),
])
def test_permanent_errors_and_explicit_rejection_never_retry(monkeypatch, status, error, declared):
    calls = []
    metadata = {"http_status": status}
    if declared is not None:
        metadata["retryable"] = declared
    monkeypatch.setattr("agent.llm.provider.generate", lambda *a: calls.append(True) or LLMResponse(error=error, metadata=metadata))
    monkeypatch.setattr("time.sleep", lambda *_: pytest.fail("permanent failures cannot sleep"))
    result = _generate_with_retry(LLMRequest(task="test"), {})
    assert len(calls) == 1 and result.metadata["retryable"] is False


@pytest.mark.parametrize("retry_after,delay", [("7", 7.0), ("invalid", 1.0), ("nan", 1.0), ("-1", 1.0), ("120", 60.0)])
def test_retry_after_uses_valid_bounded_delay(monkeypatch, retry_after, delay):
    responses = iter([LLMResponse(error="opaque", metadata={"http_status": 503, "retry_after": retry_after}), LLMResponse(content="OK")])
    waits = []
    monkeypatch.setattr("agent.llm.provider.generate", lambda *a: next(responses))
    monkeypatch.setattr("time.sleep", waits.append)
    assert not _generate_with_retry(LLMRequest(task="test"), {}).error
    assert waits == [delay]


@pytest.mark.parametrize("cancel_at", ["before", "wait", "next_request"])
def test_cancellation_prevents_retry_and_interrupts_backoff(monkeypatch, cancel_at):
    calls, waits = [], []
    cancelled = cancel_at == "before"
    def generate(*a):
        nonlocal cancelled
        calls.append(True)
        cancelled = cancel_at == "next_request"
        return LLMResponse(error="opaque", metadata={"http_status": 503, "retry_after": "30"})
    def sleep(delay):
        nonlocal cancelled
        waits.append(delay)
        cancelled = True
    monkeypatch.setattr("agent.llm.provider.generate", generate)
    monkeypatch.setattr("time.sleep", sleep)
    result = _generate_with_retry(LLMRequest(task="test", cancel_check=lambda: cancelled), {})
    assert result.metadata["stream_cancelled"]
    assert len(calls) == (0 if cancel_at == "before" else 1)
    assert waits == ([0.25] if cancel_at == "wait" else [])


@pytest.mark.parametrize("protocol", ["openai", "anthropic"])
def test_http_retry_after_header_reaches_runtime_backoff(monkeypatch, protocol):
    from types import SimpleNamespace
    from agent.llm import provider
    closed, waits, calls = [], [], []
    response = SimpleNamespace(status_code=503, text="temporary", headers={"Retry-After": "7"},
                               close=lambda: closed.append(True))
    monkeypatch.setattr(provider, "_post_llm", lambda *a, **kw: response)
    def generate(req, cfg):
        calls.append(True)
        if len(calls) > 1:
            return LLMResponse(content="recovered")
        if protocol == "openai":
            return provider._api_generate_stream("https://invalid", {}, cfg, req)
        return provider._anthropic_messages_stream("https://invalid", {}, {}, cfg, req)
    monkeypatch.setattr(provider, "generate", generate)
    monkeypatch.setattr("time.sleep", waits.append)
    assert _generate_with_retry(LLMRequest(task="test"), {}).content == "recovered"
    assert len(calls) == 2 and waits == [7.0] and closed == [True]


def test_retry_after_http_date_uses_server_requested_delay(monkeypatch):
    import datetime as dt
    from agent.llm.runtime import _retry_delay
    fixed = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
    class Clock(dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return fixed
    monkeypatch.setattr(dt, "datetime", Clock)
    assert _retry_delay(LLMResponse(metadata={"retry_after": "Thu, 01 Jan 2026 00:00:09 GMT"}), 0) == 9.0
