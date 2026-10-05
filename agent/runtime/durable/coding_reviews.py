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
        "[SERVER QA REVIEW CONTRACT]\nReturn one complete JSON object, without Markdown fences. "
        "Use this same server validation schema (all text must be nonempty): "
        + json.dumps(QA_REVIEW_SCHEMA, separators=(",", ":"))
        + "\nUse fail for any blocking finding, unknown for unverified required evidence. "
        "Blocking findings may be nonempty strings or evidence objects with nonempty title/evidence; "
        "retain useful severity/location/contract fields. Any blocking item prevents PASS. "
        "A successful test/build or Agent turn cannot override your failed judgement. "
        "Keep the complete report, concrete findings and phase boundaries. Do not change source."
    )


def check_qa(task):
    from core.tools.context import ToolRuntimeContext
    from core.tools.integration import get_default_tool_runtime_client
    from .subagent import _cancel_event, _save_task
    from .subagent_control import cancellation_probe

    assignment = task.coding
    source = project_path(assignment["branch_workspace"], assignment["project_dir"])
    digest = manifest_digest(source_manifest(source, assignment.get("generated_paths")))
    cached = assignment.get("qa_validation") or {}
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
    _save_task(task)
    return result


def _reject(task, observation):
    from .coding_team import _related
    from .subagent import _save_task
    phase = ("qa_unknown" if observation["status"] == "unknown" else
             "qa_incomplete" if observation.get("review_verdict") == "unknown" else "qa_rejected")
    task.coding["phase"] = phase
    _save_task(task)
    target = _related(task, task.coding["review_subtask_id"])
    if target.coding.get("candidate_digest") == task.coding["review_candidate_digest"]:
        target.coding.update(phase=phase, qa_rejection_subtask_id=task.subtask_id)
        _save_task(target)
    return observation


def review_qa_proposal(task, proposal):
    """Validate visible structured judgement; never infer PASS from prose."""
    from .subagent import _save_task
    try:
        review = json.loads(proposal)
        from core.tools.executor import validate_schema_value
        if validate_schema_value("qa_review", review, QA_REVIEW_SCHEMA):
            raise ValueError("invalid_qa_review")
        texts = [review["scope"], review["report"]]
        for finding in review["blocking_findings"]:
            texts.extend([finding] if isinstance(finding, str) else [finding["title"], finding["evidence"]])
        if any(not text.strip() for text in texts):
            raise ValueError("empty_qa_review_text")
    except (ValueError, TypeError):
        task.coding["qa_invalid_proposal"] = redact_value(proposal)
        _save_task(task)
        return {"status": "failed", "proposal_invalid": True,
                "recovery_instruction": review_instruction()}
    review = redact_value(review)
    review.update(candidate_digest=task.coding["review_candidate_digest"],
                  review_subtask_id=task.coding["review_subtask_id"])
    if review["verdict"] == "pass" and review["blocking_findings"]:
        review["proposed_verdict"] = "pass"
        review["verdict"] = "fail"
    task.coding["qa_review"] = review
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


def accepted_review(task, candidate_digest):
    review = task.coding.get("qa_review") or {}
    return (review.get("schema") == QA_SCHEMA and review.get("verdict") == "pass"
            and review.get("blocking_findings") == [] and review.get("candidate_digest") == candidate_digest
            and review.get("review_subtask_id") == task.coding.get("review_subtask_id")
            and bool(review.get("scope")) and bool(review.get("report")))
