"""Stable safe provider failures and operator-facing messages."""

from __future__ import annotations

from typing import Any


def _normalize_llm_error(error: Any) -> str:
    """Convert provider-specific failures into stable, safe runtime codes."""
    value = str(error or "").strip().lower()
    if value in {
        "llm_call_timeout",
        "llm_rate_limited",
        "llm_auth_failed",
        "llm_configuration_error",
        "llm_request_rejected",
        "llm_provider_error",
        "llm_empty_response",
        "no_response",
        "context_capacity_exceeded",
        "context_checkpoint_failed",
    }:
        return value
    if value == "provider_empty_response":
        return "llm_empty_response"
    if "timeout" in value or "timed out" in value:
        return "llm_call_timeout"
    if "429" in value or "rate limit" in value or "too many request" in value:
        return "llm_rate_limited"
    if any(
        marker in value
        for marker in (
            "401",
            "403",
            "unauthorized",
            "authentication",
            "api key",
            "invalid key",
        )
    ):
        return "llm_auth_failed"
    if any(
        marker in value
        for marker in (
            "llm disabled",
            "llm is disabled",
            "disabled by user",
            "disabled_by_user",
            "model not found",
            "invalid model",
            "configuration",
            "config",
        )
    ):
        return "llm_configuration_error"
    # These errors describe the request we are about to resend, rather than a
    # transient condition at the provider.  Retrying the byte-for-byte same
    # payload would create an unbounded loop when production has no turn cap.
    if any(
        marker in value
        for marker in (
            "400",
            "422",
            "bad request",
            "invalid request",
            "invalid parameter",
            "schema validation",
            "malformed",
            "context length",
            "context window",
            "maximum context",
            "too many tokens",
            "prompt is too long",
            "content filter",
            "content policy",
        )
    ):
        return "llm_request_rejected"
    return "llm_provider_error"


def _llm_failure_message(error_code: str) -> str:
    messages = {
        "llm_call_timeout": "模型响应超时，请稍后重试。",
        "llm_rate_limited": "模型服务当前繁忙，请稍后重试。",
        "llm_auth_failed": "模型服务认证失败，请联系管理员检查模型配置。",
        "llm_configuration_error": "模型服务配置不可用，请联系管理员检查配置。",
        "llm_request_rejected": "模型服务拒绝了当前请求；保留的上下文和证据未丢失，但需要修正请求或模型约束后才能继续。",
        "llm_empty_response": "模型服务连续返回空响应，没有正文或完整工具调用；已停止重复请求，保留历史和已有证据，请检查模型响应后继续。",
        "context_capacity_exceeded": "完整上下文的估算大小超过当前模型的可用容量，已停止重复请求。历史和工具结果仍保留，请使用容量更大的模型或在新会话中继续。",
        "context_checkpoint_failed": "上下文接续归档未成功，任务已停止；历史和已执行结果保留，请恢复存储后继续，不要重复未知结果的写入。",
    }
    return messages.get(error_code, "模型服务暂时不可用，请稍后重试。")
