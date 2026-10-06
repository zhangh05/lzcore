"""Candidate and Review contracts, independent of worker Task status.

Only observed source/check/review/publication facts move these state machines.
There are no model cadence, response-format or source-difference rules here.
"""
from __future__ import annotations

from enum import StrEnum

from agent.runtime.utils import now_iso
from storage import coding_state_store as store


class CandidateState(StrEnum):
    BUILDING = "building"
    READY = "ready"
    VALIDATION_FAILED = "validation_failed"
    REVIEWING = "under_review"
    ACCEPTED = "accepted"
    REJECTED = "review_rejected"
    INCOMPLETE = "review_incomplete"
    EXECUTION_UNKNOWN = "execution_unknown"
    PUBLISHING = "publishing"
    INTEGRATED = "integrated"
    CONFLICT = "conflict"
    PUBLICATION_UNKNOWN = "publication_unknown"


class ReviewState(StrEnum):
    RUNNING = "running"
    COMPLETED = "completed"
    INTERRUPTED = "interrupted"
    EXECUTION_UNKNOWN = "execution_unknown"


_REVIEWABLE = frozenset({CandidateState.READY, CandidateState.REVIEWING,
                       CandidateState.ACCEPTED, CandidateState.REJECTED,
                       CandidateState.INCOMPLETE})
_TRANSITIONS = {
    "execution_reconciled": {CandidateState.EXECUTION_UNKNOWN: CandidateState.INCOMPLETE},
    "review_started": {value: CandidateState.REVIEWING for value in _REVIEWABLE},
    "review_accepted": {CandidateState.REVIEWING: CandidateState.ACCEPTED},
    "review_rejected": {CandidateState.REVIEWING: CandidateState.REJECTED},
    "review_incomplete": {CandidateState.REVIEWING: CandidateState.INCOMPLETE},
    "review_execution_unknown": {CandidateState.REVIEWING: CandidateState.EXECUTION_UNKNOWN},
    "publication_started": {CandidateState.ACCEPTED: CandidateState.PUBLISHING,
                            CandidateState.CONFLICT: CandidateState.PUBLISHING},
    "publication_integrated": {CandidateState.PUBLISHING: CandidateState.INTEGRATED},
    "publication_conflict": {CandidateState.PUBLISHING: CandidateState.CONFLICT},
    "publication_unknown": {CandidateState.PUBLISHING: CandidateState.PUBLICATION_UNKNOWN},
    "publication_rolled_back": {CandidateState.PUBLISHING: CandidateState.CONFLICT},
    # This event must come from publication journal read-back, never a replay.
    "publication_reconciled": {CandidateState.PUBLICATION_UNKNOWN: CandidateState.INTEGRATED,
                               CandidateState.PUBLISHING: CandidateState.INTEGRATED},
    "publication_not_applied": {CandidateState.PUBLICATION_UNKNOWN: CandidateState.CONFLICT,
                                CandidateState.PUBLISHING: CandidateState.CONFLICT},
}


def candidate_id(subtask_id):
    return "cand-" + subtask_id


def review_id(subtask_id):
    return "review-" + subtask_id


def candidate(task):
    return store.read(task.workspace_id, "candidates", candidate_id(task.subtask_id))


def review(task):
    return store.read(task.workspace_id, "reviews", review_id(task.subtask_id))


def transition(workspace_id, identity, event, *, evidence, expected_revision=None):
    """One explicit, evidence-referenced lifecycle change under revision CAS."""
    def update(record):
        if not record or record.get("schema") != "coding.candidate.v1":
            raise ValueError("coding_candidate_unavailable")
        if any(item["event_id"] == evidence["event_id"] for item in record["events"]):
            prior = next(item for item in record["events"] if item["event_id"] == evidence["event_id"])
            if prior["event"] != event or prior["evidence"] != evidence:
                raise ValueError("coding_candidate_event_identity_conflict")
            return record
        target = _TRANSITIONS.get(event, {}).get(CandidateState(record["state"]))
        if target is None:
            raise ValueError("invalid_candidate_transition")
        if not evidence.get("event_id") or not evidence.get("record_id"):
            raise ValueError("coding_candidate_transition_requires_evidence")
        record["state"] = target.value
        record["updated_at"] = now_iso()
        record["events"].append({"event_id": evidence["event_id"], "event": event,
                                 "state": target.value, "evidence": evidence})
        return record
    return store.change(workspace_id, "candidates", identity, update,
                        expected_revision=expected_revision)


def capture(task, *, source_digest, baseline, change, validation, resources):
    """Seal one producer output. Subsequent revisions create a new identity."""
    assignment = task.coding
    identity = candidate_id(task.subtask_id)
    state = (CandidateState.EXECUTION_UNKNOWN if validation.get("status") == "unknown"
             or not resources.get("closed") or not resources.get("cleanup_confirmed")
             else CandidateState.READY if validation.get("status") == "passed"
             and validation.get("source_digest") == source_digest else CandidateState.VALIDATION_FAILED)
    immutable = {
        "schema": "coding.candidate.v1", "id": identity,
        "workspace_id": task.workspace_id, "session_id": task.session_id,
        "parent_task_id": task.parent_task_id, "producer_task_id": task.subtask_id,
        "project_dir": assignment["project_dir"], "branch_workspace": assignment["branch_workspace"],
        "source_digest": source_digest, "baseline": baseline, "change": change,
        "validation": validation, "resources": resources,
        "responsibilities": list(assignment["responsibilities"]),
        "generated_paths": list(assignment.get("generated_paths", [])),
        "validation_commands": list(assignment["validation_commands"]),
        "revision_of": candidate_id(assignment["revision_subtask_id"]) if assignment.get("revision_subtask_id") else "",
        "required_review_kinds": ["qa"],
    }
    from core.runtime_engine.failure_attribution import coding_checks
    immutable["failure_attributions"] = coding_checks(validation, resources, reference=identity)
    def update(previous):
        if previous and previous["state"] == CandidateState.BUILDING:
            return {**previous, **immutable, "state": state.value, "updated_at": now_iso()}
        if previous:
            if any(previous.get(key) != value for key, value in immutable.items()):
                raise ValueError("coding_candidate_snapshot_is_immutable")
            return previous
        return {**immutable, "state": state.value, "review_ids": [], "review_round": 0, "events": [],
                "created_at": now_iso(), "updated_at": now_iso()}
    return store.change(task.workspace_id, "candidates", identity, update, session_id=task.session_id)


def start_review(task, target, *, baseline, resources):
    """Bind a review attempt to an immutable candidate; never to Task success."""
    if target["state"] not in _REVIEWABLE:
        raise ValueError("coding_candidate_not_reviewable")
    identity = review_id(task.subtask_id)
    record = {
        "schema": "coding.review.v1", "id": identity, "workspace_id": task.workspace_id,
        "session_id": task.session_id, "parent_task_id": task.parent_task_id,
        "reviewer_task_id": task.subtask_id, "candidate_id": target["id"],
        "candidate_digest": target["source_digest"], "change_digest": target["change"]["digest"],
        "branch_workspace": task.coding["branch_workspace"], "project_dir": target["project_dir"],
        "baseline": baseline, "validation_commands": target["validation_commands"],
        "generated_paths": target["generated_paths"],
        "kind": "qa", "state": ReviewState.RUNNING.value, "judgement": None,
        "validation": {}, "resources": resources, "created_at": now_iso(), "updated_at": now_iso(),
    }
    def create(previous):
        if previous:
            raise ValueError("coding_review_already_started")
        return record
    with store.publication_lock(task.workspace_id, target["id"]):
        recover_review_links(task.workspace_id, target["id"])
        def attach(current):
            state = _TRANSITIONS["review_started"].get(CandidateState(current["state"]))
            if state is None or identity in current["review_ids"]:
                raise ValueError("coding_candidate_not_reviewable")
            if current["state"] != CandidateState.REVIEWING:
                current["review_round"] = int(current.get("review_round", 0)) + 1
            record["review_round"] = current["review_round"]
            current["state"] = state.value
            current["review_ids"].append(identity)
            current["events"].append({"event_id": identity + ":started", "event": "review_started",
                                      "state": state.value, "evidence": {"record_id": identity, "binding": dict(record)}})
            return current
        # Register the required evidence reference first. If persistence fails,
        # publication sees a missing review instead of silently using an older
        # approval. No read or retry starts the reviewer or executes a tool.
        store.change(task.workspace_id, "candidates", target["id"], attach)
        return store.change(task.workspace_id, "reviews", identity, create, session_id=task.session_id)


def recover_review_links(workspace_id, identity):
    """Repair interrupted metadata creation using stopped worker facts only."""
    from .subagent import _load_task
    target = store.read(workspace_id, "candidates", identity)
    recovered = False
    for reference in target["review_ids"]:
        if store.read(workspace_id, "reviews", reference):
            continue
        worker = _load_task(workspace_id, reference.removeprefix("review-"))
        if (not worker or worker.profile_id != "qa_agent" or worker.status in {"created", "running"}
                or worker.parent_task_id != target["parent_task_id"] or worker.session_id != target["session_id"]
                or worker.coding.get("review_subtask_id") != target["producer_task_id"]):
            raise ValueError("coding_review_binding_recovery_unavailable")
        binding = next((event["evidence"]["binding"] for event in target["events"]
                        if event["event"] == "review_started" and event["evidence"].get("record_id") == reference
                        and event["evidence"].get("binding")), None)
        if not binding:
            raise ValueError("coding_review_binding_recovery_unavailable")
        resources = next((event["evidence"]["resources"] for event in reversed(target["events"])
                          if event["event"] == "review_creation_cleanup"
                          and event["evidence"].get("record_id") == reference), binding["resources"])
        from core.tools.project_execution import reconcile_environment
        observed = reconcile_environment(resources)
        if not observed["cleanup_confirmed"]:
            raise ValueError("coding_review_binding_cleanup_unconfirmed")
        # Creation intent supplies identity only; absent checks/judgement stay absent.
        restored = {**binding, "state": ReviewState.INTERRUPTED.value, "outcome": "unknown",
                    "judgement": None, "validation": {}, "resources": resources,
                    "recovery_observation": observed, "final_report": "",
                    "recovery_reason": "review_binding_interrupted", "updated_at": now_iso()}
        store.change(workspace_id, "reviews", reference, lambda previous: previous or restored,
                     session_id=target["session_id"])
        recovered = True
    if recovered:
        reconcile_reviews(workspace_id, identity)


def record_judgement(task, judgement):
    """A reviewer report belongs to Review, without changing the producer Task."""
    def update(record):
        if not record or record["state"] != ReviewState.RUNNING:
            raise ValueError("coding_review_not_running")
        record["judgement"] = judgement
        record["updated_at"] = now_iso()
        return record
    return store.change(task.workspace_id, "reviews", review_id(task.subtask_id), update)


def record_review_report(task, report, *, invalid=False):
    def update(record):
        if not record or record["state"] != ReviewState.RUNNING:
            raise ValueError("coding_review_not_running")
        record.update(final_report=report, updated_at=now_iso())
        if invalid:
            record["invalid_proposal"] = report
        return record
    return store.change(task.workspace_id, "reviews", review_id(task.subtask_id), update)


def record_review_validation(task, validation):
    def update(record):
        if not record or record["state"] != ReviewState.RUNNING:
            raise ValueError("coding_review_not_running")
        if record["validation"].get("status") == "unknown":
            return record
        record.update(validation=validation, updated_at=now_iso())
        return record
    return store.change(task.workspace_id, "reviews", review_id(task.subtask_id), update)


def finish_review(task, *, resources, interrupted=False):
    """Close evidence collection independently of the reviewer's Task outcome."""
    def update(record):
        if not record:
            raise ValueError("coding_review_unavailable")
        if record["state"] != ReviewState.RUNNING:
            return record
        observed = record["validation"]
        report = record.get("final_report", "")
        unknown = (observed.get("status") == "unknown" or not resources.get("closed")
                   or not resources.get("cleanup_confirmed"))
        verdict = (record.get("judgement") or {}).get("verdict", "unknown")
        if unknown or interrupted:
            verdict = "unknown"
        elif observed.get("status") == "failed":
            verdict = "fail"
        elif observed.get("status") != "passed" and verdict == "pass":
            verdict = "unknown"
        record.update(state=(ReviewState.EXECUTION_UNKNOWN.value if unknown else
                             ReviewState.INTERRUPTED.value if interrupted else ReviewState.COMPLETED.value),
                      outcome=verdict, validation=observed, resources=resources,
                      final_report=report, updated_at=now_iso())
        from core.runtime_engine.failure_attribution import coding_checks, observation
        record["failure_attributions"] = coding_checks(observed, resources, reference=record["id"])
        if verdict == "fail":
            record["failure_attributions"].append(observation("coding_review_rejected", stage="review", reference=record["id"]))
        elif interrupted:
            record["failure_attributions"].append(observation("coding_review_interrupted", stage="review", reference=record["id"]))
        return record
    result = store.change(task.workspace_id, "reviews", review_id(task.subtask_id), update)
    reconcile_reviews(task.workspace_id, result["candidate_id"])
    return result


def reconcile_reviews(workspace_id, identity):
    """Derive acceptance from current review records, preserving every attempt."""
    def update(record):
        if record["state"] not in _REVIEWABLE:
            return record
        reviews = [store.read(workspace_id, "reviews", value) for value in record["review_ids"]]
        if any(not item for item in reviews):
            raise ValueError("coding_candidate_review_unavailable")
        if any(item["candidate_id"] != identity or item["candidate_digest"] != record["source_digest"]
               or item["change_digest"] != record["change"]["digest"] for item in reviews):
            raise ValueError("coding_candidate_review_identity_mismatch")
        # Concurrent reviewers are peers: one PASS cannot erase another's
        # blocking finding. A subsequent explicit reassessment starts a new
        # review round while retaining every previous report.
        current = [item for item in reviews if item["review_round"] == record["review_round"]]
        accepted = {}
        from .coding_recovery import resolved_unknown
        if any(item["state"] == ReviewState.EXECUTION_UNKNOWN and not resolved_unknown(record, item) for item in reviews):
            state = CandidateState.EXECUTION_UNKNOWN
        elif any(item["state"] == ReviewState.RUNNING for item in reviews):
            state = CandidateState.REVIEWING
        elif any(item.get("outcome") == "fail" for item in current):
            state = CandidateState.REJECTED
        elif (not set(record["required_review_kinds"]) <= {item["kind"] for item in current}
              or any(item.get("outcome") != "pass" for item in current)):
            state = CandidateState.INCOMPLETE
        else:
            for item in current:
                if not _accepted_review_item(record, item):
                    raise ValueError("coding_candidate_acceptance_evidence_incomplete")
                accepted.setdefault(item["kind"], []).append(item["id"])
            state = CandidateState.ACCEPTED
        if state != record["state"]:
            event = {CandidateState.ACCEPTED: "review_accepted", CandidateState.REJECTED: "review_rejected",
                     CandidateState.INCOMPLETE: "review_incomplete", CandidateState.EXECUTION_UNKNOWN: "review_execution_unknown"}.get(state)
            if state != CandidateState.REVIEWING and _TRANSITIONS[event].get(CandidateState(record["state"])) != state:
                raise ValueError("invalid_candidate_transition")
            record["events"].append({"event_id": "reviews:" + ":".join(f'{item["id"]}@{item["revision"]}' for item in reviews),
                                     "event": event, "state": state.value,
                                     "evidence": {"record_ids": record["review_ids"]}})
            record["state"] = state.value
        record.update(accepted_reviews=accepted, updated_at=now_iso())
        return record
    return store.change(workspace_id, "candidates", identity, update)


def accepted_reviews(record):
    """Recheck review evidence, independent of presentation and Task status."""
    from .coding_recovery import resolved_unknown
    result = {}
    for identity in record["review_ids"]:
        item = store.read(record["workspace_id"], "reviews", identity)
        if (not item or item["candidate_id"] != record["id"]
                or item["state"] == ReviewState.RUNNING
                or item["state"] == ReviewState.EXECUTION_UNKNOWN and not resolved_unknown(record, item)):
            return {}
    for kind in record["required_review_kinds"]:
        identities = record.get("accepted_reviews", {}).get(kind) or []
        if not identities:
            return {}
        result[kind] = []
        for identity in identities:
            item = store.read(record["workspace_id"], "reviews", identity)
            if not _accepted_review_item(record, item):
                return {}
            result[kind].append(item)
    return result


def _accepted_review_item(record, item):
    from core.tools.executor import validate_schema_value
    from .coding_reviews import QA_REVIEW_SCHEMA
    judgement = (item or {}).get("judgement") or {}
    validation = (item or {}).get("validation") or {}
    checks = validation.get("checks") or []
    recovery = record.get("execution_recovery") or {}
    if (not item or recovery and item["review_round"] <= recovery["review_round"]
            or item["state"] != ReviewState.COMPLETED or item.get("outcome") != "pass"
            or item["candidate_id"] != record["id"] or item["candidate_digest"] != record["source_digest"]
            or item["parent_task_id"] != record["parent_task_id"] or item["session_id"] != record["session_id"]
            or item["change_digest"] != record["change"]["digest"]
            or validate_schema_value("qa_review", judgement, QA_REVIEW_SCHEMA)
            or judgement.get("verdict") != "pass" or judgement.get("blocking_findings") != []
            or judgement.get("candidate_digest") != record["source_digest"]
            or judgement.get("review_subtask_id") != record["producer_task_id"]
            or not judgement.get("scope", "").strip() or not judgement.get("report", "").strip()
            or validation.get("status") != "passed" or validation.get("source_digest") != record["source_digest"]
            or [check.get("command") for check in checks] != record["validation_commands"]
            or any(check.get("result", {}).get("runtime_status") != "succeeded"
                   or check.get("result", {}).get("exit_code") != 0
                   or check.get("result", {}).get("execution_outcome") == "unknown"
                   or check.get("result", {}).get("execution_may_continue") for check in checks)
            or not item["resources"].get("closed") or not item["resources"].get("cleanup_confirmed")):
        return False
    return True


def revision_source(record):
    """A known immutable source may be copied; copying grants no acceptance."""
    from .coding_recovery import resolved_unknown, stopped_resources
    recovered = bool(record and stopped_resources(record, record["id"]))
    known = bool(record and record["state"] in {
        CandidateState.READY, CandidateState.ACCEPTED, CandidateState.REJECTED,
        CandidateState.INCOMPLETE, CandidateState.VALIDATION_FAILED,
    } and (recovered or record["resources"].get("closed") and record["resources"].get("cleanup_confirmed")
        and record["validation"].get("status") != "unknown"))
    if not known:
        return False
    for identity in record["review_ids"]:
        item = store.read(record["workspace_id"], "reviews", identity)
        if (not item or item["candidate_id"] != record["id"]
                or item["candidate_digest"] != record["source_digest"]
                or item["parent_task_id"] != record["parent_task_id"] or item["session_id"] != record["session_id"]
                or item["state"] == ReviewState.RUNNING
                or (not resolved_unknown(record, item) and (item["state"] == ReviewState.EXECUTION_UNKNOWN
                    or item["validation"].get("status") == "unknown"
                    or not item["resources"].get("closed") or not item["resources"].get("cleanup_confirmed")))):
            return False
    return True


def begin_candidate(task, *, baseline, resources):
    """Persist live check facts in Candidate before its immutable source seal."""
    from storage.project_changes import changeset
    assignment = task.coding
    identity = candidate_id(task.subtask_id)
    def create(previous):
        if previous:
            raise ValueError("coding_candidate_already_started")
        return {"schema": "coding.candidate.v1", "id": identity,
            "workspace_id": task.workspace_id, "session_id": task.session_id,
            "parent_task_id": task.parent_task_id, "producer_task_id": task.subtask_id,
            "project_dir": assignment["project_dir"], "branch_workspace": assignment["branch_workspace"],
            "source_digest": "", "baseline": baseline,
            "change": changeset(baseline, baseline, assignment["responsibilities"]),
            "validation": {}, "resources": resources,
            "responsibilities": assignment["responsibilities"], "generated_paths": assignment["generated_paths"],
            "validation_commands": assignment["validation_commands"],
            "revision_of": candidate_id(assignment["revision_subtask_id"]) if assignment.get("revision_subtask_id") else "",
            "required_review_kinds": ["qa"], "failure_attributions": [],
            "state": CandidateState.BUILDING.value, "review_ids": [], "review_round": 0, "events": [],
            "created_at": now_iso(), "updated_at": now_iso()}
    return store.change(task.workspace_id, "candidates", identity, create, session_id=task.session_id)


def record_candidate_validation(task, validation):
    def update(record):
        if not record or record["state"] != CandidateState.BUILDING:
            raise ValueError("coding_candidate_not_building")
        if record["validation"].get("status") == "unknown":
            return record
        record.update(validation=validation, source_digest=validation["source_digest"], updated_at=now_iso())
        return record
    return store.change(task.workspace_id, "candidates", candidate_id(task.subtask_id), update)


def record_resources(task, resources):
    kind, identity = ("reviews", review_id(task.subtask_id)) if task.profile_id == "qa_agent" else ("candidates", candidate_id(task.subtask_id))
    def update(record):
        if not record or record["state"] not in {CandidateState.BUILDING, ReviewState.RUNNING}:
            return record
        record.update(resources=resources, updated_at=now_iso())
        return record
    if store.read(task.workspace_id, kind, identity):
        return store.change(task.workspace_id, kind, identity, update)
    return None


def record_review_creation_cleanup(task, resources):
    """Persist cleanup after a failed second write of the review creation intent."""
    identity = candidate_id(task.coding["review_subtask_id"])
    reference = review_id(task.subtask_id)
    def update(record):
        if reference not in record["review_ids"]:
            return record
        record["events"].append({"event_id": reference + ":creation-cleanup",
            "event": "review_creation_cleanup", "state": record["state"],
            "evidence": {"record_id": reference, "resources": resources}})
        return record
    return store.change(task.workspace_id, "candidates", identity, update)
