"""Real-provider prerequisites, separate from application acceptance.

A saved credential and a reachable endpoint do not prove that a model request
is accepted. Never count a failed prerequisite as an application-generation
attempt, and never publish provider bodies or credentials in this evidence.
"""

from __future__ import annotations

import time


def provider_preflight(config: dict) -> dict:
    evidence = {
        "schema": "coding.benchmark_preflight.v1",
        "provider": config.get("provider"),
        "model": config.get("model"),
        "provider_type": config.get("provider_type"),
        "status": "BLOCKED",
        "agent_started": False,
    }
    if (
        config.get("enabled") is not True
        or not config.get("key_loaded")
        or not config.get("api_key")
        or config.get("provider_type") in {None, "", "disabled", "mock"}
    ):
        return {**evidence, "reason": "real_provider_not_configured"}

    from agent.llm.provider import generate
    from agent.llm.schemas import LLMMessage, LLMRequest

    started = time.monotonic()
    try:
        # Match the production connection probe; no tools or project operations
        # are authorized by this request. Provider settings stay unchanged.
        probe_config = {**config, "temperature": 0.0, "max_tokens": 16}
        response = generate(
            LLMRequest(
                task="connection_probe",
                messages=[LLMMessage(role="user", content="Reply with OK.")],
                model=probe_config.get("model", ""),
                temperature=0.0,
                max_tokens=16,
                stream=True,
                metadata={"stream_to_user": False, "stream_scope": "benchmark_preflight"},
            ),
            probe_config,
        )
    except Exception:
        # Exceptions can include private request details. The provider adapter
        # owns diagnostics; readiness evidence only records a stable category.
        return {**evidence, "reason": "provider_probe_exception",
                "duration_seconds": round(time.monotonic() - started, 3)}

    metadata = response.metadata or {}
    raw_status = metadata.get("http_status")
    status = raw_status if type(raw_status) is int else None
    evidence.update(
        http_status=status,
        duration_seconds=round(time.monotonic() - started, 3),
    )
    if response.error:
        reason = {
            401: "provider_authentication_failed",
            403: "provider_access_denied",
            429: "provider_rate_or_quota_limit",
        }.get(status, "provider_request_failed")
        return {**evidence, "reason": reason}
    # A reasoning model may spend this tiny probe's entire output budget on
    # reasoning. A real accepted response with usage is still readiness, not a
    # failed credential. Business/engineering quality is evaluated separately.
    if not response.content and not response.tool_calls and not response.usage and status != 200:
        return {**evidence, "reason": "provider_empty_response"}
    return {**evidence, "status": "READY", "reason": None}
