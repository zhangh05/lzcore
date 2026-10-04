# agent/llm/settings.py
"""LLM settings facade backed by config/providers/."""

import os
from typing import Optional

SOURCE_UI_SETTINGS = "ui_settings"
SOURCE_ENV = "env"
SOURCE_FILE = "file"
SOURCE_DEFAULT = "default"


def get_llm_setting_path() -> str:
    from agent.llm.provider_store import get_active_provider
    return f"config/providers/{get_active_provider()}.json"


def load_llm_settings() -> Optional[dict]:
    from agent.llm.provider_store import get_active_config
    cfg = dict(get_active_config() or {})
    if not cfg:
        return None
    cfg.setdefault("source", SOURCE_UI_SETTINGS)
    return cfg


def save_llm_settings(data: dict) -> dict:
    from agent.llm.provider_store import provider_exists, save_provider_config, set_active_provider

    data = dict(data or {})
    requested = data.get("provider") or "custom"
    provider_id = requested if provider_exists(requested) else "custom"

    if requested in ("openai_compatible", "ollama_compatible"):
        data["provider_type"] = requested
    if requested == "minimax" and not data.get("model"):
        data["model"] = "MiniMax-M3"
    if requested == "minimax" and not data.get("base_url"):
        data["base_url"] = "https://api.minimaxi.com/anthropic/v1"

    cfg = save_provider_config(provider_id, data)
    set_active_provider(provider_id)
    cfg["provider"] = provider_id
    cfg["source"] = SOURCE_UI_SETTINGS
    return cfg


def delete_llm_settings() -> bool:
    from agent.llm.provider_store import delete_provider_config, get_active_provider
    return delete_provider_config(get_active_provider())


def sanitize_llm_settings(data: dict) -> dict:
    if not data:
        return {"enabled": False, "provider": "disabled"}
    key = data.get("api_key", "")
    return {
        "enabled": data.get("enabled", False),
        "provider": data.get("provider", "disabled"),
        "provider_type": _provider_type(data.get("provider", "custom"), data),
        "safe_mode": data.get("safe_mode", True),
        "prompt_cache_enabled": data.get("prompt_cache_enabled", True),
        "base_url": data.get("base_url", ""),
        "model": data.get("model", ""),
        "temperature": data.get("temperature", 0.2),
        "top_p": data.get("top_p"),
        "thinking": data.get("thinking", "provider_default"),
        "max_tokens": data.get("max_tokens", 4096),
        "key_configured": bool(key),
        "key_preview": mask_key(key) if key else None,
        "updated_at": data.get("updated_at"),
        "source": data.get("source", SOURCE_UI_SETTINGS),
    }


def mask_key(key: str) -> Optional[str]:
    if not key or len(key) < 8:
        return None
    return key[:4] + "****" + key[-4:]


def resolve_effective_llm_config() -> dict:
    from agent.llm.config import load_llm_config
    from agent.llm.config import _disabled_provider_config, _llm_disabled_by_env
    from agent.llm.key_resolver import get_key_source, is_key_loaded, resolve_api_key
    from agent.llm.provider_store import get_active_config, get_active_provider, provider_has_saved_config

    if _llm_disabled_by_env():
        return _disabled_provider_config()

    active_id = get_active_provider()
    active_cfg = dict(get_active_config() or {})
    if active_cfg.get("model") and (active_cfg.get("enabled") or provider_has_saved_config(active_id)):
        api_key = active_cfg.get("api_key", "")
        if not api_key:
            api_key = resolve_api_key(env_name=_provider_env_name(active_id))
        return _provider_runtime_config(active_id, active_cfg, api_key)

    cfg = load_llm_config()
    env_key = resolve_api_key(env_name="MINIMAX_API_KEY")
    result = {
        "enabled": cfg.get("enabled", False) or bool(env_key),
        "provider": cfg.get("default_provider", "disabled"),
        "safe_mode": cfg.get("safe_mode", True),
        "prompt_cache_enabled": cfg.get("prompt_cache_enabled", True),
        "base_url": "",
        "model": "",
        "temperature": 0.2,
        "max_tokens": 4096,
        "api_key": env_key or "",
        "provider_type": "disabled",
        "config_source": SOURCE_ENV if env_key else SOURCE_FILE,
        "key_loaded": bool(env_key) or is_key_loaded(),
        "key_source": get_key_source() or "none",
        "default_provider": cfg.get("default_provider", "disabled"),
        "timeout": cfg.get("timeout_seconds", 90),
    }

    providers = cfg.get("providers", {})
    default_provider = cfg.get("default_provider", "disabled")
    provider_cfg = providers.get(default_provider, {})
    if provider_cfg:
        result["provider_type"] = provider_cfg.get("type", "disabled")
        result["base_url"] = provider_cfg.get("base_url", "")
        result["model"] = provider_cfg.get("model", "")
        result["temperature"] = provider_cfg.get("temperature", 0.2)
        result["max_tokens"] = provider_cfg.get("max_tokens", 4096)
        result["top_p"] = provider_cfg.get("top_p")
        result["thinking"] = provider_cfg.get("thinking", "provider_default")
        result["prompt_cache_enabled"] = provider_cfg.get("prompt_cache_enabled", True)
        if not env_key:
            file_key = resolve_api_key(
                env_name=provider_cfg.get("api_key_env", ""),
                file_path=provider_cfg.get("api_key_file", ""),
            )
            result["api_key"] = file_key or ""

    if os.environ.get("MINIMAX_API_KEY") or os.environ.get("OPENAI_API_KEY"):
        result["config_source"] = SOURCE_ENV
        result["key_loaded"] = True
    return result


def resolve_provider_llm_config(provider_id: str) -> dict:
    """Resolve one provider's runtime config without switching the active provider."""
    from agent.llm.config import _disabled_provider_config, _llm_disabled_by_env
    if _llm_disabled_by_env():
        return _disabled_provider_config()
    from agent.llm.key_resolver import resolve_api_key
    from agent.llm.provider_store import provider_exists, load_provider_config

    if not provider_exists(provider_id):
        raise ValueError("unknown provider")

    provider_cfg = dict(load_provider_config(provider_id) or {})
    api_key = provider_cfg.get("api_key", "")
    if not api_key:
        api_key = resolve_api_key(env_name=_provider_env_name(provider_id))
    return _provider_runtime_config(provider_id, provider_cfg, api_key or "")


def _provider_runtime_config(provider_id: str, cfg: dict, api_key: str) -> dict:
    from agent.llm.key_resolver import is_key_loaded

    return {
        "enabled": cfg.get("enabled", True),
        "provider": provider_id,
        "safe_mode": cfg.get("safe_mode", True),
        "prompt_cache_enabled": cfg.get("prompt_cache_enabled", True),
        "base_url": cfg.get("base_url", ""),
        "model": cfg.get("model", ""),
        "temperature": cfg.get("temperature", 0.2),
        "top_p": cfg.get("top_p"),
        "thinking": cfg.get("thinking", "provider_default"),
        "max_tokens": cfg.get("max_tokens", 4096),
        "api_key": api_key or "",
        "provider_type": _provider_type(provider_id, cfg),
        "config_source": SOURCE_UI_SETTINGS,
        "key_loaded": bool(api_key),
        "key_source": "ui_settings" if cfg.get("api_key") else "env" if api_key else "none",
        "default_provider": provider_id,
        "timeout": 90,
        "source": SOURCE_UI_SETTINGS,
        "enabled_by_ui": cfg.get("enabled", True),
        "key_fallback_used": not bool(cfg.get("api_key")) and bool(api_key),
    }


def _provider_type(provider_id: str, cfg: dict) -> str:
    from agent.llm.protocols import resolve_protocol
    return resolve_protocol(provider_id, cfg)


def _provider_env_name(provider_id: str) -> str:
    return {
        "openai": "OPENAI_API_KEY",
        "minimax": "MINIMAX_API_KEY",
        "deepseek": "DEEPSEEK_API_KEY",
        "ark": "ARK_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "custom": "MINIMAX_API_KEY",  # legacy fallback; added vendors never borrow another vendor's key
    }.get(provider_id, "")


def validate_llm_settings(data: dict, *, new_provider: bool = False) -> list:
    from agent.llm.provider_store import provider_exists
    from agent.llm.protocols import PROVIDER_PROTOCOLS
    from storage.provider_config_store import validate_provider_id
    from urllib.parse import urlsplit
    errors = []
    valid_providers = [
        "minimax", "disabled", "mock", "openai",
        "deepseek", "ollama", "custom",
        "openai_compatible", "ollama_compatible",
        "ark", "anthropic",
    ]
    provider_id = data.get("provider")
    try:
        validate_provider_id(provider_id)
        valid_id = new_provider or provider_exists(provider_id) or provider_id in valid_providers
    except ValueError:
        valid_id = False
    if not valid_id:
        errors.append(f"invalid provider: {data.get('provider')}")
    protocol = data.get("provider_type")
    if protocol is not None and (not isinstance(protocol, str) or (protocol not in PROVIDER_PROTOCOLS and protocol != "ollama_compatible")):
        errors.append("provider_type must be openai_compatible or anthropic_messages")
    label = data.get("label")
    if label is not None and (not isinstance(label, str) or not label.strip() or len(label.strip()) > 80):
        errors.append("label must contain 1-80 characters")
    bu = data.get("base_url", "")
    try:
        parsed = urlsplit(bu)
        if (bu or new_provider) and (parsed.scheme not in {"http", "https"} or not parsed.hostname
                                    or parsed.username or parsed.password or parsed.query or parsed.fragment):
            errors.append("base_url must be an HTTP(S) address without credentials, query or fragment")
        _ = parsed.port
    except (TypeError, ValueError, AttributeError):
        errors.append("invalid base_url")
    for flag in ("enabled", "safe_mode", "clear_api_key"):
        if flag in data and not isinstance(data[flag], bool):
            errors.append(f"{flag} must be boolean")
    if "api_key" in data and data["api_key"] is not None and not isinstance(data["api_key"], str):
        errors.append("api_key must be a string")
    if not data.get("model") and data.get("provider") not in ("disabled", "mock"):
        if data.get("provider") not in ("minimax", "ollama_compatible"):
            errors.append("model is required")
    if data.get("model") is not None and not isinstance(data["model"], str):
        errors.append("model must be a string")
    if new_provider and (not isinstance(data.get("model"), str) or not data["model"].strip()):
        errors.append("model is required")
    temp = data.get("temperature", 0.7)
    if isinstance(temp, bool) or not isinstance(temp, (int, float)) or not 0 <= temp <= 2:
        errors.append("temperature must be 0-2")
    mt = data.get("max_tokens", 4096)
    if isinstance(mt, bool) or not isinstance(mt, int) or mt < 1 or mt > 128000:
        errors.append("max_tokens must be 1-128000")
    if "prompt_cache_enabled" in data and not isinstance(data.get("prompt_cache_enabled"), bool):
        errors.append("prompt_cache_enabled must be boolean")
    top_p = data.get("top_p")
    if top_p is not None and (isinstance(top_p, bool) or not isinstance(top_p, (int, float)) or not 0 < top_p <= 1):
        errors.append("top_p must be greater than 0 and at most 1")
    thinking = data.get("thinking", "provider_default")
    if not isinstance(thinking, str) or thinking not in {"provider_default", "adaptive", "disabled"}:
        errors.append("thinking must be provider_default, adaptive or disabled")
    if data.get("thinking") == "disabled" and str(data.get("model", "")).lower().startswith("minimax-m3.1"):
        errors.append("MiniMax-M3.1 requires adaptive thinking")
    return errors
