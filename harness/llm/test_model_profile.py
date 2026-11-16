"""Model capabilities: models.dev catalog, user overrides, and where they take effect."""

import json

import pytest


def _store(monkeypatch, tmp_path):
    import agent.llm.provider_store as store

    providers = tmp_path / "config" / "providers"
    monkeypatch.setattr(store, "PROVIDERS_DIR", providers)
    monkeypatch.setattr(store, "ACTIVE_FILE", providers / "_active")
    monkeypatch.setenv("LZCORE_LLM_ENABLED", "true")
    return store


def test_catalog_answers_for_known_models_and_spellings():
    from agent.llm.model_profile import resolve_model_profile as profile

    sol = profile({"model": "gpt-6.1-sol", "base_url": "https://gateway.example/v1", "provider_type": "openai_compatible"})
    assert sol.catalog_ref == "openai/gpt-6.1-sol"
    assert sol.vision and sol.reasoning and sol.tools
    assert sol.temperature is False  # reasoning model: no temperature
    assert "high" in sol.thinking_options and sol.context_window > 1_000_000 - 1
    # gateway prefix and dated snapshot still resolve
    assert profile({"model": "openai/gpt-4o-2024-08-06"}).vision is True
    # endpoint match picks the vendor's own catalog entry
    ling = profile({"model": "Ling-3.0-flash", "base_url": "https://api.ant-ling.com/v1/"})
    assert ling.catalog_ref == "bailing/Ling-3.0-flash" and ling.vision is False
    assert profile({"model": "Ling-3.0-flash-VL", "base_url": "https://api.ant-ling.com/v1"}).vision is True


def test_unknown_models_stay_conservative():
    from agent.llm.model_profile import resolve_model_profile as profile

    p = profile({"model": "opaque-vl-001"})
    assert p.catalog_ref == "" and p.vision is False and p.thinking_options == ()
    assert p.sources["vision"] == "unknown"


def test_user_overrides_win_over_catalog_and_legacy_flag():
    from agent.llm.model_profile import resolve_model_profile as profile

    p = profile({"model": "my-private-model", "capabilities": {"vision": True, "context_window": 32_000}})
    assert p.vision is True and p.context_window == 32_000
    assert p.sources["vision"] == "user" and p.sources["context_window"] == "user"
    assert profile({"model": "gpt-4o", "capabilities": {"vision": False}}).vision is False
    assert profile({"model": "my-private-model", "vision_enabled": True}).vision is True
    # an explicit capabilities.vision beats the legacy flag
    assert profile({"model": "x", "vision_enabled": True, "capabilities": {"vision": False}}).vision is False
    # turning reasoning off removes thinking controls
    assert profile({"model": "gpt-6.1-sol", "provider_type": "openai_compatible", "capabilities": {"reasoning": False}}).thinking_options == ()


def test_minimax_thinking_controls_are_unchanged():
    from agent.llm.model_profile import resolve_model_profile as profile

    m3 = profile({"provider": "minimax", "model": "MiniMax-M3", "provider_type": "anthropic_messages"})
    assert m3.thinking_options == ("adaptive", "disabled") and not m3.thinking_required and m3.vision
    m31 = profile({"provider": "minimax", "model": "MiniMax-M3.1-Flash", "provider_type": "anthropic_messages"})
    assert m31.thinking_required


def test_overrides_are_validated():
    from agent.llm.model_profile import validate_overrides

    assert validate_overrides({"vision": True, "context_window": None}) == []
    assert validate_overrides({"vision": "yes"})
    assert validate_overrides({"context_window": 12})
    assert validate_overrides({"unknown": True})
    assert validate_overrides({"tools": False})  # reported, not overridable
    assert validate_overrides([1])


def test_capabilities_save_round_trip_and_follow_the_model(monkeypatch, tmp_path):
    store = _store(monkeypatch, tmp_path)
    cfg = store.create_provider_config({
        "label": "Gateway", "provider_type": "openai_compatible", "base_url": "https://gw.example/v1",
        "model": "private-model", "capabilities": {"vision": True, "temperature": None, "context_window": 64_000},
    })
    pid = cfg["provider"]
    saved = store.load_provider_config(pid)
    assert saved["capabilities"] == {"vision": True, "context_window": 64_000}
    assert store.list_providers()[-1]["profile"]["vision"] is True

    # clearing to automatic removes the key
    store.save_provider_config(pid, {"capabilities": {"vision": None}})
    assert "capabilities" not in store.load_provider_config(pid)

    store.save_provider_config(pid, {"capabilities": {"vision": True}})
    # switching model without new overrides goes back to automatic detection
    store.save_provider_config(pid, {"model": "gpt-6.1-sol", "thinking": "high"})
    after = store.load_provider_config(pid)
    assert "capabilities" not in after and after["thinking"] == "high"
    # a model that cannot take the saved thinking level falls back instead of failing
    store.save_provider_config(pid, {"model": "private-model"})
    assert store.load_provider_config(pid)["thinking"] == "provider_default"

    with pytest.raises(ValueError):
        store.save_provider_config(pid, {"capabilities": {"vision": "yes"}})


def test_request_bodies_follow_model_capabilities():
    from agent.llm.provider import _apply_model_capabilities, _to_anthropic_messages_request
    from agent.llm.schemas import LLMMessage, LLMRequest

    body = {"model": "gpt-6.1-sol", "temperature": 0.2}
    _apply_model_capabilities(body, {"model": "gpt-6.1-sol", "provider_type": "openai_compatible", "thinking": "high"}, protocol="openai_compatible")
    assert "temperature" not in body and body["reasoning_effort"] == "high"

    body = {"model": "gpt-4o", "temperature": 0.2}
    _apply_model_capabilities(body, {"model": "gpt-4o", "provider_type": "openai_compatible", "thinking": "high"}, protocol="openai_compatible")
    assert body == {"model": "gpt-4o", "temperature": 0.2}  # not a reasoning model: nothing added

    req = LLMRequest(task="t", messages=[LLMMessage(role="user", content="hi")], model="MiniMax-M3")
    cfg = {"provider": "minimax", "model": "MiniMax-M3", "provider_type": "anthropic_messages", "thinking": "disabled"}
    assert _to_anthropic_messages_request(req, cfg)["thinking"] == {"type": "disabled"}


def test_turn_selection_accepts_only_supported_thinking_levels(monkeypatch, tmp_path):
    store = _store(monkeypatch, tmp_path)
    from agent.llm.turn_model import ModelSelectionError, resolve_model_selection

    sol = store.create_provider_config({"label": "Sol", "provider_type": "openai_compatible", "base_url": "https://gw.example/v1",
                                        "model": "gpt-6.1-sol", "api_key": "sk-test-123456789"})
    plain = store.create_provider_config({"label": "Plain", "provider_type": "openai_compatible", "base_url": "https://gw.example/v1",
                                          "model": "deepseek-chat", "api_key": "sk-test-123456789"})
    assert resolve_model_selection({"provider": sol["provider"], "thinking": "xhigh"})["thinking"] == "xhigh"
    with pytest.raises(ModelSelectionError):
        resolve_model_selection({"provider": sol["provider"], "thinking": "adaptive"})
    with pytest.raises(ModelSelectionError):
        resolve_model_selection({"provider": plain["provider"], "thinking": "high"})


def test_context_budget_and_cost_use_the_catalog():
    from agent.runtime.token_tracker import _price_per_1k
    from core.runtime_engine.context_budget import resolve_model_context_tokens

    assert resolve_model_context_tokens("gpt-6.1-sol") > 1_000_000 - 1
    assert resolve_model_context_tokens("whatever", 50_000) == 50_000
    inp, out = _price_per_1k("gpt-6.1-sol")
    assert inp == pytest.approx(0.002) and out == pytest.approx(0.01)


def test_vision_probe_image_and_judgement():
    import base64
    from agent.llm.model_profile import vision_probe_image, vision_probe_passed

    url = vision_probe_image("blue")
    assert url.startswith("data:image/png;base64,")
    assert base64.b64decode(url.split(",", 1)[1])[:8] == b"\x89PNG\r\n\x1a\n"
    assert vision_probe_passed("blue", "Blue.")
    assert vision_probe_passed("red", "红色")
    assert not vision_probe_passed("blue", "Red")
    assert not vision_probe_passed("blue", "red, green, blue or yellow")


def test_vision_probe_endpoint(monkeypatch, tmp_path):
    store = _store(monkeypatch, tmp_path)
    from flask import Flask
    import backend.api.llm_api as api
    from agent.llm.schemas import LLMResponse

    cfg = store.create_provider_config({"label": "Gw", "provider_type": "openai_compatible", "base_url": "https://gw.example/v1",
                                        "model": "private-model", "api_key": "sk-test-123456789"})
    sent = []

    def fake_generate(req, cfg):
        parts = req.messages[-1].content
        sent.append(parts)
        color = "unknown"
        import agent.llm.model_profile as mp
        for name in mp.VISION_PROBE_COLORS:
            if parts[1]["image_url"]["url"] == mp.vision_probe_image(name):
                color = name
        return LLMResponse(content=color.capitalize())

    monkeypatch.setattr("agent.llm.provider.generate", fake_generate)
    monkeypatch.setattr(api, "probe_allows_draft_overrides", lambda: True)
    app = Flask(__name__)
    with app.test_request_context(json={"provider": cfg["provider"], "probe": "vision"}):
        body = api.handle_llm_test().get_json()
    assert body["vision"] is True and body["ok"] is True
    assert sent and sent[0][1]["type"] == "image_url"


def test_workbench_models_report_profile(monkeypatch, tmp_path):
    store = _store(monkeypatch, tmp_path)
    from flask import Flask
    from backend.api.llm_api import handle_workbench_models

    store.create_provider_config({"label": "Sol", "provider_type": "openai_compatible", "base_url": "https://gw.example/v1",
                                  "model": "gpt-6.1-sol", "api_key": "sk-test-123456789"})
    with Flask(__name__).app_context():
        body = handle_workbench_models().get_json()
    sol = next(m for m in body["models"] if m["model"] == "gpt-6.1-sol")
    assert sol["supports_vision"] is True and sol["supports_thinking"] is True
    assert sol["thinking_options"][0] == "low" and sol["context_window"] > 1_000_000 - 1


def test_bundled_catalog_is_present_and_attributed():
    from agent.llm.model_profile import CATALOG_FILE

    data = json.loads(CATALOG_FILE.read_text(encoding="utf-8"))
    assert "models.dev" in data["source"] and "MIT" in data["license"]
    assert len(data["providers"]) >= 20


def test_profile_endpoint_resolves_drafts_without_secrets():
    from flask import Flask
    from backend.api.llm_api import handle_llm_profile

    app = Flask(__name__)
    with app.test_request_context(json={"model": "gpt-6.1-sol", "base_url": "https://gw.example/v1", "provider_type": "openai_compatible"}):
        body = handle_llm_profile().get_json()
    assert body["profile"]["vision"] is True and body["profile"]["catalog_ref"] == "openai/gpt-6.1-sol"
    with app.test_request_context(json={"model": "x", "capabilities": {"vision": "maybe"}}):
        response, status = handle_llm_profile()
    assert status == 400
