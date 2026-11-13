import json
from types import SimpleNamespace

import pytest

from agent.llm.client import LLMClient
from agent.llm.schemas import LLMResponse


def _client(monkeypatch, protocol="openai_compatible"):
    cfg = {
        "enabled": True, "provider": "synthetic", "provider_type": protocol,
        "base_url": "https://example.invalid/v1", "model": "synthetic-model",
        "api_key": "AUDIT_ONLY_CREDENTIAL_1234567890",
    }
    monkeypatch.setenv("LZCORE_LLM_ENABLED", "true")
    monkeypatch.setattr("agent.llm.client.resolve_provider_config", lambda: cfg)
    return LLMClient(), cfg["api_key"]


@pytest.mark.parametrize("protocol", ["openai_compatible", "anthropic_messages"])
@pytest.mark.parametrize("offset", [0, 190, 490])
def test_probe_redaction_precedes_http_body_truncation(monkeypatch, protocol, offset):
    client, key = _client(monkeypatch, protocol)
    def post(*_args, **_kwargs):
        return SimpleNamespace(status_code=401, text="X" * offset + key + " rejected")
    monkeypatch.setattr("agent.llm.provider._post_llm", post)
    result = client.probe()
    assert not result["ok"]
    assert result["metadata"]["http_status"] == 401
    assert result["metadata"]["error_type"] == "provider_http_401"
    assert key[:8] not in json.dumps(result)


def test_probe_redaction_covers_nested_metadata_content_and_exceptions(monkeypatch):
    client, key = _client(monkeypatch)
    def generate(*_args):
        return LLMResponse(
            error="Rejected credential " + key, content=key,
            metadata={"http_status": 401, key: [{"detail": key}], "[REDACTED]": "other detail"},
        )
    monkeypatch.setattr("agent.llm.provider.generate", generate)
    result = client.probe()
    assert key not in json.dumps(result)
    assert result["metadata"]["http_status"] == 401
    assert len(result["metadata"]) == 3
    assert "other detail" in result["metadata"].values()
    def broken(*_args):
        raise RuntimeError("Rejected credential " + key)
    monkeypatch.setattr("agent.llm.provider.generate", broken)
    result = client.probe()
    assert not result["ok"]
    assert result["metadata"]["error_type"] == "provider_probe_error"
    assert key not in json.dumps(result)


def test_probe_api_and_recent_failure_only_receive_redacted_details(monkeypatch):
    from flask import Flask
    from backend.api import llm_api
    _, key = _client(monkeypatch)
    def generate(*_args):
        return LLMResponse(error="Rejected credential " + key,
                           metadata={"http_status": 401, "detail": key})
    failures = []
    monkeypatch.setattr("agent.llm.provider.generate", generate)
    monkeypatch.setattr(llm_api, "probe_allows_draft_overrides", lambda: False)
    monkeypatch.setattr("agent.llm.config.record_recent_failure", lambda *args: failures.append(args))
    app = Flask(__name__)
    with app.test_request_context(json={}):
        response = llm_api.handle_llm_test()
    assert response.json["ok"] is False
    assert response.json["metadata"]["http_status"] == 401
    assert key not in response.get_data(as_text=True)
    assert failures and key not in str(failures)
