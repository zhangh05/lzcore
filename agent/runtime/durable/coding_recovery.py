"""Explicit read-back of stopped candidate execution; never replays a call."""
from __future__ import annotations

from agent.runtime.utils import now_iso
from storage import coding_state_store as store


def resolved_unknown(candidate, review):
    recovery = candidate.get("execution_recovery") or {}
    return (recovery.get("source_digest") == candidate["source_digest"]
            and review["id"] in recovery.get("resolved_review_ids", []))


def stopped_resources(candidate, identity):
    recovery = candidate.get("execution_recovery") or {}
    if recovery.get("source_digest") != candidate["source_digest"]:
        return False
    return any(item["record_id"] == identity and item["resources"].get("cleanup_confirmed")
               and all(check["resources"].get("cleanup_confirmed") for check in item["checks"])
               for item in recovery.get("observations", []))


def reconcile_execution(task):
    from core.tools.project_execution import reconcile_environment
    from storage.project_changes import manifest_digest, project_path, quiescent_project, source_manifest
    from .coding_state import CandidateState, _TRANSITIONS, candidate, project_task, review
    from .subagent import _load_task, _save_task

    binding = review(task) if task.profile_id == "qa_agent" else candidate(task)
    if not binding:
        raise ValueError("coding_execution_record_unavailable")
    identity = binding["candidate_id"] if task.profile_id == "qa_agent" else binding["id"]
    with store.publication_lock(task.workspace_id, identity):
        record = store.read(task.workspace_id, "candidates", identity)
        if record["state"] != CandidateState.EXECUTION_UNKNOWN:
            return {"ok": True, "reconciled": False, "candidate_id": identity, "state": record["state"]}
        records = [record, *[store.read(task.workspace_id, "reviews", value) for value in record["review_ids"]]]
        observations = []
        for item in records:
            if not item:
                raise ValueError("coding_execution_record_unavailable")
            worker_id = item.get("reviewer_task_id") or item["producer_task_id"]
            worker = _load_task(task.workspace_id, worker_id)
            if (not worker or worker.parent_task_id != record["parent_task_id"]
                    or worker.session_id != record["session_id"] or worker.status in {"created", "running"}
                    or item.get("state") == "running"):
                raise ValueError("coding_execution_worker_not_stopped")
            observed = {"record_id": item["id"], "resources": reconcile_environment(item["resources"]), "checks": []}
            for index, check in enumerate(item["validation"].get("checks") or []):
                environment = check.get("result", {}).get("validation_environment")
                if environment:
                    observed["checks"].append({"index": index, "resources": reconcile_environment(environment)})
            observations.append(observed)
        with quiescent_project(record["branch_workspace"]):
            source = source_manifest(project_path(record["branch_workspace"], record["project_dir"]), record["generated_paths"])
            if manifest_digest(source) != record["source_digest"]:
                raise ValueError("coding_execution_candidate_changed")
            recovery = {"source_digest": record["source_digest"], "observed_at": now_iso(),
                "review_round": record["review_round"], "observations": observations,
                "resolved_review_ids": [item["id"] for item in records[1:] if item["state"] == "execution_unknown"]}
            def update(current):
                current["state"] = _TRANSITIONS["execution_reconciled"][CandidateState(current["state"])].value
                current.update(execution_recovery=recovery, accepted_reviews={}, updated_at=now_iso())
                current["events"].append({"event_id": f'{identity}:reconcile:{record["revision"]}',
                    "event": "execution_reconciled", "state": current["state"], "evidence": recovery})
                return current
            result = store.change(task.workspace_id, "candidates", identity, update, expected_revision=record["revision"])
        producer = _load_task(task.workspace_id, record["producer_task_id"])
        _save_task(project_task(producer))
        return {"ok": True, "reconciled": True, "candidate_id": identity, "state": result["state"],
                "requires_new_review": True, "automatic_retry_allowed": False, "evidence": recovery}
