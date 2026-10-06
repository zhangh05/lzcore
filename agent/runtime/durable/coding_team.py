"""Durable coding assignments: isolated branches, dependencies, QA and integration.

Profiles share the canonical runtime/tool surface. Their filesystem branches
are independent; successful child prose alone never authorizes publication.
"""

from __future__ import annotations

import json
import hashlib
import os
import shlex
import socket
import uuid
from contextlib import contextmanager
from pathlib import Path

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


def parent_contract(task, references=None):
    """Resolve complete user messages from the same server-owned parent task.

    A coordinator's rewritten instruction is a scope proposal, not a lossless
    copy of the user's requirements. References retain canonical provenance.
    """
    from agent.runtime.task_state import load_task_state
    from storage.message_store import SessionMessageStore

    if references is None:
        state = load_task_state(task.workspace_id, task.session_id).get("task") or {}
        if state.get("task_id") != task.parent_task_id:
            return []
        first = state.get("objective_run_id") or state.get("source_run_id")
        messages = SessionMessageStore(task.session_id, task.workspace_id).get_messages()
        users = [item for item in messages if item.get("role") == "user"]
        start = next((i for i, item in enumerate(users) if item.get("run_id") == first), None)
        if start is None:
            raise ValueError("coding_parent_contract_unavailable")
        selected = users[start:]
    else:
        messages = SessionMessageStore(task.session_id, task.workspace_id).get_messages()
        users = {item["run_id"]: item for item in messages if item.get("role") == "user"}
        selected = [users.get(reference["run_id"]) for reference in references]
    result = []
    for index, item in enumerate(selected):
        if not item or item.get("artifact_unavailable"):
            raise ValueError("coding_parent_contract_unavailable")
        content = item.get("content", "")
        digest = hashlib.sha256(content.encode()).hexdigest()
        if references is not None and digest != references[index]["sha256"]:
            raise ValueError("coding_parent_contract_changed")
        result.append({"run_id": item["run_id"], "sha256": digest, "content": content})
    return result


def observe_progress(task) -> dict:
    """Expose source and provider observations, never a fabricated percent."""
    from storage.project_changes import IGNORED
    from storage.usage_store import read_usage

    assignment = task.coding
    branch = project_path(assignment["branch_workspace"], assignment["project_dir"])
    files, size = 0, 0
    generated = assignment.get("generated_paths") or []
    for directory, dirs, names in os.walk(branch, followlinks=False):
        relative = os.path.relpath(directory, branch)
        dirs[:] = [name for name in dirs if name not in IGNORED and not any(
            (name if relative == "." else relative + "/" + name) == output
            for output in generated
        )]
        for name in names:
            path = Path(directory) / name
            try:
                if not path.is_symlink():
                    size += path.stat().st_size
                    files += 1
            except FileNotFoundError:
                continue
    usage = read_usage(assignment["branch_workspace"])
    return {"phase": assignment.get("phase"), "source_files": files, "source_bytes": size,
            "recorded_model_calls": len(usage),
            "last_model_response_at": usage[-1].get("created_at", "") if usage else "",
            "completion_status": (assignment.get("completion_validation") or {}).get("status", "pending")}


def check_implementation(task, cancel_check=None) -> dict:
    """Observe declared checks on current source through governed execution.

    Failed checks keep the same implementation loop open. This is a candidate
    readiness check; exact independent QA remains mandatory for publication.
    """
    from core.tools.context import ToolRuntimeContext
    from core.tools.integration import get_default_tool_runtime_client
    from storage.redaction import redact_value

    from .subagent import _save_task

    assignment = task.coding
    branch = project_path(assignment["branch_workspace"], assignment["project_dir"])
    baseline = source_manifest(branch, assignment.get("generated_paths"))
    digest = manifest_digest(baseline)
    cached = assignment.get("completion_validation") or {}
    if cached.get("status") == "unknown":
        # Source changes cannot reconcile an execution whose outcome is unknown.
        return cached
    if cached.get("source_digest") == digest and cached.get("status") == "passed":
        return cached
    evidence = []
    assignment["phase"] = "verifying"
    _save_task(task)
    status = "passed" if baseline else "failed"
    for command in assignment["validation_commands"]:
        if callable(cancel_check) and cancel_check():
            status = "unknown"
            break
        observed = get_default_tool_runtime_client().invoke(
            "exec.run", {"action": "shell", "command": command,
                         "working_dir": assignment["project_dir"], "timeout": 180},
            context=ToolRuntimeContext(
                workspace_id=assignment["branch_workspace"], session_id=task.subtask_id,
                task_id=task.parent_task_id, requested_by="subagent", cancel_check=cancel_check,
            ),
        )
        output = redact_value({**observed.output, "runtime_status": observed.status})
        evidence.append({"command": command, "result": output})
        if output.get("execution_outcome") == "unknown" or output.get("execution_may_continue"):
            status = "unknown"
            break
        if observed.status != "succeeded" or not output.get("ok", True) or output.get("exit_code") != 0:
            status = "failed"
    source_changed = source_manifest(branch, assignment.get("generated_paths")) != baseline
    if source_changed and status != "unknown":
        status = "failed"
    result = {"status": status, "source_digest": digest, "checks": evidence,
              "source_changed_during_checks": source_changed,
              "automatic_retry_allowed": status != "unknown"}
    assignment.update(phase="executing", completion_validation=result)
    _save_task(task)
    return result


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
        "revision_subtask_id": str(supplied.get("revision_subtask_id") or ""),
        "branch_workspace": "coding-" + uuid.uuid4().hex,
        "phase": "assigned",
        "parent_contract_refs": [{"run_id": item["run_id"], "sha256": item["sha256"]}
                                 for item in parent_contract(task)],
    }
    task.coding = assignment
    for subtask_id in dependencies:
        dependency = _related(task, subtask_id)
        if dependency.profile_id == "qa_agent":
            raise ValueError("coding_dependency_requires_implementation_candidate")
    if task.profile_id == "qa_agent":
        if assignment["revision_subtask_id"]:
            raise ValueError("coding_revision_requires_implementation_profile")
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
    elif assignment["revision_subtask_id"]:
        from .coding_revisions import configure_revision
        configure_revision(task)
    from core.tools.project_execution import environment_for
    parent_environment = environment_for(task.workspace_id)
    if parent_environment is not None:
        if parent_environment.project != project_path(task.workspace_id, project).resolve():
            raise ValueError("coding_parent_project_binding_mismatch")
        with quiescent_project(task.workspace_id):
            parent_environment.coordinate(assignment["generated_paths"])
            parent_environment.configure_validation(assignment["validation_commands"])
    return assignment


def ready(task) -> bool:
    assignment = task.coding
    dependencies = list(assignment.get("depends_on") or [])
    if task.profile_id == "qa_agent":
        dependencies = list(dict.fromkeys([*dependencies, assignment["review_subtask_id"]]))
    for subtask_id in dependencies:
        try:
            target = _related(task, subtask_id)
        except ValueError:
            task.status = "failed"
            assignment["phase"] = "dependency_failed"
            task.summary = "Coding dependency identity is unavailable"
            return False
        review_target = task.profile_id == "qa_agent" and subtask_id == assignment["review_subtask_id"]
        rejected_phase = target.coding.get("phase") in {"qa_rejected", "qa_incomplete", "qa_unknown"}
        if target.status in {"failed", "cancelled"} or (rejected_phase and not review_target) or target.coding.get("phase") == "qa_unknown":
            task.status = "failed"
            assignment["phase"] = "dependency_failed"
            task.summary = "Coding dependency did not complete successfully"
            return False
        # Review consumes a completed candidate. Publication consumes its QA;
        # requiring publication here creates an impossible dependency cycle.
        phase = "candidate" if task.profile_id == "qa_agent" and subtask_id == assignment["review_subtask_id"] else "publication"
        available = target.status == "succeeded" and (
            target.coding.get("phase") in {"changes_ready", "validated", "qa_rejected", "qa_incomplete"}
            if phase == "candidate" else target.coding.get("phase") == "integrated"
        )
        if not available:
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
    elif assignment.get("revision_subtask_id"):
        from .coding_revisions import seed_revision
        baseline = seed_revision(task, branch)
    else:
        with quiescent_project(task.workspace_id):
            source = project_path(task.workspace_id, assignment["project_dir"])
            baseline = source_manifest(source, assignment.get("generated_paths"))
            copy_sources(source, branch, baseline)
    assignment["baseline"] = baseline
    assignment["phase"] = "executing"
    _save_task(task)
    port = _free_preview_port()
    with isolated_project(branch_ws, branch, port,
                          source_mode="review" if task.profile_id == "qa_agent" else "implementation",
                          generated_paths=assignment.get("generated_paths")) as environment:
        environment.configure_validation(assignment["validation_commands"])
        if task.profile_id == "qa_agent":
            from .coding_reviews import record_qa_review

            def submit_review(session_id, review):
                if session_id != task.subtask_id:
                    raise ValueError("coding_review_identity_mismatch")
                return record_qa_review(task, review)

            environment.review_submit = submit_review
        assignment["environment"] = environment.descriptor()
        instruction = (
            task.goal
            + "\n\n[PARENT USER CONTRACT: CONTEXT FOR THIS DELEGATED PHASE]\n"
            + "Preserve the following complete user requirements and interface contracts. "
            "Work on the delegated phase above; a phase is not completion of the entire parent goal. "
            "Coordinator-only workflow instructions do not change this worker's role or permissions.\n"
            + json.dumps(parent_contract(task, assignment.get("parent_contract_refs", [])), ensure_ascii=False)
            + "\n\n[SERVER CODING ASSIGNMENT]\n"
            + json.dumps(
                {
                    "project_dir": assignment["project_dir"],
                    "responsibilities": assignment["responsibilities"],
                    "generated_paths": assignment.get("generated_paths", []),
                    "role": task.profile_id,
                    "preview_origin": f"http://127.0.0.1:{port}",
                    "preview_bind_port": environment.descriptor()["preview_bind_port"],
                    "validation_commands": assignment["validation_commands"],
                    "review_subtask_id": assignment["review_subtask_id"],
                    "initial_source_paths": sorted(source_manifest(branch, assignment.get("generated_paths"))),
                    "revision_observation": assignment.get("revision_observation"),
                    "tool_path_bases": environment.descriptor()["tool_path_bases"],
                    "constraints": "Work only in this isolated project branch. Upstream source dependencies are integrated; package caches are branch-local and may start empty. QA and coordinator may install declared dependencies through governed exec into writable node_modules/.venv without changing source or lockfiles; use npm ci when a lockfile exists. Bind preview to HOST/PORT from the process environment, never the browser origin port. Implementation owns writable source; QA and coordinator source mounts are read-only. Run assigned validation commands exactly from the project directory. Reviewed read-only projects use disposable build snapshots and only promote declared outputs; other commands retain their role's source mount mode. Logs/PID/temporary checks belong under /tmp. Source revisions require implementation and exact QA, then governed integration.",
                },
                ensure_ascii=False,
            )
        )
        if task.profile_id == "qa_agent":
            from .coding_reviews import review_instruction
            instruction += "\n\n" + review_instruction()
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


def cancel_execution(task) -> dict:
    """Close the server-owned branch binding without waiting for model I/O."""
    from core.tools.project_execution import environment_for
    from .subagent import _load_task, _save_task

    assignment = task.coding
    environment = environment_for(assignment["branch_workspace"])
    if environment is None:
        return {"cleanup_confirmed": False, "reason": "coding_binding_unavailable"}
    if environment.project != project_path(assignment["branch_workspace"], assignment["project_dir"]).resolve():
        raise ValueError("coding_cancel_binding_mismatch")
    environment.close()
    current = _load_task(task.workspace_id, task.subtask_id)
    current.coding["environment"] = environment.descriptor()
    _save_task(current)
    return {"cleanup_confirmed": environment.cleanup_confirmed}


def finish_assignment(task, environment, runtime_ok: bool, proposal: str = "") -> bool:
    from .subagent import _save_task

    assignment = task.coding
    branch = project_path(assignment["branch_workspace"], assignment["project_dir"])
    if not runtime_ok:
        if assignment.get("phase") not in {"qa_rejected", "qa_incomplete", "qa_unknown"}:
            assignment["phase"] = "failed"
        _save_task(task)
        return False
    if task.profile_id == "qa_agent":
        from .coding_reviews import review_qa_proposal
        review = review_qa_proposal(task, proposal)
        if review["status"] != "passed":
            return False
        evidence = assignment["validation"]
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
        from .subagent import _cancel_event
        from .subagent_control import cancellation_probe

        validation = check_implementation(task, cancellation_probe(
            task.workspace_id, task.subtask_id, _cancel_event(task.workspace_id, task.subtask_id)))
        if validation["status"] != "passed":
            raise ValueError("coding_implementation_validation_incomplete")
        # Stop all descendants before hashing the output. Detached generators
        # cannot mutate a candidate after it has been declared changes_ready.
        if not environment.close():
            raise RuntimeError("coding_candidate_processes_not_stopped")
        current = source_manifest(branch, assignment.get("generated_paths"))
        if manifest_digest(current) != validation["source_digest"]:
            raise ValueError("coding_candidate_changed_after_validation")
        assignment.update(
            change=changeset(
                assignment["baseline"], current, assignment["responsibilities"]
            ),
            candidate_digest=manifest_digest(current),
            phase="changes_ready",
        )
    _save_task(task)
    return True


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
    from .coding_reviews import accepted_review
    if not accepted_review(qa, assignment.get("qa_candidate_digest")):
        return {"ok": False, "error": "coding_qa_verdict_required",
                "phase": assignment.get("phase"), "automatic_retry_allowed": False}
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
