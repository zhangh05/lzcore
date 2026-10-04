"""Independent integration checks from durable records and actual source hashes."""

from __future__ import annotations

from storage.project_changes import project_path, quiescent_project, source_manifest
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
        current = source_manifest(project_path(workspace_id, project_dir))
        for task in integrated:
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
            assert all(
                current.get(path) == change["after"]
                for path, change in assignment["change"]["files"].items()
            ), "parent source changed after exact-candidate QA"
            assert assignment["publication"]["phase"] == "integrated"
            evidence.append(
                {
                    "implementation": task["subtask_id"],
                    "qa": qa["subtask_id"],
                    "parent_task_id": task["parent_task_id"],
                    "change_digest": assignment["change"]["digest"],
                    "files": len(assignment["change"]["files"]),
                    "runtime_checks": len(checks),
                }
            )
    return {
        "schema": "coding.team_acceptance.v1",
        "status": "PASS",
        "integrations": evidence,
    }
