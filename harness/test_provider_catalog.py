"""Provider identity, protocol, secrets and lifecycle share one catalog."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest


@pytest.fixture
def catalog(monkeypatch, tmp_path):
    import agent.llm.provider_store as store
    monkeypatch.setattr(store, "PROVIDERS_DIR", tmp_path / "providers")
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setenv("LZCORE_OS_SECRET_STORE", "memory")
    monkeypatch.setenv("LZCORE_IDENTITY_ENABLED", "false")
    monkeypatch.setenv("LZCORE_AUTH_ENABLED", "false")
    monkeypatch.setenv("LZCORE_LOGIN_ENABLED", "false")
    monkeypatch.setenv("LZCORE_LLM_ENABLED", "true")
    monkeypatch.setenv("RATE_LIMIT_DISABLED", "true")
    from backend.main import create_app
    return create_app().test_client(), store


def config(protocol="openai_compatible", **extra):
    return {"label": "公司网关", "provider_type": protocol, "base_url": "https://gateway.example/v1",
            "model": "gateway-model", "api_key": "sk-test-catalog-123456", **extra}


def add(client, **extra):
    response = client.post("/api/agent/llm/providers", json=config(**extra))
    assert response.status_code == 201, response.get_json()
    return response.get_json()["config"]


def test_named_vendors_survive_reload_and_keep_identity_on_rename(catalog):
    client, store = catalog
    first = add(client)
    second = add(client, protocol="anthropic_messages")
    assert first["provider"] != second["provider"]
    assert first["label"] == second["label"]
    assert first["api_key"] is None and first["key_configured"] is True
    assert "secret_ref" not in first
    listed = client.get("/api/agent/llm/providers").get_json()
    assert {first["provider"], second["provider"]} <= {p["provider"] for p in listed["providers"]}
    assert all(not p["key_configured"] for p in listed["templates"])
    assert "sk-test-catalog" not in (store.PROVIDERS_DIR / f'{first["provider"]}.json').read_text()
    renamed = client.post(f'/api/agent/llm/providers/{first["provider"]}', json={"label": "  新网关  "}).get_json()["config"]
    assert renamed["label"] == "新网关" and renamed["provider"] == first["provider"]
    assert store.load_provider_config(second["provider"])["provider_type"] == "anthropic_messages"


def test_activation_disable_and_delete_have_explicit_lifecycle(catalog, monkeypatch):
    client, store = catalog
    saved = add(client, protocol="anthropic_messages")
    pid = saved["provider"]
    assert client.post("/api/agent/llm/activate", json={"provider": pid}).status_code == 200
    from agent.llm.settings import resolve_effective_llm_config
    assert resolve_effective_llm_config()["provider_type"] == "anthropic_messages"
    assert client.delete(f"/api/agent/llm/providers/{pid}").status_code == 409
    client.post(f"/api/agent/llm/providers/{pid}", json={"enabled": False})
    assert resolve_effective_llm_config()["enabled"] is False  # no silent env/provider fallback
    monkeypatch.setenv("MINIMAX_API_KEY", "sk-unrelated-vendor")
    client.post(f"/api/agent/llm/providers/{pid}", json={"clear_api_key": True})
    runtime = resolve_effective_llm_config()
    assert runtime["api_key"] == "" and not runtime["key_loaded"]
    client.post("/api/agent/llm/activate", json={"provider": "deepseek"})
    assert client.delete(f"/api/agent/llm/providers/{pid}").status_code == 200
    assert not store.provider_exists(pid)
    assert client.get(f"/api/agent/llm/providers/{pid}").status_code == 404
    assert client.post("/api/agent/llm/test", json={"provider": pid}).status_code == 404


@pytest.mark.parametrize("invalid", [
    {"provider_type": "responses"}, {"provider_type": ["anthropic_messages"]},
    {"label": " "}, {"label": None}, {"label": "x" * 81},
    {"base_url": "https://key@gateway.example/v1"}, {"base_url": "file:///tmp/a"},
    {"base_url": "https://gateway.example:bad"}, {"base_url": "https://gateway.example/v1?api_key=secret"},
    {"model": 42}, {"api_key": {"value": "secret"}},
])
def test_invalid_create_never_adds_catalog_entry(catalog, invalid):
    client, store = catalog
    before = {p["provider"] for p in store.list_providers()}
    response = client.post("/api/agent/llm/providers", json=config(**invalid))
    assert response.status_code == 400
    assert before == {p["provider"] for p in store.list_providers()}


@pytest.mark.parametrize("pid", ["../outside", "a/b", "a\\b", "CON", "con", "nul", "_active", "a" * 65])
def test_storage_rejects_untrusted_identifiers(tmp_path, pid):
    from storage.provider_config_store import provider_config_path
    with pytest.raises(ValueError):
        provider_config_path(tmp_path, pid)


@pytest.fixture
def protocol_server():
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append({"path": self.path, "body": body, "authorization": self.headers.get("Authorization"),
                             "x-api-key": self.headers.get("x-api-key")})
            if self.path == "/v1/messages":
                events = [
                    {"type": "message_start", "message": {"id": "msg-test", "model": "gateway-model", "usage": {"input_tokens": 1}}},
                    {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "OK"}},
                    {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 1}},
                    {"type": "message_stop"},
                ]
                payload = "".join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events)
            else:
                payload = 'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\ndata: [DONE]\n\n'
            data = payload.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1", requests
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


@pytest.mark.parametrize("protocol,path,key_header", [
    ("openai_compatible", "/v1/chat/completions", "authorization"),
    ("anthropic_messages", "/v1/messages", "x-api-key"),
])
def test_probe_and_runtime_use_explicit_protocol_on_same_neutral_endpoint(catalog, protocol_server, protocol, path, key_header):
    client, _ = catalog
    origin, requests = protocol_server
    saved = add(client, protocol=protocol, base_url=origin)
    # A draft protocol is honored before saving, even when the active vendor differs.
    response = client.post("/api/agent/llm/test", json={"provider": saved["provider"], "provider_type": protocol})
    assert response.status_code == 200 and response.get_json()["llm_used"] is True, response.get_json()
    assert requests[-1]["path"] == path and "sk-test-catalog" in requests[-1][key_header]
    client.post("/api/agent/llm/activate", json={"provider": saved["provider"]})
    from agent.llm.client import LLMClient
    assert LLMClient().probe()["ok"]
    assert requests[-1]["path"] == path
    assert requests[-1]["body"]["model"] == "gateway-model"


def test_draft_protocol_override_is_tested_without_mutating_saved_vendor(catalog, protocol_server):
    client, store = catalog
    origin, requests = protocol_server
    saved = add(client, base_url=origin)
    response = client.post("/api/agent/llm/test", json={
        "provider": saved["provider"], "provider_type": "anthropic_messages"})
    assert response.get_json()["llm_used"] is True
    assert requests[-1]["path"] == "/v1/messages"
    assert store.load_provider_config(saved["provider"])["provider_type"] == "openai_compatible"
    assert store.get_active_provider() != saved["provider"]
    request_count = len(requests)
    cleared = client.post("/api/agent/llm/test", json={"provider": saved["provider"], "clear_api_key": True})
    assert not cleared.get_json()["llm_used"]
    assert len(requests) == request_count


def test_added_vendor_can_be_selected_by_existing_task_routing(catalog, monkeypatch):
    client, _ = catalog
    saved = add(client, protocol="anthropic_messages")
    monkeypatch.setenv("LZCORE_MODEL_ROUTE_ASSISTANT_CHAT", saved["provider"])
    from agent.llm.router import resolve_model_candidates
    candidates = resolve_model_candidates("assistant_chat", {"provider": "openai"})
    assert candidates[0]["provider"] == saved["provider"]
    assert candidates[0]["provider_type"] == "anthropic_messages"
    assert candidates[0]["routing"]["selected_by"] == "task_policy"


def test_config_directory_contract_is_honored_by_a_fresh_process(tmp_path):
    import os
    import subprocess
    import sys
    env = {**os.environ, "LZCORE_CONFIG_DIR": str(tmp_path)}
    result = subprocess.check_output([sys.executable, "-c", "from agent.llm.provider_store import PROVIDERS_DIR; print(PROVIDERS_DIR)"], env=env, text=True).strip()
    assert result == str(tmp_path.resolve() / "providers")


def test_external_create_cannot_import_another_vendors_secret_reference(catalog):
    client, store = catalog
    store.save_provider_config("minimax", {"api_key": "sk-unrelated-internal-secret"})
    created = add(client, api_key="", secret_ref="secret://llm/minimax")
    assert not created["key_configured"]
    assert store.load_provider_config(created["provider"])["api_key"] == ""


def test_clear_key_requires_an_explicit_boolean(catalog):
    client, store = catalog
    created = add(client)
    pid = created["provider"]
    result = client.post(f"/api/agent/llm/providers/{pid}", json={"clear_api_key": "false"})
    assert result.status_code == 400
    assert store.load_provider_config(pid)["api_key"] == "sk-test-catalog-123456"


def test_operator_disable_cannot_be_bypassed_by_draft_protocol_probe(catalog, protocol_server, monkeypatch):
    client, _ = catalog
    origin, requests = protocol_server
    saved = add(client, base_url=origin)
    monkeypatch.setenv("LZCORE_LLM_ENABLED", "false")
    response = client.post("/api/agent/llm/test", json={
        "provider": saved["provider"], "provider_type": "anthropic_messages"})
    assert not response.get_json()["llm_used"]
    assert requests == []
