"""Independent QA judgement and executable checks are separate evidence."""

import json

from storage.project_changes import manifest_digest, project_path, source_manifest
from storage.redaction import redact_value

QA_SCHEMA = "coding.qa_review.v1"
_TEXT = {"type": "string", "minLength": 1}
QA_REVIEW_SCHEMA = {
    "type": "object",
    "required": ["schema", "verdict", "scope", "blocking_findings", "report"],
    "properties": {
        "schema": {"type": "string", "enum": [QA_SCHEMA]},
        "verdict": {"type": "string", "enum": ["pass", "fail", "unknown"]},
        "scope": _TEXT, "report": _TEXT,
        "blocking_findings": {"type": "array", "items": {"oneOf": [
            _TEXT, {"type": "object", "required": ["title", "evidence"],
                    "properties": {"title": _TEXT, "evidence": _TEXT}},
        ]}},
    },
}


def review_instruction():
    return (
        "Independently review the exact assigned candidate and retain concrete findings, "
        "evidence and phase boundaries. Record your judgement through agent.review using "
        "its published input schema. The tool binds candidate identity on the server. "
        "Use fail for blocking findings and unknown for missing required evidence. "
        "Successful checks alone do not establish business acceptance. "
        "Do not change source. Your final reply may use any clear format."
    )


def record_qa_review(task, review):
    """Persist a native tool judgement independently of final-answer presentation."""
    from core.tools.executor import validate_schema_value
    from .subagent import _load_task, _save_task

    current = _load_task(task.workspace_id, task.subtask_id)
    if not current or current.status != "running":
        raise ValueError("coding_review_requires_running_qa")
    if validate_schema_value("qa_review", review, QA_REVIEW_SCHEMA):
        raise ValueError("invalid_qa_review")
    texts = [review["scope"], review["report"]]
    for finding in review["blocking_findings"]:
        texts.extend([finding] if isinstance(finding, str) else [finding["title"], finding["evidence"]])
    if any(not text.strip() for text in texts):
        raise ValueError("empty_qa_review_text")
    review = redact_value(review)
    review.update(candidate_digest=task.coding["review_candidate_digest"],
                  review_subtask_id=task.coding["review_subtask_id"])
    if review["verdict"] == "pass" and review["blocking_findings"]:
        review.update(proposed_verdict="pass", verdict="fail")
    task.coding["qa_review"] = review
    from .coding_state import record_judgement
    record_judgement(task, review)
    _save_task(task)
    return {"ok": True, "review": review}


def check_qa(task):
    from core.tools.context import ToolRuntimeContext
    from core.tools.integration import get_default_tool_runtime_client
    from .subagent import _cancel_event, _save_task
    from .subagent_control import cancellation_probe

    assignment = task.coding
    source = project_path(assignment["branch_workspace"], assignment["project_dir"])
    digest = manifest_digest(source_manifest(source, assignment.get("generated_paths")))
    from .coding_state import review, record_review_validation
    recorded = review(task)
    cached = (recorded or {}).get("validation") or assignment.get("qa_validation") or {}
    if cached.get("status") == "unknown":
        return cached
    if cached.get("source_digest") == digest and cached.get("status") == "passed":
        return cached
    status, checks = "passed", []
    if source_manifest(source, assignment.get("generated_paths")) != assignment["baseline"]:
        status = "failed"
    else:
        cancel = cancellation_probe(task.workspace_id, task.subtask_id,
                                    _cancel_event(task.workspace_id, task.subtask_id))
        for command in assignment["validation_commands"]:
            observed = get_default_tool_runtime_client().invoke(
                "exec.run", {"action": "shell", "command": command,
                             "working_dir": assignment["project_dir"], "timeout": 180},
                context=ToolRuntimeContext(workspace_id=assignment["branch_workspace"],
                    session_id=task.subtask_id, task_id=task.parent_task_id,
                    requested_by="subagent", cancel_check=cancel),
            )
            output = redact_value({**observed.output, "runtime_status": observed.status})
            checks.append({"command": command, "result": output})
            if output.get("execution_outcome") == "unknown" or output.get("execution_may_continue"):
                status = "unknown"
                break
            if observed.status != "succeeded" or not output.get("ok", True) or output.get("exit_code") != 0:
                status = "failed"
        if source_manifest(source, assignment.get("generated_paths")) != assignment["baseline"] and status != "unknown":
            status = "failed"
    result = {"status": status, "source_digest": digest, "checks": checks,
              "automatic_retry_allowed": status != "unknown"}
    assignment.update(qa_validation=result, validation=checks)
    record_review_validation(task, result)
    _save_task(task)
    return result


def _reject(task, observation):
    from .subagent import _save_task
    phase = ("qa_unknown" if observation["status"] == "unknown" else
             "qa_incomplete" if observation.get("review_verdict") == "unknown" else "qa_rejected")
    task.coding["phase"] = phase
    _save_task(task)
    return observation


def review_qa_proposal(task, proposal):
    """Check recorded judgement and executable evidence; never infer PASS from prose."""
    from .subagent import _save_task
    # Older callers may still return the v1 judgement as their final answer.
    # New workers submit it through the tool; prose is retained, never scored.
    if not task.coding.get("qa_review"):
        try:
            record_qa_review(task, json.loads(proposal))
        except (ValueError, TypeError):
            task.coding["qa_invalid_proposal"] = redact_value(proposal)
            _save_task(task)
            return _reject(task, {"status": "failed", "review_verdict": "unknown",
                                 "automatic_retry_allowed": False})
    review = task.coding["qa_review"]
    task.coding["qa_final_report"] = redact_value(proposal)
    _save_task(task)
    if (task.coding.get("qa_validation") or {}).get("status") == "unknown":
        review.update(proposed_verdict=review["verdict"], verdict="unknown")
        _save_task(task)
        return _reject(task, {**task.coding["qa_validation"], "automatic_retry_allowed": False})
    if review["verdict"] != "pass":
        return _reject(task, {"status": "failed", "review_verdict": review["verdict"],
            "terminal_error": "coding_qa_review_rejected", "final_response": json.dumps(review, ensure_ascii=False),
            "automatic_retry_allowed": False})
    validation = check_qa(task)
    if validation["status"] != "passed":
        review.update(proposed_verdict="pass", verdict="unknown" if validation["status"] == "unknown" else "fail")
        _save_task(task)
        return _reject(task, {**validation, "terminal_error": "coding_independent_validation_failed"})
    return {**validation, "review_verdict": "pass"}
