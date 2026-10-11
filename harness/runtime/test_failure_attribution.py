from core.runtime_engine.failure_attribution import collect, observation
from core.runtime_engine.loop_messages import StreamingToolResult


def test_conditions_never_claim_model_or_framework_causality():
    for code, category in [("llm_auth_failed", "provider_authentication"),
                           ("llm_request_rejected", "provider_request"),
                           ("coding_check_failed", "application_check"),
                           ("task_state_commit_failed", "runtime_storage"),
                           ("arbitrary_new_failure", "unknown")]:
        fact = observation(code, stage="test")
        assert fact["category"] == category and fact["cause"] == "unresolved"


def test_recovered_tool_failure_is_retained_and_unknown_failure_is_classified():
    failures = collect(tool_calls=[StreamingToolResult("exec.run", "call-1", {}, False, "build failed"),
                                  StreamingToolResult("exec.run", "call-2", {}, True)])
    assert len(failures) == 1 and failures[0]["reference"] == "call-1"
    assert failures[0]["cause"] == "unresolved"
    assert collect(failed=True)[0]["category"] == "unknown"


def test_failure_details_are_redacted():
    fact = observation("error", stage="tool", detail="Authorization: Bearer sk-123456789012345678901234567890")
    assert "sk-123456789012345678901234567890" not in str(fact)


def test_attempt_failures_are_retained_after_terminal_success():
    facts = collect(provider_events=[{'attempt': 1, 'error': 'llm_rate_limited'}],
                    retry_events=[{'node_id': 'node', 'error_code': 'TOOL_EXCEPTION'}])
    assert [fact['category'] for fact in facts] == ['provider_availability', 'tool_execution']
    assert all(fact['cause'] == 'unresolved' for fact in facts)
