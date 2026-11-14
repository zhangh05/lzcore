# harness/llm/test_llm_settings_runtime_wiring.py
"""LLM provider-store runtime wiring tests."""

import json

import pytest


def _isolate_provider_store(monkeypatch, tmp_path):
    import agent.llm.provider_store as store

    providers = tmp_path / "config" / "providers"
    monkeypatch.setattr(store, "PROVIDERS_DIR", providers)
    monkeypatch.setattr(store, "ACTIVE_FILE", providers / "_active")
    return providers


def test_llm_probe_keeps_personal_drafts_and_does_not_elevate_on_identity_errors(monkeypatch):
    from backend.api.llm_api import probe_allows_draft_overrides
    import backend.core.identity as identity

    monkeypatch.delenv("LZCORE_IDENTITY_ENABLED", raising=False)
    assert probe_allows_draft_overrides() is True

    monkeypatch.setenv("LZCORE_IDENTITY_ENABLED", "true")
    monkeypatch.setattr(identity, "get_user", lambda _name: (_ for _ in ()).throw(OSError("store down")))
    assert probe_allows_draft_overrides() is False


class TestLLMProviderSettings:
    def test_resolve_uses_active_provider(self, monkeypatch, tmp_path):
        monkeypatch.setenv("LZCORE_LLM_ENABLED", "true")
        providers = _isolate_provider_store(monkeypatch, tmp_path)
        providers.mkdir(parents=True)
        (providers / "minimax.json").write_text(json.dumps({
            "enabled": True,
            "provider": "minimax",
            "base_url": "https://api.minimaxi.com/anthropic/v1",
            "model": "MiniMax-M3",
            "api_key": "sk-test12345678",
        }))
        (providers / "_active").write_text("minimax")

        from agent.llm.config import resolve_provider_config
        cfg = resolve_provider_config()

        assert cfg["enabled"] is True
        assert cfg["provider"] == "minimax"
        assert cfg["config_source"] == "ui_settings"
        assert cfg["model"] == "MiniMax-M3"
        assert cfg["provider_type"] == "anthropic_messages"

    def test_env_fallback_when_no_active_provider(self, monkeypatch, tmp_path):
        providers = _isolate_provider_store(monkeypatch, tmp_path)
        providers.parent.mkdir(parents=True)
        (providers.parent / "llm.yaml").write_text(
            "llm:\n  enabled: true\n  default_provider: minimax\n  providers:\n"
            "    minimax:\n      type: anthropic_messages\n      model: MiniMax-M3\n"
            "      base_url: https://api.minimaxi.com/anthropic/v1\n      api_key_env: MINIMAX_API_KEY\n",
            encoding="utf-8",
        )
        import agent.llm.config as config
        monkeypatch.setattr(config, "CONFIG_DIR", providers.parent)
        monkeypatch.setenv("MINIMAX_API_KEY", "sk-env-key123456")
        monkeypatch.setenv("LZCORE_LLM_ENABLED", "true")

        from agent.llm.config import resolve_provider_config
        cfg = resolve_provider_config()

        assert cfg["config_source"] in ("env", "file", "default")
        assert cfg["key_loaded"] is True

    def test_save_settings_writes_provider_config(self, monkeypatch, tmp_path):
        providers = _isolate_provider_store(monkeypatch, tmp_path)
        from agent.llm.settings import load_llm_settings, save_llm_settings

        saved = save_llm_settings({
            "enabled": True,
            "provider": "minimax",
            "api_key": "sk-test12345678",
            "model": "",
        })

        assert saved["model"] == "MiniMax-M3"
        assert (providers / "minimax.json").is_file()
        assert (providers / "_active").read_text() == "minimax"
        assert load_llm_settings()["model"] == "MiniMax-M3"

    def test_effective_config_has_key_source(self, monkeypatch, tmp_path):
        monkeypatch.setenv("LZCORE_LLM_ENABLED", "true")
        _isolate_provider_store(monkeypatch, tmp_path)
        from agent.llm.settings import resolve_effective_llm_config, save_llm_settings

        save_llm_settings({
            "enabled": True,
            "provider": "minimax",
            "model": "MiniMax-M3",
            "api_key": "sk-test12345678",
        })

        cfg = resolve_effective_llm_config()
        assert cfg["key_source"] == "ui_settings"

    def test_explicit_env_disable_overrides_active_provider(self, monkeypatch, tmp_path):
        providers = _isolate_provider_store(monkeypatch, tmp_path)
        providers.mkdir(parents=True)
        (providers / "minimax.json").write_text(json.dumps({
            "enabled": True,
            "provider": "minimax",
            "model": "MiniMax-M3",
            "api_key": "sk-test12345678",
        }))
        (providers / "_active").write_text("minimax")
        monkeypatch.setenv("LZCORE_LLM_ENABLED", "false")

        from agent.llm.config import resolve_provider_config
        from agent.llm.settings import resolve_effective_llm_config

        assert resolve_provider_config()["provider_type"] == "disabled"
        assert resolve_effective_llm_config()["enabled"] is False

    def test_legacy_minimax_base_is_migrated_without_changing_key(self, monkeypatch, tmp_path):
        providers = _isolate_provider_store(monkeypatch, tmp_path)
        providers.mkdir(parents=True)
        (providers / "minimax.json").write_text(json.dumps({
            "enabled": True,
            "provider": "minimax",
            "base_url": "https://api.minimaxi.com/v1",
            "model": "MiniMax-M3",
            "api_key": "sk-existing-key",
        }))

        from agent.llm.provider_store import load_provider_config
        cfg = load_provider_config("minimax")

        assert cfg["base_url"] == "https://api.minimaxi.com/anthropic/v1"
        assert cfg["api_key"] == "sk-existing-key"

    def test_master_key_file_encrypts_provider_keys(self, monkeypatch, tmp_path):
        providers = _isolate_provider_store(monkeypatch, tmp_path)
        monkeypatch.delenv("LZCORE_MASTER_KEY", raising=False)
        monkeypatch.delenv("LZCORE_IDENTITY_ENABLED", raising=False)
        key_file = tmp_path / "master.key"
        key_file.write_text("file-master-key-16", encoding="utf-8")
        monkeypatch.setenv("LZCORE_MASTER_KEY_FILE", str(key_file))
        monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
        providers.mkdir(parents=True)

        from agent.llm.provider_store import save_provider_config
        save_provider_config("minimax", {"api_key": "sk-from-file-key"})
        persisted = json.loads((providers / "minimax.json").read_text())

        assert persisted.get("api_key") in {"", None}
        assert str(persisted.get("secret_ref") or "").startswith("secret://")

    def test_plaintext_replacement_is_not_hidden_by_an_unavailable_secret_ref(self, monkeypatch, tmp_path):
        providers = _isolate_provider_store(monkeypatch, tmp_path)
        monkeypatch.delenv("LZCORE_MASTER_KEY", raising=False)
        monkeypatch.delenv("LZCORE_MASTER_KEY_FILE", raising=False)
        monkeypatch.delenv("LZCORE_IDENTITY_ENABLED", raising=False)
        monkeypatch.setenv("LZCORE_OS_SECRET_STORE", "off")
        providers.mkdir(parents=True)
        (providers / "minimax.json").write_text(json.dumps({
            "provider": "minimax",
            "secret_ref": "secret://llm/minimax",
            "api_key": "",
        }))

        from agent.llm.provider_store import load_provider_config, save_provider_config
        saved = save_provider_config("minimax", {"api_key": "sk-replacement-key"})
        persisted = json.loads((providers / "minimax.json").read_text())

        assert saved["api_key"] == "sk-replacement-key"
        assert "secret_ref" not in persisted
        assert load_provider_config("minimax")["api_key"] == "sk-replacement-key"


def test_keychain_roundtrip_with_subprocess_stub(monkeypatch):
    from types import SimpleNamespace
    import storage.os_secret_store as secrets
    values = {}

    def run(argv, **kwargs):
        if argv == ["security", "-i"]:
            parts = kwargs["input"].split()
            values[parts[parts.index("-a") + 1]] = bytes.fromhex(parts[-1]).decode()
            return SimpleNamespace(returncode=0, stdout="")
        account = argv[argv.index("-a") + 1]
        if argv[1] == "find-generic-password":
            return SimpleNamespace(returncode=0 if account in values else 44, stdout=values.get(account, ""))
        values.pop(account, None)
        return SimpleNamespace(returncode=0, stdout="")

    monkeypatch.setattr(secrets.subprocess, "run", run)
    from storage.os_secret_store import _keychain_delete, _keychain_get, _keychain_set
    secret_id = "lzcore-test/keychain-roundtrip"
    assert _keychain_set(secret_id, "sk-keychain-roundtrip")
    try:
        assert _keychain_get(secret_id) == "sk-keychain-roundtrip"
    finally:
        _keychain_delete(secret_id)
    assert values == {}


@pytest.mark.parametrize("enabled", [True, False])
def test_explicit_custom_vision_survives_save_load_runtime_and_routing(monkeypatch, tmp_path, enabled):
    from agent.llm import provider_store as store
    from agent.llm.capabilities import supports_vision
    from agent.llm.settings import resolve_effective_llm_config, resolve_provider_llm_config
    from agent.llm.runtime import invoke_llm
    from agent.llm.schemas import LLMMessage, LLMResponse

    _isolate_provider_store(monkeypatch, tmp_path)
    monkeypatch.setenv("LZCORE_LLM_ENABLED", "true")
    cfg = store.create_provider_config({
        "label": "Synthetic vision", "provider_type": "openai_compatible",
        "base_url": "https://invalid.example/v1", "model": "opaque-vl-001",
        "vision_enabled": enabled,
    })
    pid = cfg["provider"]
    store.set_active_provider(pid)
    store.save_provider_config(pid, {"vision_enabled": not enabled})
    store.save_provider_config(pid, {"vision_enabled": enabled})
    assert store.load_provider_config(pid)["vision_enabled"] is enabled
    assert resolve_effective_llm_config()["vision_enabled"] is enabled
    assert resolve_provider_llm_config(pid)["vision_enabled"] is enabled
    assert supports_vision(resolve_effective_llm_config()) is enabled
    assert not supports_vision({"model": "opaque-vl-001"})
    calls = []
    monkeypatch.setattr("agent.llm.provider.generate", lambda req, cfg: calls.append(cfg) or LLMResponse(content="image accepted"))
    result = invoke_llm("assistant_chat", messages=[LLMMessage(role="user", content=[
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
    ])])
    assert bool(calls) is enabled
    assert bool(result.error) is (not enabled)


@pytest.mark.parametrize("value", ["true", 1, None, []])
def test_non_boolean_vision_setting_is_rejected(monkeypatch, tmp_path, value):
    from agent.llm import provider_store as store
    _isolate_provider_store(monkeypatch, tmp_path)
    with pytest.raises(ValueError, match="vision_enabled must be boolean"):
        store.create_provider_config({
            "label": "Synthetic", "provider_type": "openai_compatible",
            "base_url": "https://invalid.example/v1", "model": "opaque-vl-001",
            "vision_enabled": value,
        })


@pytest.mark.parametrize("first_is_vision", [True, False])
def test_ssot_images_follow_compatible_candidates_through_fallback(monkeypatch, first_is_vision):
    from agent.llm.schemas import LLMResponse
    from agent.runtime.ssot_provider import _invoke_llm_for_ssot_runtime
    candidates = [
        {"provider": "first", "model": "opaque-1", "enabled": True, "vision_enabled": first_is_vision},
        {"provider": "fallback", "model": "opaque-2", "enabled": True, "vision_enabled": True},
        {"provider": "text-only", "model": "opaque-3", "enabled": True, "vision_enabled": False},
    ]
    monkeypatch.setattr("agent.llm.runtime.resolve_invocation_candidates", lambda *a: candidates)
    image = {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}}
    monkeypatch.setattr("agent.runtime.vision_inputs.build_vision_content", lambda *a: ([image], []))
    monkeypatch.setattr("agent.runtime.token_tracker.record_llm_call", lambda *a, **kw: None)
    attempted = []
    def generate(req, cfg):
        attempted.append(cfg["provider"])
        assert req.messages[-1].content[-1] == image
        assert req.model == cfg["model"] and cfg["vision_enabled"]
        return (LLMResponse(error="synthetic permanent failure", metadata={"retryable": False})
                if cfg["provider"] == "first" else LLMResponse(content="accepted"))
    monkeypatch.setattr("agent.llm.provider.generate", generate)
    result = _invoke_llm_for_ssot_runtime(system="test", user="inspect", workspace_id="vision-ws", extra={
        "stream_scope": "planner", "evidence_parts": [
            {"kind": "image", "evidence_id": "ev1", "reference": {"kind": "managed_file", "file_id": "file_fake"}},
        ],
    })
    assert result.content == "accepted"
    assert attempted == (["first", "fallback"] if first_is_vision else ["fallback"])
    assert result.metadata["delivered_evidence_ids"] == ["ev1"]


def test_provider_key_is_stored_in_the_system_secret_backend(monkeypatch, tmp_path):
    providers = _isolate_provider_store(monkeypatch, tmp_path)
    monkeypatch.setenv("LZCORE_OS_SECRET_STORE", "memory")
    monkeypatch.delenv("LZCORE_MASTER_KEY", raising=False)
    monkeypatch.delenv("LZCORE_MASTER_KEY_FILE", raising=False)
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    providers.mkdir(parents=True)
    from agent.llm.provider_store import load_provider_config, save_provider_config
    save_provider_config("minimax", {"api_key": "sk-system-store-key"})
    persisted = json.loads((providers / "minimax.json").read_text())
    assert persisted.get("api_key") in {"", None}
    assert persisted["secret_ref"] == "secret://llm/minimax"
    assert "sk-system-store-key" not in (providers / "minimax.json").read_text()
    assert load_provider_config("minimax")["api_key"] == "sk-system-store-key"


class TestKeyResolverMask:
    def test_key_resolver_mask(self):
        from agent.llm.key_resolver import mask_secret
        result = mask_secret("sk-test-key-12345678")
        assert "****" in result
        assert result.startswith("sk-t")

    def test_key_resolver_empty(self):
        from agent.llm.key_resolver import mask_secret
        assert mask_secret("") == ""
        assert mask_secret(None) == ""


@pytest.mark.parametrize("model", ["MiniMax-M1", "MiniMax-M3", "custom-model"])
def test_explicit_yaml_model_is_not_silently_replaced(monkeypatch, model):
    from agent.llm.config import resolve_provider_config
    monkeypatch.delenv("LZCORE_LLM_ENABLED", raising=False)
    monkeypatch.setattr("agent.llm.settings.resolve_effective_llm_config", lambda: {"config_source": "file"})
    monkeypatch.setattr("agent.llm.config.resolve_api_key", lambda **kw: "")
    config = {"enabled": True, "default_provider": "minimax", "providers": {"minimax": {
        "type": "anthropic_messages", "base_url": "https://example.invalid/v1", "model": model}}}
    assert resolve_provider_config(config)["model"] == model


class TestOSSecretSanitizationAndFallback:
    def test_account_name_sanitizes_windows_illegal_characters(self):
        from storage.os_secret_store import _account
        illegal_chars = set('<>:"/\\|?*')
        for test_id in ("llm/minimax", "extension/ext1/ws1/foo", "test|pipe", "test:colon*star?question"):
            acc = _account(test_id)
            assert not any(c in illegal_chars for c in acc), f"Illegal char found in {acc}"
        assert _account("llm/minimax") == "llm_minimax"
        assert _account("CON").startswith("sec_")

    def test_provider_save_falls_back_to_local_file_when_secret_store_fails_in_personal_mode(self, monkeypatch, tmp_path):
        providers = _isolate_provider_store(monkeypatch, tmp_path)
        monkeypatch.delenv("LZCORE_IDENTITY_ENABLED", raising=False)
        monkeypatch.delenv("LZCORE_MASTER_KEY", raising=False)
        monkeypatch.delenv("LZCORE_MASTER_KEY_FILE", raising=False)
        monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
        providers.mkdir(parents=True)

        import storage.os_secret_store as os_store
        monkeypatch.setattr(os_store, "available", lambda: True)
        monkeypatch.setattr(os_store, "set_os_secret", lambda _k, _v: (_ for _ in ()).throw(OSError("DPAPI write failed")))

        from agent.llm.provider_store import load_provider_config, save_provider_config
        saved = save_provider_config("minimax", {"api_key": "sk-fallback-key-12345"})
        persisted = json.loads((providers / "minimax.json").read_text())

        assert saved["api_key"] == "sk-fallback-key-12345"
        assert persisted.get("api_key") == "sk-fallback-key-12345"
        assert "secret_ref" not in persisted
        assert load_provider_config("minimax")["api_key"] == "sk-fallback-key-12345"

    def test_provider_save_raises_in_identity_mode_when_secret_store_fails(self, monkeypatch, tmp_path):
        _isolate_provider_store(monkeypatch, tmp_path)
        monkeypatch.setenv("LZCORE_IDENTITY_ENABLED", "true")
        monkeypatch.delenv("LZCORE_MASTER_KEY", raising=False)
        monkeypatch.delenv("LZCORE_MASTER_KEY_FILE", raising=False)

        import storage.os_secret_store as os_store
        monkeypatch.setattr(os_store, "available", lambda: True)
        monkeypatch.setattr(os_store, "set_os_secret", lambda _k, _v: (_ for _ in ()).throw(OSError("DPAPI failed")))

        import pytest
        from agent.llm.provider_store import save_provider_config
        with pytest.raises((OSError, RuntimeError)):
            save_provider_config("minimax", {"api_key": "sk-identity-key"})

    def test_provider_save_api_endpoint_handles_fallback_cleanly(self, monkeypatch, tmp_path):
        _isolate_provider_store(monkeypatch, tmp_path)
        monkeypatch.delenv("LZCORE_IDENTITY_ENABLED", raising=False)
        monkeypatch.delenv("LZCORE_MASTER_KEY", raising=False)
        monkeypatch.delenv("LZCORE_MASTER_KEY_FILE", raising=False)
        monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))

        import storage.os_secret_store as os_store
        monkeypatch.setattr(os_store, "available", lambda: True)
        monkeypatch.setattr(os_store, "set_os_secret", lambda _k, _v: (_ for _ in ()).throw(OSError("Simulated DPAPI error")))

        from backend.main import create_app
        client = create_app().test_client()
        res = client.post("/api/agent/llm/providers/minimax", json={
            "api_key": "sk-endpoint-test-12345",
            "model": "MiniMax-M3",
            "enabled": True,
        })
        assert res.status_code == 200
        data = res.get_json()
        assert data["ok"] is True
        assert data["config"]["key_configured"] is True
        assert data["config"]["api_key"] is None
