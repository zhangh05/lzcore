"""Unavailable providers must not become counterfeit engineering attempts."""

import json

import pytest

from agent.llm.schemas import LLMResponse
from scripts.benchmark_preflight import provider_preflight


CONFIG = {
    "enabled": True, "key_loaded": True, "api_key": "private-canary",
    "provider": "configured", "model": "configured-model",
    "provider_type": "anthropic_messages",
}


@pytest.mark.parametrize("changes", [
    {"enabled": False}, {"key_loaded": False}, {"api_key": ""},
    {"provider_type": "mock"}, {"provider_type": "disabled"},
])
def test_missing_or_synthetic_provider_never_starts_probe(monkeypatch, changes):
    def unexpected(*args):
        raise AssertionError("unconfigured probe must not run")
    monkeypatch.setattr("agent.llm.provider.generate", unexpected)
    result = provider_preflight({**CONFIG, **changes})
    assert result["status"] == "BLOCKED"
    assert result["reason"] == "real_provider_not_configured"


@pytest.mark.parametrize("status,reason", [
    (401, "provider_authentication_failed"),
    (403, "provider_access_denied"),
    (429, "provider_rate_or_quota_limit"),
    (400, "provider_request_failed"),
])
def test_provider_rejections_preserve_category_without_private_body(monkeypatch, status, reason):
    monkeypatch.setattr("agent.llm.provider.generate", lambda *args: LLMResponse(
        error="private-canary rejected", metadata={"http_status": status,
        "request_headers": {"Authorization": "private-canary"}}))
    result = provider_preflight(CONFIG)
    assert result["status"] == "BLOCKED" and result["reason"] == reason
    assert result["http_status"] == status
    assert "private-canary" not in json.dumps(result)
    assert result["agent_started"] is False


def test_probe_exception_and_empty_response_are_not_ready(monkeypatch):
    def fail(*args):
        raise RuntimeError("private-canary")
    monkeypatch.setattr("agent.llm.provider.generate", fail)
    result = provider_preflight(CONFIG)
    assert result["reason"] == "provider_probe_exception"
    assert "private-canary" not in json.dumps(result)
    monkeypatch.setattr("agent.llm.provider.generate", lambda *args: LLMResponse(content=""))
    assert provider_preflight(CONFIG)["reason"] == "provider_empty_response"


def test_ready_uses_canonical_transport_without_mutating_config(monkeypatch):
    def accepted(request, config):
        assert request.task == "connection_probe" and not request.tools
        assert request.metadata["stream_to_user"] is False
        assert config["api_key"] == "private-canary"
        assert config["max_tokens"] == 16
        return LLMResponse(content="OK", metadata={"http_status": 200})
    original = dict(CONFIG)
    monkeypatch.setattr("agent.llm.provider.generate", accepted)
    assert provider_preflight(CONFIG)["status"] == "READY"
    assert CONFIG == original


def test_accepted_reasoning_budget_is_not_an_authentication_failure(monkeypatch):
    monkeypatch.setattr("agent.llm.provider.generate", lambda *args: LLMResponse(
        content="", finish_reason="length", usage={"completion_tokens": 16}))
    assert provider_preflight(CONFIG)["status"] == "READY"
