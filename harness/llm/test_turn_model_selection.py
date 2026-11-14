"""Per-turn model choice: validation, scope, and thread inheritance."""

import json
import threading

import pytest


def _providers(monkeypatch, tmp_path):
    import agent.llm.provider_store as store

    providers = tmp_path / "config" / "providers"
    providers.mkdir(parents=True)
    monkeypatch.setattr(store, "PROVIDERS_DIR", providers)
    monkeypatch.setattr(store, "ACTIVE_FILE", providers / "_active")
    monkeypatch.setenv("LZCORE_LLM_ENABLED", "true")
    for name in ("DEEPSEEK_API_KEY", "OPENAI_API_KEY", "MINIMAX_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    (providers / "minimax.json").write_text(json.dumps({
        "enabled": True, "provider": "minimax", "base_url": "https://api.minimaxi.com/anthropic/v1",
        "model": "MiniMax-M3", "api_key": "sk-test12345678",
    }))
    (providers / "deepseek.json").write_text(json.dumps({
        "enabled": True, "provider": "deepseek", "base_url": "https://api.deepseek.com/v1",
        "model": "deepseek-chat", "api_key": "sk-deep12345678",
    }))
    (providers / "_active").write_text("minimax")
    return providers


def test_normalize_rejects_bad_shapes_and_drops_noop():
    from agent.llm.turn_model import ModelSelectionError, normalize_model_selection

    assert normalize_model_selection(None) is None
    assert normalize_model_selection({}) is None
    assert normalize_model_selection({"provider": "", "thinking": "provider_default"}) is None
    assert normalize_model_selection({"provider": "deepseek"}) == {"provider": "deepseek", "thinking": "provider_default"}
    with pytest.raises(ModelSelectionError):
        normalize_model_selection("deepseek")
    with pytest.raises(ModelSelectionError):
        normalize_model_selection({"provider": "deepseek", "thinking": "max"})


def test_turn_model_scopes_resolution_and_reaches_bound_threads(monkeypatch, tmp_path):
    _providers(monkeypatch, tmp_path)
    from agent.llm.config import resolve_provider_config
    from agent.llm.turn_model import resolve_model_selection, turn_model
    from storage.principal import bind_storage_principal

    assert resolve_provider_config()["model"] == "MiniMax-M3"
    cfg = resolve_model_selection({"provider": "deepseek", "thinking": "provider_default"})
    seen = {}
    with turn_model(cfg):
        assert resolve_provider_config()["model"] == "deepseek-chat"

        def worker():
            seen["model"] = resolve_provider_config()["model"]

        thread = threading.Thread(target=bind_storage_principal(worker))
        thread.start()
        thread.join()
    assert seen["model"] == "deepseek-chat"
    # Nothing leaks past the turn and the active provider never changed.
    assert resolve_provider_config()["model"] == "MiniMax-M3"


def test_thinking_only_where_the_model_supports_it(monkeypatch, tmp_path):
    _providers(monkeypatch, tmp_path)
    from agent.llm.turn_model import ModelSelectionError, resolve_model_selection

    assert resolve_model_selection({"provider": "minimax", "thinking": "disabled"})["thinking"] == "disabled"
    with pytest.raises(ModelSelectionError):
        resolve_model_selection({"provider": "deepseek", "thinking": "adaptive"})


def test_unconfigured_provider_cannot_run_a_turn(monkeypatch, tmp_path):
    _providers(monkeypatch, tmp_path)
    from agent.llm.turn_model import ModelSelectionError, resolve_model_selection

    with pytest.raises(ModelSelectionError):
        resolve_model_selection({"provider": "openai", "thinking": "provider_default"})
    with pytest.raises(ModelSelectionError):
        resolve_model_selection({"provider": "no-such-provider", "thinking": "provider_default"})


def test_transport_metadata_keeps_only_provider_and_thinking():
    from backend.core.agent_contract import normalize_metadata

    out = normalize_metadata(
        {"model_selection": {"provider": "deepseek", "thinking": "adaptive", "base_url": "http://evil", "api_key": "x"}},
        transport="http", stream_mode="sse",
    )
    assert out["model_selection"] == {"provider": "deepseek", "thinking": "adaptive"}
    assert "model_selection" not in normalize_metadata({"model_selection": "deepseek"}, transport="http", stream_mode="sse")
