"""Transport protocols are independent of provider identity and display name."""

PROVIDER_PROTOCOLS = {
    "openai_compatible": {"label": "OpenAI 兼容", "hint": "Chat Completions"},
    "anthropic_messages": {"label": "Anthropic Messages", "hint": "Messages API"},
}


def resolve_protocol(provider_id: str, config: dict) -> str:
    """Honor explicit transport; infer only for older configurations."""
    explicit = config.get("provider_type")
    if explicit:
        return "openai_compatible" if explicit == "ollama_compatible" else explicit
    if provider_id == "anthropic" or (
        provider_id == "minimax" and str(config.get("model") or "").lower().startswith("minimax-m3")
    ):
        return "anthropic_messages"
    if provider_id in {"disabled", "mock"}:
        return provider_id
    return "openai_compatible"
