# agent/llm/client.py
"""LLM Client — safe external interface, uses unified effective config."""

from agent.state import AgentState
from agent.llm.schemas import SafeLLMOutput
from agent.llm.config import resolve_provider_config, get_llm_status


class LLMClient:
    def __init__(self, overrides: dict = None):
        if overrides and overrides.get("provider"):
            from agent.llm.settings import resolve_provider_llm_config
            cfg = resolve_provider_llm_config(overrides["provider"])
        else:
            cfg = resolve_provider_config()
        if overrides:
            cfg = {**cfg}
            for k in ("base_url", "model", "api_key", "provider", "provider_type"):
                if overrides.get(k):
                    cfg[k] = overrides[k]
            if overrides.get("clear_api_key"):
                cfg["api_key"] = ""
        self._cfg = cfg
        # A default client follows task routing. Only a caller that selected
        # draft/provider settings pins generation to this resolved config.
        self._generation_override = cfg if overrides else None

    def generate(self, task: str, state: AgentState, user_question: str = None) -> SafeLLMOutput:
        from agent.llm.runtime import safe_generate
        return safe_generate(
            task,
            state,
            user_input=user_question or "",
            config_override=self._generation_override,
        )

    def probe(self, message: str = "Reply with OK.") -> dict:
        """Exercise the selected provider's real chat-completions transport.

        Connectivity testing must not depend on task templates, output policy,
        or whichever provider happens to be active globally.
        """
        from agent.llm.provider import generate
        from agent.llm.schemas import LLMMessage, LLMRequest

        from agent.llm.config import _llm_disabled_by_env
        probe_cfg = {**self._cfg, "enabled": not _llm_disabled_by_env(), "temperature": 0.0, "max_tokens": 16}
        from core.tools.redaction import redact_tool_output

        # Replace the actual key before regex redaction and before any output
        # can reach the API or recent-failure persistence. Keys need no prefix.
        def safe(value):
            key = str(probe_cfg.get("api_key") or "")
            def replace(item):
                if isinstance(item, str):
                    return item.replace(key, "[REDACTED]") if key else item
                if isinstance(item, dict):
                    result = {}
                    for name, value in item.items():
                        safe_name = replace(name)
                        base_name, suffix = safe_name, 2
                        while safe_name in result or (safe_name != name and safe_name in item):
                            safe_name = f"{base_name} [#{suffix}]"
                            suffix += 1
                        result[safe_name] = replace(value)
                    return result
                if isinstance(item, (list, tuple)):
                    return [replace(v) for v in item]
                return item
            return redact_tool_output(replace(value))

        try:
            response = generate(LLMRequest(
                task="connection_probe",
                messages=[
                    LLMMessage(role="system", content="You are a connectivity probe. Reply briefly."),
                    LLMMessage(role="user", content=message or "Reply with OK."),
                ],
                model=self._cfg.get("model", ""),
                temperature=0.0,
                max_tokens=16,
                stream=True,
                metadata={"stream_to_user": False, "stream_scope": "probe"},
            ), probe_cfg)
        except Exception as exc:
            return safe({
                "ok": False, "response": "", "error": f"provider_probe_error: {exc}",
                "metadata": {"error_type": "provider_probe_error"},
                "provider": self.provider_info().get("provider"),
                "model": self.provider_info().get("model"),
            })
        return safe({
            "ok": not bool(response.error),
            "response": response.content or "",
            "error": response.error or "",
            "metadata": response.metadata or {},
            "provider": response.provider or self.provider_info().get("provider"),
            "model": response.model or self.provider_info().get("model"),
        })

    def health(self) -> dict:
        from agent.llm.provider import health
        return health(self._cfg)

    def is_connected(self) -> bool:
        return self._cfg.get("enabled", False) and bool(
            self._cfg.get("api_key") or self._cfg.get("provider_type") == "mock"
        )

    def provider_info(self) -> dict:
        return {
            "provider": self._cfg.get("provider", self._cfg.get("default_provider")),
            "type": self._cfg.get("provider_type"),
            "model": self._cfg.get("model"),
            "config_source": self._cfg.get("config_source", "default"),
            "connected": self.is_connected(),
        }

    @staticmethod
    def status() -> dict:
        return get_llm_status()
