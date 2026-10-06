"""Evidence-only failure taxonomy. It never drives execution, policy or retries.

An observed failure boundary is not proof of a model or framework defect.
Unresolved causality is explicit, including provider request rejections and
application checks that may fail because of source, dependencies or environment.
"""
from __future__ import annotations

from storage.redaction import redact_text

_CONDITIONS = {
    "llm_auth_failed": ("provider_authentication", "authentication_rejected"),
    "llm_rate_limited": ("provider_availability", "rate_limited"),
    "llm_balance_insufficient": ("provider_availability", "balance_or_quota_insufficient"),
    "llm_call_timeout": ("provider_availability", "response_timeout"),
    "llm_provider_error": ("provider_availability", "provider_error"),
    "llm_configuration_error": ("configuration", "configuration_unavailable"),
    "llm_request_rejected": ("provider_request", "request_rejected"),
    "llm_empty_response": ("model_response", "empty_response"),
    "cancelled_by_user": ("user_control", "cancelled"),
    "context_checkpoint_failed": ("runtime_storage", "checkpoint_unavailable"),
    "context_archive_persist_failed": ("runtime_storage", "archive_unavailable"),
    "task_state_commit_failed": ("runtime_storage", "task_state_unavailable"),
    "task_state_commit_rejected": ("runtime_storage", "task_state_revision_conflict"),
    "task_state_resolution_failed": ("runtime_storage", "task_state_resolution_failed"),
    "run_record_persistence_failed": ("runtime_storage", "run_record_unavailable"),
    "context_capacity_exceeded": ("runtime_context", "capacity_exceeded"),
    "EXECUTION_POLICY_BLOCKED": ("governance", "policy_denied"),
    "EXECUTION_TOOL_TIMEOUT": ("tool_execution", "timeout"),
    "EXECUTION_TOOL_EXCEPTION": ("tool_execution", "exception"),
    "VALIDATION_ARG_SCHEMA": ("tool_contract", "arguments_rejected"),
    "EXECUTION_SCHEMA_MISMATCH": ("tool_contract", "result_schema_mismatch"),
    "EXECUTION_INVALID_OUTPUT": ("tool_contract", "result_invalid"),
    "coding_check_failed": ("application_check", "declared_check_failed"),
    "coding_review_rejected": ("application_review", "reviewer_reported_failure"),
    "coding_review_interrupted": ("execution_control", "interrupted"),
    "coding_check_unknown": ("tool_execution", "check_outcome_unknown"),
    "coding_project_state_unavailable": ("runtime_storage", "project_index_unavailable"),
    "coding_environment_unconfirmed": ("execution_environment", "cleanup_or_execution_unconfirmed"),
    "publication_unknown": ("publication", "write_outcome_unknown"),
    "publication_conflict": ("publication", "source_conflict"),
    "TOOL_TIMEOUT": ("tool_execution", "timeout"),
    "TOOL_TIMEOUT_UNCERTAIN": ("tool_execution", "execution_outcome_unknown"),
    "TOOL_EXCEPTION": ("tool_execution", "exception"),
    "TOOL_RETURNED_NOT_OK": ("tool_execution", "handler_reported_failure"),
    "TOOL_NOT_REGISTERED": ("tool_contract", "tool_unavailable"),
    "TOOL_RESULT_INVALID": ("tool_contract", "result_invalid"),
    "NULL_RESULT": ("tool_contract", "result_missing"),
    "SCHEMA_VALIDATION_ERROR": ("tool_contract", "arguments_rejected"),
    "CONTRACT_VIOLATION": ("tool_contract", "contract_mismatch"),
    "POLICY_BLOCKED": ("governance", "policy_denied"),
    "caller_missing": ("governance", "caller_identity_missing"),
    "RUNTIME_EXCEPTION": ("runtime_boundary", "unhandled_exception"),
}


def observation(code, *, stage, reference="", detail=""):
    if isinstance(code, dict):
        detail = detail or code.get("message") or code.get("error") or ""
        code = code.get("code") or code.get("error_code") or "unclassified_failure"
    code = redact_text(str(code or "unclassified_failure"))
    category, condition = _CONDITIONS.get(code, ("unknown", "unclassified_failure"))
    return {"schema": "runtime.failure.v1", "code": code, "category": category,
            "condition": condition, "cause": "unresolved", "stage": stage,
            "reference": redact_text(str(reference)), "detail": redact_text(str(detail or ""))}


def collect(*, errors=(), tool_calls=(), run_id="", failed=False, provider_events=(), retry_events=()):
    facts = [observation(error, stage="turn", reference=run_id) for error in (errors or ()) if error]
    for call in tool_calls:
        if isinstance(call, dict):
            success = call.get("ok", False)
            reference = call.get("call_id") or call.get("node_id") or ""
            codes = call.get("errors") or [call.get("error_code") or "unclassified_tool_failure"]
            detail = call.get("summary") or ""
        else:
            success = getattr(call, "ok", getattr(call, "success", False))
            reference = getattr(call, "call_id", getattr(call, "node_id", ""))
            codes = [call.error_code or "unclassified_tool_failure"]
            detail = call.error or ""
        if not success:
            facts.extend(observation(code, stage="tool", reference=reference, detail=detail) for code in codes)
    if failed and not facts:
        facts.append(observation("unclassified_failure", stage="turn", reference=run_id))
    for event in provider_events:
        # These are failures at the provider boundary, even when a later
        # request recovered. Their cause is not inferred from message text.
        facts.append(observation(event.get("error") or "unclassified_provider_failure",
            stage="provider_attempt", reference=f"{run_id}:provider:{event.get('attempt', '')}"))
    for index, event in enumerate(retry_events):
        facts.append(observation(event.get("error_code") or "unclassified_tool_failure",
            stage="tool_attempt", reference=f"{event.get('node_id', '')}:retry:{index}"))
    return facts


def coding_checks(validation, resources, *, reference):
    facts = []
    if validation.get("status") == "failed":
        facts.append(observation("coding_check_failed", stage="validation", reference=reference))
    if validation.get("status") == "unknown":
        facts.append(observation("coding_check_unknown", stage="validation", reference=reference))
    if not resources.get("closed") or not resources.get("cleanup_confirmed"):
        facts.append(observation("coding_environment_unconfirmed", stage="cleanup", reference=reference))
    return facts
