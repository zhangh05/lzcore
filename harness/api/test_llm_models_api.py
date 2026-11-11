"""Model discovery transport, normalization, secrets and authorization contracts."""

import io
import json
from types import SimpleNamespace
from urllib.error import HTTPError, URLError

import pytest
from flask import session

from agent.llm import model_catalog


@pytest.fixture
def catalog(monkeypatch, tmp_path):
    import agent.llm.provider_store as store
    from backend.main import create_app

    monkeypatch.setattr(store, "PROVIDERS_DIR", tmp_path / "providers")
    monkeypatch.setattr(store, "ACTIVE_FILE", tmp_path / "providers" / "_active")
    for key in ("LZCORE_IDENTITY_ENABLED", "LZCORE_AUTH_ENABLED", "LZCORE_LOGIN_ENABLED"):
        monkeypatch.setenv(key, "false")
    monkeypatch.setenv("RATE_LIMIT_DISABLED", "true")
    store.save_provider_config("deepseek", {
        "base_url": "https://saved.example/v1", "api_key": "test-saved-key",
    })
    store.set_active_provider("deepseek")
    calls = []
    response = {"payload": {"data": []}}

    def urlopen(req, timeout):
        calls.append((req, timeout))
        if "error" in response:
            raise response["error"]
        body = response.get("body")
        if body is None:
            body = json.dumps(response["payload"]).encode()
        return io.BytesIO(body)

    monkeypatch.setattr(model_catalog, "urlopen", urlopen)
    app = create_app()
    app.config.update(TESTING=True, SECRET_KEY="synthetic-session-secret")
    return SimpleNamespace(app=app, client=app.test_client(), store=store, calls=calls, response=response)


def test_openai_models_use_active_config_and_normalize(catalog):
    catalog.response["payload"] = {"data": [
        {"id": "z-model", "owned_by": "vendor", "created": 123},
        {"id": "a-model"}, {"id": "z-model"}, {"id": ""}, {"id": 42}, None,
    ]}
    response = catalog.client.post("/api/agent/llm/models", json={})
    assert response.status_code == 200
    assert response.json == {"ok": True, "source": "saved.example", "models": [
        {"id": "a-model", "label": "a-model"},
        {"id": "z-model", "label": "z-model", "owned_by": "vendor"},
    ]}
    req, timeout = catalog.calls[0]
    assert req.full_url == "https://saved.example/v1/models"
    assert req.get_method() == "GET" and timeout == 10
    assert req.get_header("Authorization") == "Bearer test-saved-key"


def test_ollama_models_and_empty_draft_key(catalog):
    catalog.response["payload"] = {"models": [
        {"name": "llama:latest"}, {"model": "gemma:latest"}, {"model": "llama:latest"},
    ]}
    response = catalog.client.post("/api/agent/llm/models", json={
        "provider": "ollama", "base_url": "http://localhost:11434/", "api_key": "",
    })
    assert response.status_code == 200
    assert response.json == {"ok": True, "source": "localhost", "models": [
        {"id": "gemma:latest", "label": "gemma:latest"},
        {"id": "llama:latest", "label": "llama:latest"},
    ]}
    req, _ = catalog.calls[0]
    assert req.full_url == "http://localhost:11434/models"
    assert not req.has_header("Authorization")


@pytest.mark.parametrize("base_url", ["https://draft.example", "https://draft.example/v1/"])
def test_anthropic_draft_headers_path_and_labels(catalog, base_url):
    catalog.response["payload"] = {"data": [{"id": "claude-model", "display_name": "Claude Model"}]}
    response = catalog.client.post("/api/agent/llm/models", json={
        "provider": "deepseek", "provider_type": "anthropic_messages",
        "base_url": base_url, "api_key": "test-draft-key",
    })
    assert response.status_code == 200
    assert response.json == {"ok": True, "source": "draft.example", "models": [
        {"id": "claude-model", "label": "Claude Model"},
    ]}
    req, _ = catalog.calls[0]
    assert req.full_url == "https://draft.example/v1/models"
    assert req.get_header("X-api-key") == "test-draft-key"
    assert req.get_header("Anthropic-version") == "2023-06-01"
    assert not req.has_header("Authorization")
    assert catalog.store.get_active_provider() == "deepseek"
    assert catalog.store.load_provider_config("deepseek")["api_key"] == "test-saved-key"
    assert catalog.store.load_provider_config("deepseek")["provider_type"] == "openai_compatible"


def test_identity_viewer_handler_ignores_all_draft_overrides(catalog, monkeypatch):
    from backend.api.llm_api import handle_llm_models
    import backend.core.identity as identity

    monkeypatch.setenv("LZCORE_IDENTITY_ENABLED", "true")
    monkeypatch.setattr(identity, "get_user", lambda _: {"enabled": True, "role": "viewer"})
    with catalog.app.test_request_context("/api/agent/llm/models", method="POST", json={
        "provider": "ollama", "provider_type": "anthropic_messages",
        "base_url": "https://untrusted.example", "api_key": "test-untrusted-key",
    }):
        session.update(lzcore_user="test-viewer", lzcore_role="viewer")
        assert handle_llm_models().json["ok"] is True
    req, _ = catalog.calls[0]
    assert req.full_url == "http://localhost:11434/v1/models"
    assert not req.has_header("Authorization") and not req.has_header("X-api-key")


@pytest.mark.parametrize("role,expected_status", [("viewer", 403), ("operator", 403), ("admin", 200)])
def test_models_route_keeps_existing_identity_admin_rule(catalog, monkeypatch, role, expected_status):
    import backend.core.identity as identity

    monkeypatch.setenv("LZCORE_IDENTITY_ENABLED", "true")
    monkeypatch.setattr(identity, "get_user", lambda _: {"enabled": True, "role": role})
    with catalog.client.session_transaction() as current:
        current["lzcore_user"] = "test-user"
    response = catalog.client.post("/api/agent/llm/models", json={})
    assert response.status_code == expected_status
    if expected_status == 403:
        assert response.json == {"ok": False, "error": "forbidden"}
        assert not catalog.calls
    else:
        assert response.json["ok"] is True
        assert len(catalog.calls) == 1


def test_unknown_provider_returns_404_without_network(catalog):
    response = catalog.client.post("/api/agent/llm/models", json={"provider": "missing-provider"})
    assert response.status_code == 404
    assert response.json == {"ok": False, "error": "unknown provider"}
    assert not catalog.calls


@pytest.mark.parametrize("draft", [
    {"base_url": "file:///tmp/models"}, {"base_url": "https://key@gateway.example/v1"},
    {"base_url": "https://gateway.example/v1?api_key=secret"},
    {"provider_type": "unsupported"}, {"api_key": 123},
])
def test_invalid_config_returns_400_before_network(catalog, draft):
    response = catalog.client.post("/api/agent/llm/models", json=draft)
    assert response.status_code == 400
    assert response.json["ok"] is False and response.json["errors"]
    assert not catalog.calls


@pytest.mark.parametrize("payload", [[], "not-an-object", 0])
def test_non_object_request_returns_400(catalog, payload):
    response = catalog.client.post("/api/agent/llm/models", json=payload)
    assert response.status_code == 400
    assert not catalog.calls


def test_http_error_redacts_raw_key_before_truncation(catalog):
    api_key = "test-saved-key"
    message = "bad credential " + api_key + " Bearer other-token " + "x" * 600 + api_key
    catalog.response["error"] = HTTPError(
        "https://saved.example/v1/models", 401, "Unauthorized", {},
        io.BytesIO(json.dumps({"error": {"message": message}}).encode()),
    )
    response = catalog.client.post("/api/agent/llm/models", json={})
    assert response.status_code == 200
    assert response.json["ok"] is False and response.json["http_status"] == 401
    assert "[REDACTED]" in response.json["error"]
    assert api_key not in response.text and "other-token" not in response.text
    assert len(response.json["error"]) < 550


def test_network_error_is_provider_state_and_redacted(catalog):
    catalog.response["error"] = URLError("connection failed for test-saved-key")
    response = catalog.client.post("/api/agent/llm/models", json={})
    assert response.status_code == 200
    assert response.json["ok"] is False and "http_status" not in response.json
    assert "test-saved-key" not in response.text


def test_model_limit_applies_after_sorting_and_deduplication(catalog):
    catalog.response["payload"] = {"data": [{"id": f"m-{i:04}"} for i in range(510, -1, -1)] * 2}
    result = catalog.client.post("/api/agent/llm/models", json={}).json
    assert result["ok"] is True
    assert [model["id"] for model in result["models"]] == [f"m-{i:04}" for i in range(500)]


@pytest.mark.parametrize("body", [b"x" * (2 * 1024 * 1024 + 1), b"not-json", b'[]', b'{"data":{}}'])
def test_oversized_or_malformed_provider_response_is_safe_failure(catalog, body):
    catalog.response["body"] = body
    response = catalog.client.post("/api/agent/llm/models", json={})
    assert response.status_code == 200
    assert response.json["ok"] is False and response.json["error"]


def test_saved_key_never_follows_a_draft_address(catalog):
    """A new custom service (no provider id) must not send the active provider's key elsewhere."""
    catalog.response["payload"] = {"data": []}
    response = catalog.client.post("/api/agent/llm/models", json={
        "provider_type": "openai_compatible", "base_url": "https://other.example/v1",
    })
    assert response.status_code == 200
    req, _ = catalog.calls[0]
    assert req.full_url == "https://other.example/v1/models"
    assert req.get_header("Authorization") is None
    # Same address as saved: the saved key is still used.
    catalog.client.post("/api/agent/llm/models", json={"base_url": "https://saved.example/v1/"})
    assert catalog.calls[1][0].get_header("Authorization") == "Bearer test-saved-key"
    # A typed key goes with the typed address.
    catalog.client.post("/api/agent/llm/models", json={"base_url": "https://other.example/v1", "api_key": "test-draft-key"})
    assert catalog.calls[2][0].get_header("Authorization") == "Bearer test-draft-key"


def test_discovery_does_not_require_a_model(catalog, monkeypatch):
    """Models are listed before one is chosen (a new service or bare preset has no model yet)."""
    import backend.api.llm_api as llm_api
    monkeypatch.setattr(llm_api, "load_provider_config", lambda pid: {"provider": pid, "provider_type": "openai_compatible", "base_url": "https://saved.example/v1", "api_key": "", "model": ""})
    catalog.response["payload"] = {"data": [{"id": "m1"}]}
    response = catalog.client.post("/api/agent/llm/models", json={"provider_type": "openai_compatible", "base_url": "https://other.example/v1", "api_key": "test-draft-key"})
    assert response.status_code == 200 and response.json["ok"] is True, response.json
