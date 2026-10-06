"""Independent integration checks from durable records and actual source hashes."""

from __future__ import annotations

from storage.project_changes import manifest_digest, project_path, publication_record, quiescent_project, source_manifest
from storage.subagent_store import list_subagents
from storage.coding_state_store import list_records, read


def verify_team(workspace_id: str, session_id: str, project_dir: str) -> dict:
    tasks = {item["subtask_id"]: item for item in list_subagents(workspace_id, 5000)
             if item.get("workspace_id") == workspace_id and item.get("session_id") == session_id}
    integrated = []
    for candidate in list_records(workspace_id, "candidates"):
        if (candidate.get("workspace_id") != workspace_id or candidate.get("session_id") != session_id
                or candidate.get("project_dir") != project_dir or candidate.get("state") != "integrated"):
            continue
        producer = tasks.get(candidate["producer_task_id"])
        assert producer and producer.get("profile_id") in {"coding_agent", "frontend_agent"}
        assert producer["parent_task_id"] == candidate["parent_task_id"]
        recovery = candidate.get("execution_recovery")
        if recovery:
            _verify_execution_recovery(candidate, tasks)
        else:
            assert candidate["resources"].get("closed") and candidate["resources"].get("cleanup_confirmed")
            completed = candidate["validation"]
            assert completed.get("status") == "passed" and completed.get("source_digest") == candidate["source_digest"]
        for identity in candidate["review_ids"]:
            previous = read(workspace_id, "reviews", identity)
            assert previous and previous["candidate_id"] == candidate["id"]
            assert previous["state"] != "running"
            if previous["state"] == "execution_unknown":
                assert recovery and identity in recovery["resolved_review_ids"]
        source = source_manifest(project_path(candidate["branch_workspace"], project_dir), candidate["generated_paths"])
        assert source and manifest_digest(source) == candidate["source_digest"]
        accepted = candidate.get("accepted_reviews") or {}
        assert set(candidate["required_review_kinds"]) <= set(accepted), "independent QA verdict is missing"
        for kind, identities in accepted.items():
            assert identities, "independent QA verdict list is empty"
            for identity in identities:
                _verify_review(read(workspace_id, "reviews", identity), candidate, tasks, kind)
        integrated.append(candidate)
    assert integrated, "no coding candidate was actually integrated; child success or a rebuilt parent is insufficient"
    evidence = []
    with quiescent_project(workspace_id):
        publications = {}
        for candidate in integrated:
            record = publication_record(workspace_id, candidate["producer_task_id"])
            assert candidate["publication"].get("ok") is True
            assert record == {key: value for key, value in candidate["publication"].items()
                              if key not in {"ok", "automatic_retry_allowed"}}, "publication evidence differs from durable journal"
            assert record["phase"] == "integrated" and record["project"] == project_dir
            assert record["digest"] == candidate["change"]["digest"] and record["files"] == candidate["change"]["files"]
            order = record.get("publication_order")
            assert type(order) is int and order > 0 and order not in publications, "invalid publication order"
            publications[order] = candidate
        # Reconstruct all reviewed source, including unchanged files and
        # absence. Never infer integration or review from worker Task fields.
        heads = dict(publications[min(publications)]["baseline"])
        for order, candidate in sorted(publications.items()):
            assert candidate["parent_task_id"], "missing trusted parent task identity"
            for path, change in candidate["change"]["files"].items():
                assert heads.get(path) == change["before"], "reviewed publication chain is broken"
                if change["after"] is None:
                    heads.pop(path, None)
                else:
                    heads[path] = change["after"]
            qa = read(workspace_id, "reviews", candidate["accepted_reviews"]["qa"][-1])
            evidence.append({"implementation": candidate["producer_task_id"], "qa": qa["reviewer_task_id"],
                "review_ids": [identity for group in candidate["accepted_reviews"].values() for identity in group],
                "parent_task_id": candidate["parent_task_id"], "change_digest": candidate["change"]["digest"],
                "files": len(candidate["change"]["files"]), "runtime_checks": len(qa["validation"]["checks"]),
                "publication_order": order})
        current = source_manifest(project_path(workspace_id, project_dir), candidate["generated_paths"])
        assert current == heads, "parent source changed after exact-candidate QA"
    return {"schema": "coding.team_acceptance.v1", "status": "PASS", "integrations": evidence}


def _verify_review(review, candidate, tasks, kind):
    message = 'independent QA verdict is missing, failed or not bound to this candidate'
    assert review and review.get('schema') == 'coding.review.v1', message
    assert (review['candidate_id'] == candidate['id'] and review['candidate_digest'] == candidate['source_digest']
            and review['kind'] == kind and review['review_round'] == candidate['review_round']
            and review['state'] == 'completed' and review.get('outcome') == 'pass'
            and review['session_id'] == candidate['session_id']
            and review['parent_task_id'] == candidate['parent_task_id']
            and review['change_digest'] == candidate['change']['digest']), message
    recovery = candidate.get('execution_recovery')
    if recovery:
        assert review['review_round'] > recovery['review_round'], 'reconciled execution requires new QA'
    worker = tasks.get(review['reviewer_task_id'])
    assert worker and worker['profile_id'] == 'qa_agent' and worker['parent_task_id'] == candidate['parent_task_id'], message
    judgement = review.get('judgement') or {}
    assert (judgement.get('schema') == 'coding.qa_review.v1' and judgement.get('verdict') == 'pass'
            and judgement.get('blocking_findings') == []
            and judgement.get('candidate_digest') == candidate['source_digest']
            and judgement.get('review_subtask_id') == candidate['producer_task_id']
            and isinstance(judgement.get('scope'), str) and judgement['scope'].strip()
            and isinstance(judgement.get('report'), str) and judgement['report'].strip()), message
    validation = review['validation']
    assert validation.get('status') == 'passed' and validation.get('source_digest') == candidate['source_digest'], message
    checks = validation.get('checks') or []
    assert [item['command'] for item in checks] == candidate['validation_commands'], message
    assert all(item['result'].get('runtime_status') == 'succeeded' and item['result'].get('exit_code') == 0
               and item['result'].get('execution_outcome') != 'unknown'
               and not item['result'].get('execution_may_continue') for item in checks), message
    assert review['resources'].get('closed') and review['resources'].get('cleanup_confirmed'), message


def _verify_execution_recovery(candidate, tasks):
    """Verify stored read-back independently; unknown checks are never PASS."""
    recovery = candidate['execution_recovery']
    assert recovery['source_digest'] == candidate['source_digest']
    originals = [candidate, *[read(candidate['workspace_id'], 'reviews', identity)
                              for identity in candidate['review_ids']
                              if identity in recovery['resolved_review_ids']]]
    observations = {item['record_id']: item for item in recovery['observations']}
    for original in originals:
        assert original
        identity = original.get('reviewer_task_id') or original['producer_task_id']
        assert tasks[identity]['status'] not in {'created', 'running'}
        observation = observations[original['id']]
        _verify_resource_readback(original['resources'], observation['resources'])
        checked = {item['index']: item['resources'] for item in observation['checks']}
        for index, check in enumerate(original['validation'].get('checks') or []):
            descriptor = check.get('result', {}).get('validation_environment')
            if descriptor:
                _verify_resource_readback(descriptor, checked[index])


def _verify_resource_readback(original, observed):
    assert observed.get('closed') and observed.get('cleanup_confirmed')
    if observed.get('observed_via') == 'recorded_cleanup':
        assert original.get('closed') and original.get('cleanup_confirmed')
    else:
        assert observed.get('observed_via') == 'docker_readback'
        assert observed['runtime_resources'] == original['runtime_resources']
        assert observed['daemon_id'] and observed['daemon_id'] == original['daemon_id']
