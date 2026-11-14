# agent/runtime/durable/delivery.py
"""Task audit reports built from durable task state and trajectory scoring."""

from __future__ import annotations

from agent.runtime.utils import now_iso


def _now():
    return now_iso()


def build_audit_report(task_id: str, ws_id: str) -> dict:
    """Build a comprehensive audit report from all runtime data."""
    report = {"task_id": task_id, "workspace_id": ws_id, "generated_at": _now()}
    try:
        from agent.runtime.durable.store import get_task
        from agent.runtime.durable.trajectory import build_trajectory, evaluate_trajectory
        task = get_task(ws_id, task_id)
        if task:
            report["task_metadata"] = {
                "session_id": task.session_id, "run_id": task.run_id,
                "user_goal": task.user_goal, "status": task.status,
                "created_at": task.created_at, "updated_at": task.updated_at,
            }
        else:
            report["task_metadata"] = {"status": "not_found"}
        traj = build_trajectory(task_id, ws_id)
        if traj:
            report["trajectory"] = {"score": evaluate_trajectory(traj.to_dict() if hasattr(traj,'to_dict') else {})}
    except Exception as e:
        report["error"] = f"Failed to build audit report: {str(e)[:200]}"
    return report


def export_audit_report_markdown(task_id: str, ws_id: str) -> str:
    report = build_audit_report(task_id, ws_id)
    meta = report.get("task_metadata", {})
    traj = report.get("trajectory", {})
    lines = [
        f"# Audit Report — {task_id[:8]}",
        f"Workspace: {ws_id}",
        f"Status: {meta.get('status','unknown')}",
        f"Goal: {meta.get('user_goal','')[:200]}",
        f"Created: {meta.get('created_at','')}",
        f"",
        f"## Trajectory Evaluation",
        f"Score: {traj.get('score',{}).get('score','N/A')}/10",
        "Issues:",
        *[f"- {issue['rule']}: {issue['detail']}" for issue in traj.get('score', {}).get('issues', [])],
        *(["none"] if not traj.get('score', {}).get('issues') else []),
        *([f"Error: {report['error']}"] if report.get('error') else []),
        f"",
        f"--- Generated {report['generated_at']}",
    ]
    return "\n".join(lines)
