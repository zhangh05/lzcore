"""Runtime health must not run discarded external LLM probes."""

from flask import Flask

from backend.api.runtime_routes import register_runtime_routes


def test_runtime_health_reads_live_config_without_provider_network_probes(monkeypatch):
    import agent.llm.config as config

    def forbidden_probe(*args, **kwargs):
        raise AssertionError("runtime health dispatched an external Provider probe")

    monkeypatch.setattr(config, "_provider_health", forbidden_probe)
    provider = {"enabled": True, "provider": "configured-provider", "safe_mode": True}
    monkeypatch.setattr(config, "resolve_provider_config", lambda *args: dict(provider))
    app = Flask(__name__)
    register_runtime_routes(app)
    client = app.test_client()
    for enabled in (True, False):
        provider["enabled"] = enabled
        response = client.get("/api/runtime/health?workspace_id=health-ws")
        assert response.status_code == 200
        body = response.json
        assert set(body) == {"components", "summary"}
        components = {item["name"]: item for item in body["components"]}
        assert components["agent"]["status"] == "ok"
        assert components["agent"]["details"] == {"runtime_mode": "SSOTRuntimeEngine"}
        assert components["llm"]["status"] == "ok"
        assert components["llm"]["details"] == {"enabled": enabled, "provider": "configured-provider", "safe_mode": True}
        assert body["summary"]["total"] == len(body["components"])


def test_explicit_llm_status_still_probes_provider(monkeypatch):
    import agent.llm.config as config

    calls = []
    provider = {"enabled": True, "provider_type": "mock", "provider": "mock", "key_loaded": True}
    monkeypatch.setattr(config, "resolve_provider_config", lambda *args: dict(provider))
    monkeypatch.setattr(config, "_provider_health", lambda cfg: calls.append(cfg) or {"chat_completion_ok": True})
    assert config.get_llm_status()["connected"] is True
    assert calls == [provider]
