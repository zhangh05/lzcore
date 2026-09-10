"""SSOT adapter must preserve typed provider failures for QueryLoop."""

from agent.llm.schemas import LLMResponse


def test_ssot_adapter_returns_disabled_provider_result_without_raising(monkeypatch):
    from agent.runtime.ssot_runtime import _invoke_llm_for_ssot_runtime

    monkeypatch.setattr(
        "agent.llm.runtime.invoke_llm",
        lambda **_kwargs: LLMResponse(error="LLM disabled"),
    )

    response = _invoke_llm_for_ssot_runtime(system="system", user="hello")

    assert response.error == "LLM disabled"
