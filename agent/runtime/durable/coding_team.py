"""Durable coding assignments: isolated branches, dependencies, QA and integration.

Profiles share the canonical runtime/tool surface. Their filesystem branches
are independent; successful child prose alone never authorizes publication.
"""

from __future__ import annotations

import json
import shlex
import socket
import uuid
from contextlib import contextmanager

from storage.paths import ensure_workspace_storage_dirs
from storage.project_changes import (
    changeset,
    copy_sources,
    manifest_digest,
    project_path,
    publish_changes,
    quiescent_project,
    source_manifest,
    validate_responsibilities,
    validate_generated_paths,
)

CODING_PROFILES = frozenset({"coding_agent", "frontend_agent", "qa_agent"})


def _related(task, subtask_id: str):
    from .subagent import _load_task

    item = _load_task(task.workspace_id, subtask_id)
    if (
        not item
        or item.parent_task_id != task.parent_task_id
        or item.session_id != task.session_id
    ):
        raise ValueError("coding_dependency_outside_parent")
    if not item.coding:
        raise ValueError("coding_dependency_has_no_changeset")
    return item


def create_assignment(task, supplied: dict) -> dict:
    if not task.parent_task_id or not task.session_id:
        raise ValueError("coding_requires_trusted_parent_identity")
    if task.workbench_context:
        # A domain Skill cannot be silently moved to a different data scope.
        raise ValueError("coding_branch_requires_unscoped_coding_task")
    project = str(supplied.get("project_dir") or "")
    project_path(task.workspace_id, project)
    review_id = str(supplied.get("review_subtask_id") or "")
    dependencies = list(dict.fromkeys(supplied.get("depends_on") or []))
    responsibilities = validate_responsibilities(supplied.get("responsibilities") or [])
    commands = supplied.get("validation_commands") or []
    if (
        not commands
        or len(commands) > 12
        or any(
            not isinstance(value, str) or not value.strip() or "\x00" in value
            for value in commands
        )
    ):
        raise ValueError("coding_validation_commands_required")
    # Each declared check denotes one executable and its literal arguments.
    # Do not accidentally turn user supplied check text into shell control
    # flow, expansion or a pipeline whose last process masks a failure.
    commands = [shlex.join(shlex.split(command)) for command in commands]
    if any(not shlex.split(command) for command in commands):
        raise ValueError("coding_validation_commands_required")
    assignment = {
        "schema": "coding.assignment.v1",
        "project_dir": project,
        "responsibilities": responsibilities,
        "generated_paths": validate_generated_paths(supplied.get("generated_paths")),
        "depends_on": dependencies,
        "validation_commands": commands,
        "review_subtask_id": review_id,
        "branch_workspace": "coding-" + uuid.uuid4().hex,
        "phase": "assigned",
    }
    task.coding = assignment
    for subtask_id in dependencies:
        _related(task, subtask_id)
    if task.profile_id == "qa_agent":
        if not review_id:
            raise ValueError("coding_qa_review_target_required")
        target = _related(task, review_id)
        if target.profile_id == "qa_agent" or target.coding["project_dir"] != project:
            raise ValueError("invalid_coding_qa_review_target")
        # The implementation assignment owns required checks. QA cannot weaken
        # them by asking for an easier command set.
        assignment["validation_commands"] = list(target.coding["validation_commands"])
        assignment["generated_paths"] = list(target.coding.get("generated_paths", []))
    elif review_id:
        raise ValueError("coding_review_target_requires_qa_profile")
    return assignment


def ready(task) -> bool:
    assignment = task.coding
    for subtask_id in assignment.get("depends_on") or []:
        if _related(task, subtask_id).coding.get("phase") != "integrated":
            assignment["phase"] = "dependency_wait"
            return False
    if task.profile_id == "qa_agent":
        target = _related(task, assignment["review_subtask_id"])
        if target.coding.get("phase") not in {"changes_ready", "validated"}:
            assignment["phase"] = "dependency_wait"
            return False
    return True


def _free_preview_port() -> int:
    with socket.socket() as port:
        port.bind(("127.0.0.1", 0))
        return port.getsockname()[1]


@contextmanager
def coding_run(task):
    """One branch execution; no host fallback when the kernel is unavailable."""
    from core.tools.project_execution import isolated_project

    from .subagent import _save_task

    assignment = task.coding
    branch_ws = assignment["branch_workspace"]
    ensure_workspace_storage_dirs(branch_ws)
    branch = project_path(branch_ws, assignment["project_dir"])
    if branch.exists():
        raise ValueError("coding_branch_already_executed")
    if task.profile_id == "qa_agent":
        target = _related(task, assignment["review_subtask_id"])
        source = project_path(
            target.coding["branch_workspace"], assignment["project_dir"]
        )
        baseline = source_manifest(source, assignment.get("generated_paths"))
        if manifest_digest(baseline) != target.coding["candidate_digest"]:
            raise ValueError("coding_review_candidate_changed")
        assignment["review_digest"] = target.coding["change"]["digest"]
        assignment["review_candidate_digest"] = target.coding["candidate_digest"]
        copy_sources(source, branch, baseline)
    else:
        with quiescent_project(task.workspace_id):
            source = project_path(task.workspace_id, assignment["project_dir"])
            baseline = source_manifest(source, assignment.get("generated_paths"))
            copy_sources(source, branch, baseline)
    assignment["baseline"] = baseline
    assignment["phase"] = "executing"
    _save_task(task)
    port = _free_preview_port()
    with isolated_project(branch_ws, branch, port) as environment:
        assignment["environment"] = environment.descriptor()
        instruction = (
            task.goal
            + "\n\n[SERVER CODING ASSIGNMENT]\n"
            + json.dumps(
                {
                    "project_dir": assignment["project_dir"],
                    "responsibilities": assignment["responsibilities"],
                    "generated_paths": assignment.get("generated_paths", []),
                    "role": task.profile_id,
                    "preview_origin": f"http://127.0.0.1:{port}",
                    "validation_commands": assignment["validation_commands"],
                    "review_subtask_id": assignment["review_subtask_id"],
                    "constraints": "Work only in this isolated project branch. Dependencies are already integrated. Bind preview to 0.0.0.0. QA must preserve all reviewed source files; temporary acceptance code belongs under /tmp. Parent integration requires an independent QA task and exact candidate identity.",
                },
                ensure_ascii=False,
            )
        )
        try:
            yield branch_ws, instruction, environment
        finally:
            environment.close()
            assignment["environment"] = environment.descriptor()
            _save_task(task)
            if (
                task.profile_id == "qa_agent"
                and source_manifest(branch, assignment.get("generated_paths"))
                != baseline
            ):
                assignment["phase"] = "qa_failed"
                _save_task(task)
                raise ValueError("coding_qa_source_changed_before_cleanup")
            if not environment.cleanup_confirmed:
                assignment["phase"] = "unknown"
                _save_task(task)
                raise RuntimeError("coding_branch_cleanup_unconfirmed")


def finish_assignment(task, environment, runtime_ok: bool) -> None:
    from .subagent import _save_task

    assignment = task.coding
    branch = project_path(assignment["branch_workspace"], assignment["project_dir"])
    if not runtime_ok:
        assignment["phase"] = "failed"
        _save_task(task)
        return
    if task.profile_id == "qa_agent":
        if (
            source_manifest(branch, assignment.get("generated_paths"))
            != assignment["baseline"]
        ):
            raise ValueError("coding_qa_modified_reviewed_source")
        evidence = []
        for command in assignment["validation_commands"]:
            from core.tools.context import ToolRuntimeContext
            from core.tools.integration import get_default_tool_runtime_client

            from .subagent import _cancel_event
            from .subagent_control import cancellation_probe

            observed = get_default_tool_runtime_client().invoke(
                "exec.run",
                {
                    "action": "shell",
                    "command": command,
                    "working_dir": assignment["project_dir"],
                    "timeout": 180,
                },
                context=ToolRuntimeContext(
                    workspace_id=assignment["branch_workspace"],
                    session_id=task.subtask_id,
                    task_id=task.parent_task_id,
                    requested_by="subagent",
                    cancel_check=cancellation_probe(
                        task.workspace_id,
                        task.subtask_id,
                        _cancel_event(task.workspace_id, task.subtask_id),
                    ),
                ),
            )
            output = {**observed.output, "runtime_status": observed.status}
            output["ok"] = observed.status == "succeeded" and bool(
                output.get("ok", True)
            )
            # Runtime results, not the Agent's final answer, determine checks.
            from storage.redaction import redact_value

            evidence.append({"command": command, "result": redact_value(output)})
            if not output.get("ok") or output.get("exit_code") != 0:
                assignment.update(phase="qa_failed", validation=evidence)
                _save_task(task)
                raise ValueError("coding_independent_validation_failed")
        if (
            source_manifest(branch, assignment.get("generated_paths"))
            != assignment["baseline"]
        ):
            raise ValueError("coding_validation_modified_reviewed_source")
        assignment.update(phase="validated", validation=evidence)
        target = _related(task, assignment["review_subtask_id"])
        if target.coding["change"]["digest"] != assignment["review_digest"]:
            raise ValueError("coding_review_identity_changed")
        target.coding.update(
            phase="validated",
            qa_subtask_id=task.subtask_id,
            qa_candidate_digest=assignment["review_candidate_digest"],
        )
        _save_task(target)
    else:
        # Stop all descendants before hashing the output. Detached generators
        # cannot mutate a candidate after it has been declared changes_ready.
        if not environment.close():
            raise RuntimeError("coding_candidate_processes_not_stopped")
        current = source_manifest(branch, assignment.get("generated_paths"))
        assignment.update(
            change=changeset(
                assignment["baseline"], current, assignment["responsibilities"]
            ),
            candidate_digest=manifest_digest(current),
            phase="changes_ready",
        )
    _save_task(task)


def integrate(task) -> dict:
    from .subagent import _save_task

    assignment = task.coding
    if task.profile_id == "qa_agent":
        return {"ok": False, "error": "qa_has_no_implementation_changes"}
    if assignment.get("phase") == "integrated":
        return {"ok": True, "merged": True, "coding": assignment}
    if assignment.get("phase") not in {"validated", "conflict", "unknown"}:
        return {
            "ok": False,
            "error": "coding_independent_qa_required",
            "phase": assignment.get("phase"),
        }
    qa = _related(task, str(assignment.get("qa_subtask_id") or ""))
    if (
        qa.status != "succeeded"
        or qa.coding.get("phase") != "validated"
        or qa.coding.get("review_digest") != assignment["change"]["digest"]
    ):
        return {"ok": False, "error": "coding_qa_not_successful"}
    branch = project_path(assignment["branch_workspace"], assignment["project_dir"])
    if (
        manifest_digest(source_manifest(branch, assignment.get("generated_paths")))
        != assignment["qa_candidate_digest"]
    ):
        return {"ok": False, "error": "coding_candidate_changed_after_qa"}
    result = publish_changes(
        task.workspace_id,
        assignment["project_dir"],
        task.subtask_id,
        branch,
        assignment["change"],
        generated_paths=assignment.get("generated_paths"),
    )
    assignment.update(phase=result["phase"], publication=result)
    _save_task(task)
    return {
        **result,
        "merged": bool(result["ok"]),
        "subtask_id": task.subtask_id,
        "parent_task_id": task.parent_task_id,
    }
