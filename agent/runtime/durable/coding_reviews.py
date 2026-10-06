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
    from .coding_state import review as read_review
    binding = read_review(task)
    if not binding:
        raise ValueError("coding_review_unavailable")
    from storage.coding_state_store import read
    target = read(task.workspace_id, "candidates", binding["candidate_id"])
    review.update(candidate_digest=binding["candidate_digest"],
                  review_subtask_id=target["producer_task_id"])
    if review["verdict"] == "pass" and review["blocking_findings"]:
        review.update(proposed_verdict="pass", verdict="fail")
    from .coding_state import record_judgement
    record_judgement(task, review)
    _save_task(task)
    return {"ok": True, "review": review}


def check_qa(task):
    from core.tools.context import ToolRuntimeContext
    from core.tools.integration import get_default_tool_runtime_client
    from .subagent import _cancel_event, _save_task
    from .subagent_control import cancellation_probe

    from .coding_state import review as read_review
    assignment = read_review(task)
    if not assignment:
        raise ValueError("coding_review_unavailable")
    from .coding_state import record_review_validation
    cached = assignment.get("validation") or {}
    if cached.get("status") == "unknown":
        return cached
    if assignment["state"] != "running":
        return cached
    source = project_path(assignment["branch_workspace"], assignment["project_dir"])
    digest = manifest_digest(source_manifest(source, assignment.get("generated_paths")))
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
    """Review Store owns judgement/checks; final-answer parsing is legacy input."""
    from .coding_state import review as read_review, record_review_report
    recorded = read_review(task)
    if not recorded:
        raise ValueError("coding_review_unavailable")
    if recorded["validation"].get("status") == "unknown":
        return _reject(task, {**recorded["validation"], "automatic_retry_allowed": False})
    if not recorded.get("judgement"):
        try:
            record_qa_review(task, json.loads(proposal))
        except (ValueError, TypeError):
            record_review_report(task, redact_value(proposal), invalid=True)
            return _reject(task, {"status": "failed", "review_verdict": "unknown",
                                 "automatic_retry_allowed": False})
    recorded = read_review(task)
    judgement = recorded["judgement"]
    record_review_report(task, redact_value(proposal))
    if judgement["verdict"] != "pass":
        return _reject(task, {"status": "failed", "review_verdict": judgement["verdict"],
            "terminal_error": "coding_qa_review_rejected", "final_response": json.dumps(judgement, ensure_ascii=False),
            "automatic_retry_allowed": False})
    validation = check_qa(task)
    if validation["status"] != "passed":
        return _reject(task, {**validation, "terminal_error": "coding_independent_validation_failed"})
    return {**validation, "review_verdict": "pass"}
