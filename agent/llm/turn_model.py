"""Per-turn model choice.

The workbench may run one turn on a configured provider other than the active
one, optionally with a different thinking mode. The choice lives in a context
variable for the duration of that turn only: it never switches the active
provider, never persists into provider files, and every resolution inside the
turn (routing, context budget, trace labels) sees the same model.

Only providers that are already configured with a model and a usable key can
be chosen; the client names a provider and a thinking mode, never a URL or key.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator

THINKING_MODES = ("provider_default", "adaptive", "disabled")

_TURN_MODEL: ContextVar[dict | None] = ContextVar("lzcore_turn_model", default=None)


class ModelSelectionError(ValueError):
    """The requested model cannot be used for this turn."""


def supports_thinking_control(model: str) -> bool:
    """Mirror of the request builder: only MiniMax-M3 models accept a thinking mode."""
    return str(model or "").lower().startswith("minimax-m3")


def provider_selectable(cfg: dict) -> bool:
    """A provider can run a turn when it is enabled, has a model and a key."""
    return bool(cfg.get("enabled", True) and cfg.get("model") and cfg.get("key_configured"))


def normalize_model_selection(raw: object) -> dict | None:
    """Validate the untrusted selection shape. Empty or absent means "active provider"."""
    if raw in (None, "", {}):
        return None
    if not isinstance(raw, dict):
        raise ModelSelectionError("model_selection must be an object")
    provider = raw.get("provider")
    thinking = raw.get("thinking", "provider_default") or "provider_default"
    if provider in (None, ""):
        provider = None
    elif not isinstance(provider, str) or len(provider) > 80:
        raise ModelSelectionError("provider must be a provider id")
    if thinking not in THINKING_MODES:
        raise ModelSelectionError("thinking must be provider_default, adaptive or disabled")
    if provider is None and thinking == "provider_default":
        return None
    return {"provider": provider, "thinking": thinking}


def resolve_model_selection(selection: dict | None) -> dict | None:
    """Turn a normalized selection into the runtime config the turn will use."""
    if not selection:
        return None
    from agent.llm.provider_store import get_active_provider, load_provider_config, provider_exists
    from agent.llm.settings import resolve_provider_llm_config

    provider = selection.get("provider") or get_active_provider()
    if not provider_exists(provider):
        raise ModelSelectionError("所选模型的厂商不存在")
    cfg = dict(resolve_provider_llm_config(provider))
    label = (load_provider_config(provider) or {}).get("label") or provider
    if not provider_selectable({**cfg, "key_configured": bool(cfg.get("api_key"))}):
        raise ModelSelectionError(f"{label} 未配置模型或密钥，不能用于本轮")
    thinking = selection.get("thinking") or "provider_default"
    if thinking != "provider_default":
        if not supports_thinking_control(cfg.get("model", "")):
            raise ModelSelectionError(f"{cfg.get('model')} 不支持调节思考模式")
        if thinking == "disabled" and str(cfg.get("model", "")).lower().startswith("minimax-m3.1"):
            raise ModelSelectionError("MiniMax-M3.1 只能使用自适应思考")
        cfg["thinking"] = thinking
    cfg["config_source"] = "turn_selection"
    return cfg


def current_turn_model_config() -> dict | None:
    cfg = _TURN_MODEL.get()
    return dict(cfg) if cfg else None


@contextmanager
def turn_model(cfg: dict | None) -> Iterator[None]:
    """Run the enclosed turn on ``cfg``; ``None`` leaves the active provider in charge."""
    if not cfg:
        yield
        return
    token = _TURN_MODEL.set(dict(cfg))
    try:
        yield
    finally:
        _TURN_MODEL.reset(token)
