# harness/test_llm_settings_runtime_wiring.py
"""LLM provider-store runtime wiring tests."""

import json


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
        _isolate_provider_store(monkeypatch, tmp_path)
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


def test_macos_keychain_roundtrip_when_available():
    import sys
    if sys.platform != "darwin":
        return
    from storage.os_secret_store import _keychain_delete, _keychain_get, _keychain_set
    secret_id = "lzcore-test/keychain-roundtrip"
    if not _keychain_set(secret_id, "sk-keychain-roundtrip"):
        return
    try:
        assert _keychain_get(secret_id) == "sk-keychain-roundtrip"
    finally:
        _keychain_delete(secret_id)


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


class TestMiniMaxM3NoResidue:
    def test_no_m1_in_settings_default(self):
        from agent.llm.settings import resolve_effective_llm_config
        cfg = resolve_effective_llm_config()
        model = cfg.get("model", "")
        if model and "M1" in model:
            assert model == "MiniMax-M3"

    def test_no_m1_in_config_default(self):
        from agent.llm.config import load_llm_config
        cfg = load_llm_config()
        for name, provider in cfg.get("providers", {}).items():
            model = provider.get("model", "")
            if model == "MiniMax-M1":
                raise AssertionError(f"Provider {name} has MiniMax-M1 as model")


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
