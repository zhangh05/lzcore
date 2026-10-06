"""One-time persisted assignment upgrade, separate from ordinary Task reads.

Existing Store records always win. Legacy observations are transferred before
removing their Task fields; migration never starts execution or replays writes.
"""
from agent.runtime.utils import now_iso
from storage import coding_state_store as store
from storage.locking import FileLock
from storage.records import atomic_save_json, workspace_record_file
from storage.subagent_store import list_subagents, read_subagent, task_control_lock

from .coding_assignment import execution_parameters
from . import coding_state as state


def migrate_workspace(workspace_id):
    from .subagent import SubagentTask
    from storage.project_changes import changeset, manifest_digest, project_path, quiescent_project, source_manifest

    with FileLock(workspace_record_file(workspace_id, "coding-state", "assignment-upgrade.lock")):
        legacy = {raw["subtask_id"]: raw for raw in list_subagents(workspace_id, 100000)
                  if raw.get("workspace_id") == workspace_id and raw.get("coding")
                  and raw["coding"].get("schema") != "coding.assignment.v2"}
        tasks = {identity: SubagentTask(**{key: value for key, value in raw.items()
                 if key in SubagentTask.__dataclass_fields__}) for identity, raw in legacy.items()}
        for task in tasks.values():
            assignment = task.coding
            if task.profile_id == "qa_agent" or state.candidate(task) or "baseline" not in assignment:
                continue
            if assignment.get("state_store_version") or assignment.get("candidate_id"):
                raise ValueError("coding_candidate_unavailable")
            with quiescent_project(assignment["branch_workspace"]):
                source = source_manifest(project_path(assignment["branch_workspace"], assignment["project_dir"]),
                                         assignment.get("generated_paths"))
                state.capture(task, source_digest=manifest_digest(source), baseline=assignment["baseline"],
                    change=changeset(assignment["baseline"], source, assignment["responsibilities"]),
                    validation=assignment.get("completion_validation") or {},
                    resources=assignment.get("environment") or {})
                store.change(workspace_id, "candidates", state.candidate_id(task.subtask_id),
                             lambda record: {**record, "legacy_import": True})
        for task in tasks.values():
            if task.profile_id != "qa_agent" or state.review(task):
                continue
            facts = task.coding
            if not any(facts.get(key) for key in ("qa_review", "qa_validation", "environment", "qa_invalid_proposal", "qa_final_report")):
                continue
            if facts.get("state_store_version") or facts.get("review_id"):
                raise ValueError("coding_review_unavailable")
            target = store.read(workspace_id, "candidates", state.candidate_id(facts.get("review_subtask_id", "")))
            if not target:
                raise ValueError("coding_legacy_review_candidate_unavailable")
            if target["session_id"] != task.session_id or target["parent_task_id"] != task.parent_task_id:
                raise ValueError("coding_legacy_review_identity_mismatch")
            binding = _review_binding(task, target)
            def attach(record):
                if binding["id"] not in record["review_ids"]:
                    record["review_ids"].append(binding["id"])
                    record["review_round"] = max(record["review_round"], binding["review_round"])
                    record["events"].append({"event_id": binding["id"] + ":imported", "event": "legacy_review_imported",
                        "state": record["state"], "evidence": {"record_id": binding["id"]}})
                    if record["state"] in state._REVIEWABLE:
                        record["state"] = state.CandidateState.REVIEWING.value
                return record
            store.change(workspace_id, "candidates", target["id"], attach)
            store.change(workspace_id, "reviews", binding["id"], lambda prior: prior or binding, session_id=task.session_id)
            state.reconcile_reviews(workspace_id, target["id"])
        for task in tasks.values():
            record = state.candidate(task)
            if record and record.get("legacy_import") and task.coding.get("phase") == "integrated" and record["state"] == state.CandidateState.ACCEPTED:
                from storage.project_changes import publication_record
                journal = publication_record(workspace_id, task.subtask_id)
                if (not journal or journal["phase"] != "integrated" or journal["project"] != record["project_dir"]
                        or journal["digest"] != record["change"]["digest"] or journal["files"] != record["change"]["files"]):
                    raise ValueError("coding_legacy_publication_identity_mismatch")
                state.transition(workspace_id, record["id"], "publication_started",
                    evidence={"event_id": record["id"] + ":legacy-publication", "record_id": task.subtask_id})
                state.transition(workspace_id, record["id"], "publication_integrated",
                    evidence={"event_id": record["id"] + ":legacy-integrated", "record_id": task.subtask_id})
                store.change(workspace_id, "candidates", record["id"],
                             lambda value: {**value, "publication": {"ok": True, **journal}, "legacy_import": True})
        for identity in tasks:
            with task_control_lock(workspace_id, identity):
                raw = read_subagent(workspace_id, identity)
                raw["coding"] = execution_parameters(raw["coding"])
                atomic_save_json(workspace_id, ("subagents", identity + ".json"), raw)
        return list(tasks)


def _review_binding(task, target):
    """Retain real legacy observations; typed evidence still decides acceptance."""
    from core.tools.executor import validate_schema_value
    from .coding_reviews import QA_REVIEW_SCHEMA

    facts = task.coding
    judgement = facts.get("qa_review")
    validation, resources = facts.get("qa_validation") or {}, facts.get("environment") or {}
    unknown = (task.status in {"created", "running"} or validation.get("status") == "unknown"
               or not resources.get("closed") or not resources.get("cleanup_confirmed"))
    valid = (judgement and not validate_schema_value("qa_review", judgement, QA_REVIEW_SCHEMA)
             and facts.get("review_candidate_digest") == target["source_digest"]
             and facts.get("review_digest") == target["change"]["digest"]
             and judgement.get("candidate_digest") == target["source_digest"]
             and judgement.get("review_subtask_id") == target["producer_task_id"])
    outcome = ("unknown" if unknown or not valid else "fail" if validation.get("status") == "failed"
               else judgement["verdict"] if validation.get("status") == "passed" else "unknown")
    baseline = dict(target["baseline"])
    for path, change in target["change"]["files"].items():
        if change["after"] is None:
            baseline.pop(path, None)
        else:
            baseline[path] = change["after"]
    return {"schema": "coding.review.v1", "id": state.review_id(task.subtask_id), "workspace_id": task.workspace_id,
        "session_id": task.session_id, "parent_task_id": task.parent_task_id, "reviewer_task_id": task.subtask_id,
        "candidate_id": target["id"], "candidate_digest": target["source_digest"], "change_digest": target["change"]["digest"],
        "branch_workspace": facts["branch_workspace"], "project_dir": target["project_dir"], "baseline": baseline,
        "validation_commands": target["validation_commands"], "generated_paths": target["generated_paths"],
        "kind": "qa", "review_round": max(1, target["review_round"]),
        "state": state.ReviewState.EXECUTION_UNKNOWN.value if unknown else state.ReviewState.COMPLETED.value,
        "outcome": outcome, "judgement": judgement, "validation": validation, "resources": resources,
        "final_report": facts.get("qa_final_report", ""), "invalid_proposal": facts.get("qa_invalid_proposal", ""),
        "created_at": task.created_at, "updated_at": now_iso(), "legacy_import": True}
