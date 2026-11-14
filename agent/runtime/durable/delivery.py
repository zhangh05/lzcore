# agent/runtime/durable/delivery.py
"""Phase 12: Delivery / GitOps / Change Closure.

Delivery modes: code, diagnosis, report, data_processing, artifact_generation.
Validation gates enforce: no unvalidated success, no destructive without rollback, no git auto-commit.
"""

from __future__ import annotations
import logging
import uuid
import os
import re
from dataclasses import dataclass, field, asdict
from pathlib import Path
from core.tools.redaction import redact_string, redact_tool_output

logger = logging.getLogger(__name__)


def _git_subprocess_env() -> dict[str, str]:
    """Use the MCP allowlist, plus Git identity/config and SSH agent access."""
    from core.tools.mcp_client import _subprocess_env

    env = _subprocess_env(None)
    for name, value in os.environ.items():
        upper = name.upper()
        if (upper == "SSH_AUTH_SOCK" or upper.startswith("GIT_")) and not any(
            part in upper for part in ("KEY", "TOKEN", "SECRET", "PASSWORD")
        ):
            env[name] = value
    return env


def _resolve_repo_dir(ws_id: str) -> str:
    """Resolve a principal-scoped workspace that is itself a Git repo root."""
    import subprocess
    from storage.paths import workspace_root

    repo_dir = workspace_root(ws_id).resolve()
    if not repo_dir.is_dir():
        raise ValueError("workspace directory does not exist")
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, timeout=10, cwd=str(repo_dir),
        env=_git_subprocess_env(),
    )
    top_level = Path(result.stdout.strip())
    if (result.returncode != 0 or not top_level.is_absolute()
            or top_level.resolve() != repo_dir):
        raise ValueError("workspace directory is not a Git repository top-level")
    return str(repo_dir)
from typing import Optional, Literal
from storage.delivery_store import read_rollback_plan, save_rollback_plan as persist_rollback_plan
from agent.runtime.utils import now_iso

DeliveryMode = Literal["code","diagnosis","report","data_processing","artifact_generation"]

def _now(): return now_iso()
def _rid(): return f"rb-{uuid.uuid4().hex[:8]}"
def _aid(): return f"art-{uuid.uuid4().hex[:8]}"

# ── Rollback Plan ──

@dataclass
class RollbackPlan:
    rollback_id: str = field(default_factory=_rid)
    task_id: str = ""
    workspace_id: str = ""
    strategy: str = ""
    steps: list = field(default_factory=list)
    required_artifacts: list = field(default_factory=list)
    validation_after_rollback: str = ""
    risk: str = ""
    created_at: str = ""
    def __post_init__(self):
        if not self.created_at: self.created_at = _now()
    def to_dict(self): return asdict(self)
    @classmethod
    def from_dict(cls, d): return cls(**{k:v for k,v in d.items() if k in cls.__dataclass_fields__})


# ── Delivery Artifact ──

@dataclass
class DeliveryArtifact:
    artifact_id: str = field(default_factory=_aid)
    task_id: str = ""
    delivery_mode: str = ""
    type: str = ""  # diff|patch|config_bundle|audit_report|validation_report|rollback_plan|markdown_report
    source_refs: list = field(default_factory=list)
    created_at: str = ""
    def __post_init__(self):
        if not self.created_at: self.created_at = _now()
    def to_dict(self): return asdict(self)


# ── Validation Gate ──

VALIDATION_REQUIREMENTS = {
    "code": ["test_passed", "build_passed", "lint_passed"],
    "network_change": ["precheck", "rollback_plan", "postcheck"],
    "diagnosis": ["evidence_collected"],
    "report": ["artifact_generated"],
    "data_processing": ["validation_summary"],
    "artifact_generation": ["artifact_id"],
}

DESTRUCTIVE_MODES = {"network_change", "code"}


def validate_delivery(mode: DeliveryMode, checks: dict) -> tuple[bool, list[str]]:
    """Validate delivery readiness. Returns (ok, missing_checks)."""
    if mode not in VALIDATION_REQUIREMENTS:
        return False, ["unknown_delivery_mode"]
    required = VALIDATION_REQUIREMENTS[mode]
    missing = [c for c in required if not checks.get(c)]
    return len(missing) == 0, missing


def requires_rollback(mode: DeliveryMode) -> bool:
    return mode in DESTRUCTIVE_MODES


# ── Rollback Plan Persistence ──

def save_rollback_plan(plan: RollbackPlan):
    persist_rollback_plan(plan.workspace_id, plan.rollback_id, plan.to_dict())

def get_rollback_plan(ws_id: str, rb_id: str) -> Optional[dict]:
    return read_rollback_plan(ws_id, rb_id)


# ── Audit Report ──

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


# ── GitOps Safety ──

def git_status_check(ws_id: str) -> dict:
    """Check real git status for the workspace directory.

    Fail closed if the workspace is missing or is not a Git repository root.
    """
    result = {"ok": True, "workspace": ws_id, "dirty": False, "branch": "unknown",
              "changed_files": [], "untracked": []}
    try:
        import subprocess
        repo_dir = _resolve_repo_dir(ws_id)
        # Get branch
        r2 = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=10, cwd=repo_dir,
            env=_git_subprocess_env(),
        )
        if r2.returncode != 0:
            return {"ok": False, "error": redact_string(r2.stderr.strip())[:500] or "branch lookup failed"}
        result["branch"] = redact_string(r2.stdout.strip())

        # Get porcelain status
        r3 = subprocess.run(
            ["git", "status", "--porcelain"],
            capture_output=True, text=True, timeout=10, cwd=repo_dir,
            env=_git_subprocess_env(),
        )
        if r3.returncode != 0:
            return {"ok": False, "error": redact_string(r3.stderr.strip())[:500] or "status failed"}
        lines = [l for l in r3.stdout.split("\n") if l.strip()]
        result["dirty"] = len(lines) > 0
        result["changed_files"] = [redact_string(l[3:]) for l in lines if l[:2].strip()]
        result["untracked"] = [redact_string(l[3:]) for l in lines if l.startswith("??")]

        from storage.events import publish
        publish(ws_id, "git", "status_checked", result["branch"])
    except FileNotFoundError:
        result["ok"] = False
        result["status"] = "git_not_available"
        result["error"] = "git not available"
    except Exception as e:
        result["ok"] = False
        result["status"] = "error"
        result["error"] = redact_string(str(e))[:200]
    return result


def _candidate_paths(paths) -> list[str] | None:
    """Repository-relative candidate files; None when any entry is unsafe."""
    import posixpath
    if not isinstance(paths, (list, tuple)) or not paths or len(paths) > 1000:
        return None
    cleaned = []
    for item in paths:
        if not isinstance(item, str):
            return None
        value = item.replace("\\", "/").strip()
        normalized = posixpath.normpath(value) if value else ""
        if (not value or value.startswith(("/", "-", ":")) or re.match(r"^[A-Za-z]:", value)
                or normalized in {".", ".."} or normalized.startswith("../") or "\x00" in value
                or normalized == ".git" or normalized.startswith(".git/")):
            return None
        cleaned.append(normalized)
    return list(dict.fromkeys(cleaned))


def git_commit(ws_id: str, message: str = "", confirm: bool = False, paths=None) -> dict:
    """Commit exactly the candidate files (subprocess). Requires confirm=true.

    Only ``paths`` are staged and committed (``commit --only``); the user's other
    working-tree edits and anything they had already staged stay out of the commit.
    """
    if not confirm:
        return {"ok": False, "error": "confirm=true required to commit"}
    if not message:
        return {"ok": False, "error": "commit message required"}
    candidates = _candidate_paths(paths)
    if candidates is None:
        return {"ok": False, "error": "explicit repository-relative candidate paths required"}
    try:
        import subprocess
        repo_dir = _resolve_repo_dir(ws_id)
        r = subprocess.run(
            ["git", "add", "-A", "--", *candidates],
            capture_output=True, text=True, timeout=30, cwd=repo_dir,
            env=_git_subprocess_env(),
        )
        if r.returncode != 0:
            return {"ok": False, "error": redact_string(r.stderr.strip())[:500] or "git add failed"}
        r2 = subprocess.run(
            ["git", "commit", "--only", "-m", message, "--", *candidates],
            capture_output=True, text=True, timeout=30, cwd=repo_dir,
            env=_git_subprocess_env(),
        )
        if r2.returncode != 0:
            return {"ok": False, "error": redact_string(r2.stderr.strip())[:500] or "commit failed"}
        from storage.events import publish
        publish(ws_id, "git", "committed", redact_string(message)[:80])
        return {"ok": True, "message": "committed", "commit_message": redact_string(message)[:200],
                "output": redact_string(r2.stdout.strip())[:500]}
    except FileNotFoundError:
        return {"ok": False, "error": "git not available"}
    except Exception as e:
        return {"ok": False, "error": redact_string(str(e))[:200]}


def git_push(ws_id: str, remote: str = "origin", confirm: bool = False) -> dict:
    """Real git push (subprocess). Requires confirm=true and will NOT force-push."""
    if not confirm:
        return {"ok": False, "error": "confirm=true required to push"}
    if not isinstance(remote, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", remote):
        return {"ok": False, "error": "invalid remote name"}
    try:
        import subprocess
        repo_dir = _resolve_repo_dir(ws_id)
        remotes = subprocess.run(
            ["git", "remote"],
            capture_output=True, text=True, timeout=10, cwd=repo_dir,
            env=_git_subprocess_env(),
        )
        if remotes.returncode != 0:
            return {"ok": False, "error": redact_string(remotes.stderr.strip())[:500] or "remote lookup failed"}
        if remote not in remotes.stdout.splitlines():
            return {"ok": False, "error": "remote is not configured"}
        # Get current branch
        r = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=10, cwd=repo_dir,
            env=_git_subprocess_env(),
        )
        if r.returncode != 0:
            return {"ok": False, "error": redact_string(r.stderr.strip())[:500] or "branch lookup failed"}
        branch = r.stdout.strip()
        if not branch or branch == "HEAD" or branch.startswith("-"):
            return {"ok": False, "error": "a named branch is required to push"}
        # Push (no force)
        r2 = subprocess.run(
            ["git", "push", "--", remote, f"refs/heads/{branch}:refs/heads/{branch}"],
            capture_output=True, text=True, timeout=60, cwd=repo_dir,
            env={**_git_subprocess_env(), "GIT_TERMINAL_PROMPT": "0"},
        )
        if r2.returncode != 0:
            return {"ok": False, "error": redact_string(r2.stderr.strip())[:500] or "push failed"}
        from storage.events import publish
        publish(ws_id, "git", "pushed", redact_string(f"{remote}/{branch}"))
        return redact_tool_output({"ok": True, "remote": remote, "branch": branch,
                "message": "pushed", "output": redact_string(r2.stdout.strip())[:500]})
    except FileNotFoundError:
        return {"ok": False, "error": "git not available"}
    except Exception as e:
        return {"ok": False, "error": redact_string(str(e))[:200]}
