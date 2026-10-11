"""Provider transports must reject missing credentials without network I/O."""

from agent.llm.provider import ERROR_TYPE_MISSING_API_KEY, _anthropic_messages_generate
from agent.llm.schemas import LLMMessage, LLMRequest


def test_anthropic_transport_does_not_send_a_request_without_an_api_key(monkeypatch):
    def unexpected_request(*_args, **_kwargs):
        raise AssertionError("missing credentials must not reach the provider")

    monkeypatch.setattr("requests.post", unexpected_request)
    response = _anthropic_messages_generate(
        LLMRequest(task="test", messages=[LLMMessage(role="user", content="hello")]),
        {
            "provider": "minimax",
            "provider_type": "anthropic_messages",
            "base_url": "https://example.invalid/v1",
            "api_key": "",
        },
    )

    assert response.metadata["error_type"] == ERROR_TYPE_MISSING_API_KEY
