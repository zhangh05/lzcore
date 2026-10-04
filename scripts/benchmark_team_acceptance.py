"""Independent integration checks from durable records and actual source hashes."""

from __future__ import annotations

from storage.project_changes import project_path, publication_record, quiescent_project, source_manifest
from storage.subagent_store import list_subagents


def verify_team(workspace_id: str, session_id: str, project_dir: str) -> dict:
    tasks = {
        item["subtask_id"]: item
        for item in list_subagents(workspace_id, 1000)
        if item.get("workspace_id") == workspace_id
        and item.get("session_id") == session_id
    }
    integrated = [
        task
        for task in tasks.values()
        if task.get("coding", {}).get("phase") == "integrated"
        and task.get("profile_id") in {"coding_agent", "frontend_agent"}
        and task["coding"]["project_dir"] == project_dir
    ]
    assert integrated, (
        "no coding candidate was actually integrated; child success or a rebuilt parent is insufficient"
    )
    evidence = []
    with quiescent_project(workspace_id):
        publications = {}
        for task in integrated:
            record = publication_record(workspace_id, task["subtask_id"])
            assignment = task["coding"]
            assert assignment["publication"].get("ok") is True
            assert record == {key: value for key, value in assignment["publication"].items() if key != "ok"}, "publication evidence differs from durable journal"
            assert record["phase"] == "integrated" and record["project"] == project_dir
            assert record["digest"] == assignment["change"]["digest"] and record["files"] == assignment["change"]["files"]
            order = record.get("publication_order")
            assert type(order) is int and order > 0 and order not in publications, "invalid publication order"
            publications[order] = task
        heads = {}
        for order, task in sorted(publications.items()):
            assignment = task["coding"]
            assert task["parent_task_id"], "missing trusted parent task identity"
            qa = tasks.get(assignment["qa_subtask_id"])
            assert qa and qa["profile_id"] == "qa_agent" and qa["status"] == "succeeded"
            review = qa["coding"]
            assert (
                review["phase"] == "validated"
                and review["review_subtask_id"] == task["subtask_id"]
            )
            assert review["review_digest"] == assignment["change"]["digest"]
            assert qa["parent_task_id"] == task["parent_task_id"]
            checks = review.get("validation") or []
            assert len(checks) == len(assignment["validation_commands"]) > 0
            assert all(
                item["result"]["runtime_status"] == "succeeded"
                and item["result"]["exit_code"] == 0
                for item in checks
            )
            for path, change in assignment["change"]["files"].items():
                assert path not in heads or heads[path] == change["before"], "reviewed publication chain is broken"
                heads[path] = change["after"]
            evidence.append(
                {
                    "implementation": task["subtask_id"],
                    "qa": qa["subtask_id"],
                    "parent_task_id": task["parent_task_id"],
                    "change_digest": assignment["change"]["digest"],
                    "files": len(assignment["change"]["files"]),
                    "runtime_checks": len(checks),
                    "publication_order": order,
                }
            )
        current = source_manifest(project_path(workspace_id, project_dir))
        assert all(current.get(path) == expected for path, expected in heads.items()), "parent source changed after exact-candidate QA"
    return {
        "schema": "coding.team_acceptance.v1",
        "status": "PASS",
        "integrations": evidence,
    }
