"""Subagent orchestration tools."""

from __future__ import annotations

from core.tools.schemas import ToolInvocation
from storage.ids import validate_workspace_id

from core.tools.general_tools.shared import _caller_workspace, _error_inv, _ok, _result

# Re-export the BUILTIN_PROFILES from subagent runtime for validation
from agent.runtime.durable.subagent import BUILTIN_PROFILES, SubagentProfile


_TERMINAL_SUBTASK_STATUSES = {"succeeded", "failed", "cancelled", "canceled"}


def _subtask_tracking(subtask_id: str, status: str, progress=None) -> dict:
    normalized_status = str(status or "running").strip().lower()
    done = normalized_status in _TERMINAL_SUBTASK_STATUSES
    return {
        "kind": "long_task",
        "domain": "subagent",
        "task_id": subtask_id,
        "status": normalized_status,
        "progress": dict(progress or {}),
        "done": done,
        "terminal": done,
        "next_poll_seconds": 2,
        "suggested_next_action": "synthesize_results" if done else "poll_get",
        "poll_action": "get",
        "poll_arguments": {"action": "get", "subtask_id": subtask_id},
    }


# ── Subagent execution ───────────────────────────────────────────────


def _get_profile(profile_id: str) -> SubagentProfile | None:
    return BUILTIN_PROFILES.get(profile_id)


def _inv_session_id(inv: ToolInvocation) -> str:
    caller = str(getattr(inv, "session_id", "") or "").strip()
    requested = str((inv.arguments or {}).get("session_id") or "").strip()
    if caller and requested and caller != requested:
        raise ValueError("subagent_session_id_mismatch")
    return caller or requested


def _inherit_parent_workbench_context(inv: ToolInvocation, workspace_id: str) -> dict:
    """Re-resolve a selected Skill before delegating it to a child Agent.

    The parent tool invocation contains only server-populated Skill identity and
    connection scope. Re-resolving it prevents stale or caller-forged context
    while preserving the exact device/connection slice visible to the parent.
    """
    skill_id = str(getattr(inv, "skill", "") or "").strip()
    if not skill_id:
        return {}
    from extensions.runtime import list_workbench_skills, resolve_workbench_context

    catalog = list_workbench_skills(workspace_id)
    entry = next(
        (item for item in catalog if str(item.get("skill_id") or "") == skill_id), None
    )
    if not entry:
        raise ValueError("parent_workbench_skill_not_available")
    context = resolve_workbench_context(
        workspace_id,
        {
            "extension_id": str(entry.get("extension_id") or ""),
            "skill_id": skill_id,
        },
    )
    selected_connection_ids = {
        str(item)
        for item in (getattr(inv, "skill_connection_ids", ()) or ())
        if str(item)
    }
    if not selected_connection_ids:
        return context
    connections = [
        item
        for item in (context.get("connections") or [])
        if isinstance(item, dict)
        and str(item.get("connection_id") or "") in selected_connection_ids
    ]
    resolved_connection_ids = {
        str(item.get("connection_id") or "") for item in connections
    }
    if resolved_connection_ids != selected_connection_ids:
        raise ValueError("parent_workbench_connection_scope_not_available")
    device_ids = list(
        dict.fromkeys(
            str(item.get("device_id") or "")
            for item in connections
            if str(item.get("device_id") or "")
        )
    )
    return {
        **context,
        "connection_ids": [
            str(item.get("connection_id") or "") for item in connections
        ],
        "connections": connections,
        "device_ids": device_ids,
        "devices": [
            item
            for item in (context.get("devices") or [])
            if isinstance(item, dict)
            and str(item.get("device_id") or "") in set(device_ids)
        ],
    }


def _run_durable_subagent(
    *,
    instruction: str,
    workspace_id: str,
    session_id: str,
    parent_task_id: str = "",
    profile_id: str = "research_agent",
    max_turns: int | None = None,
    background: bool = False,
    workbench_context: dict | None = None,
    coding_assignment: dict | None = None,
    cancel_check=None,
) -> dict:
    from agent.runtime.durable.subagent import (
        create_subagent_task,
        start_subagent_task,
        merge_subagent_result,
        wait_subagent_task,
    )
    from core.tools.context import get_runtime_operation_context

    runtime_operation = get_runtime_operation_context()

    profile = _get_profile(profile_id)
    if not profile:
        return {
            "ok": False,
            "status": "failed",
            "error_code": "ARG_ENUM_INVALID",
            "error": f"unknown profile_id: {profile_id}",
            "error_details": {
                "field": "profile_id",
                "invalid_value": profile_id,
                "allowed_values": list(BUILTIN_PROFILES),
            },
            "retryable": False,
        }

    effective_turns = max_turns or profile.max_steps

    created = create_subagent_task(
        parent_task_id=parent_task_id,
        workspace_id=workspace_id,
        session_id=session_id,
        profile_id=profile_id,
        goal=instruction,
        context_refs=[],
        max_steps=effective_turns,
        operation_id=(
            runtime_operation[1]
            if runtime_operation and runtime_operation[0] == workspace_id
            else ""
        ),
        operation_call_id=(
            runtime_operation[2]
            if runtime_operation and runtime_operation[0] == workspace_id
            else ""
        ),
        workbench_context=workbench_context,
        coding_assignment=coding_assignment,
        cancel_check=cancel_check,
    )
    if not created.get("ok"):
        return {
            "ok": False,
            "error": created.get("error", "failed to create subagent task"),
        }

    subtask_id = created["subtask_id"]
    from agent.runtime.durable.subagent_control import register_parent_cancel

    register_parent_cancel(workspace_id, subtask_id, cancel_check)

    if runtime_operation and runtime_operation[0] == workspace_id:
        from core.runtime_engine.operation_ledger import link_operation_resource

        link_operation_resource(
            workspace_id,
            runtime_operation[1],
            resource_kind="subagent",
            resource_id=subtask_id,
        )

    if background:
        started = start_subagent_task(subtask_id, workspace_id)
        if not started.get("ok"):
            return started
        status = str(started.get("status") or "running")
        return {
            "ok": True,
            "subtask_id": subtask_id,
            "parent_task_id": parent_task_id,
            "status": status,
            "background": True,
            "tracking": _subtask_tracking(subtask_id, status),
            "summary": f"Subagent {profile.name} started in background (task: {subtask_id})",
            "_hint": f"Subagent {profile_id} launched in background (task: {subtask_id})",
        }

    started = start_subagent_task(subtask_id, workspace_id)
    if not started.get("ok"):
        return started
    result = wait_subagent_task(subtask_id, workspace_id)
    if (
        result.get("ok")
        and result.get("status") == "succeeded"
        and not result.get("coding")
    ):
        merge_subagent_result(parent_task_id, subtask_id, workspace_id)
    return {
        "ok": result.get("ok", False)
        and result.get("status") in {"succeeded", "created", "running"},
        "final_response": result.get("summary", ""),
        "summary": result.get("summary", ""),
        "subtask_id": subtask_id,
        "profile_id": profile_id,
        "parent_task_id": parent_task_id,
        "agent_name": profile.name,
        "status": result.get("status", "unknown"),
        "findings": result.get("findings", []),
        "tool_results": result.get("tool_results", []),
        "errors": result.get("errors", []),
        "warnings": result.get("warnings", []),
        "coding": result.get("coding", {}),
        "deferred": bool(result.get("deferred")),
    }


# ── Generic spawn dispatcher ─────────────────────────────────────────


def _spawn_agent(inv: ToolInvocation, profile_id: str) -> dict:
    """Generic dispatcher for spawning a subagent of a specific profile."""
    args = inv.arguments
    instruction = str(args.get("instruction", "")).strip()
    try:
        max_turns = int(args.get("max_turns", 0) or 0)
    except (TypeError, ValueError):
        return _error_inv(inv, "max_turns must be an integer")
    background = args.get("background") is not False

    if not instruction:
        return _error_inv(inv, "instruction is required")

    profile = _get_profile(profile_id)
    if not profile:
        return _error_inv(
            inv,
            f"unknown profile_id: {profile_id}",
            error_code="ARG_ENUM_INVALID",
            details={
                "field": "profile_id",
                "invalid_value": profile_id,
                "allowed_values": list(BUILTIN_PROFILES),
            },
        )

    workspace_id = _caller_workspace(inv)
    from core.tools.action_requirements import required_action_arguments

    missing = [field for field in required_action_arguments("agent.manage", "spawn", {
        **args, "profile_id": profile_id,
    }) if not args.get(field)]
    if missing:
        return _error_inv(inv, "Missing required spawn arguments: " + ", ".join(missing),
                          error_code="MISSING_REQUIRED_ARG", details={"fields": missing})
    # Omission means "use the selected profile's budget". A hidden generic
    # default previously reduced every profile to five turns and made valid
    # delegated research fail before synthesis.
    effective_turns = max_turns or profile.max_steps

    try:
        validate_workspace_id(workspace_id)
        workbench_context = _inherit_parent_workbench_context(inv, workspace_id)
        result = _run_durable_subagent(
            instruction=instruction,
            workspace_id=workspace_id,
            session_id=_inv_session_id(inv),
            parent_task_id=getattr(inv, "task_id", "") or "",
            profile_id=profile_id,
            max_turns=effective_turns,
            background=background,
            workbench_context=workbench_context,
            coding_assignment=args.get("coding_assignment"),
            cancel_check=getattr(inv, "cancel_check", None),
        )
        return _result(
            inv,
            result.get("ok", False),
            {
                **result,
                "task_status": result.get("status", "unknown"),
                **(
                    {
                        "tracking": _subtask_tracking(
                            result["subtask_id"], result["status"]
                        )
                    }
                    if result.get("subtask_id")
                    and result.get("status") in {"created", "running"}
                    else {}
                ),
                "_hint": (
                    f"Subagent {profile_id} "
                    + f"已受理，当前状态: {result.get('status')}。"
                    + f" subtask_id: {result.get('subtask_id')}。"
                    + " 用 agent.manage(action=get) 获取详细结果。"
                ),
            },
        )
    except Exception as e:
        return _error_inv(inv, str(e)[:200])


# ── Other action handlers ────────────────────────────────────────────


def handle_agent_start(inv: ToolInvocation) -> dict:
    """Start a dependency-ready assignment without spawning a duplicate."""
    from agent.runtime.durable.subagent import _load_task, start_subagent_task

    ws = _caller_workspace(inv)
    subtask_id = str(inv.arguments.get("subtask_id") or "")
    task = _load_task(ws, subtask_id)
    if not task:
        return _error_inv(inv, "subtask not found")
    if task.coding and (
        task.parent_task_id != getattr(inv, "task_id", "")
        or task.session_id != _inv_session_id(inv)
    ):
        return _error_inv(inv, "coding_parent_identity_mismatch")
    from agent.runtime.durable.subagent_control import register_parent_cancel
    register_parent_cancel(ws, subtask_id, getattr(inv, "cancel_check", None))
    result = start_subagent_task(subtask_id, ws)
    return {
        **result,
        "tracking": _subtask_tracking(subtask_id, result.get("status", "created")),
    }


def handle_agent_spawn(inv: ToolInvocation) -> dict:
    """Spawn a durable subagent using a generic base profile."""
    args = inv.arguments or {}
    profile_id = str(args.get("profile_id") or "research_agent").strip()
    return _spawn_agent(inv, profile_id=profile_id)


def handle_agent_list(inv: ToolInvocation) -> dict:
    """List available agent profiles with capabilities."""
    profiles = []
    for pid, p in BUILTIN_PROFILES.items():
        profiles.append(
            {
                "profile_id": pid,
                "name": p.name,
                "description": p.description,
                "max_steps": p.max_steps,
                "allowed_tools": [],
                "inherits_parent_tool_surface": True,
                "inherits_selected_skill": True,
                "can_modify_files": True,
                "can_execute_commands": True,
                "can_call_network": True,
            }
        )
    return _ok(
        inv,
        "",
        {
            "profiles": profiles,
            "count": len(profiles),
            "_hint": "可用子Agent profile: " + ", ".join(BUILTIN_PROFILES.keys()),
        },
    )


def handle_agent_get_result(inv: ToolInvocation) -> dict:
    """Get a subagent result by its canonical subtask/session identifier."""
    args = inv.arguments or {}
    ws = _caller_workspace(inv)
    subtask_id = str(args.get("subtask_id") or "").strip()

    if not subtask_id:
        return _error_inv(inv, "subtask_id is required")

    try:
        validate_workspace_id(ws)
        from agent.runtime.durable.subagent import get_subagent_task

        persisted = get_subagent_task(ws, subtask_id)
        if persisted is not None:
            status = str(persisted.get("status") or "unknown")
            payload = {
                "workspace_id": ws,
                **persisted,
                # The tool envelope's status describes this read operation.
                # Preserve the child's independent lifecycle under a stable
                # name even when _ok projects status='ok'.
                "task_status": status,
                "tracking": _subtask_tracking(subtask_id, status, persisted.get("progress")),
            }
            payload.setdefault("subtask_id", subtask_id)
            payload.setdefault("preview", str(persisted.get("summary") or ""))
            payload.setdefault("artifact_id", "")
            if persisted.get("coding"):
                payload["_hint"] = (
                    "Implementation source is in its isolated branch and will not appear in the parent "
                    "project before exact independent QA and merge. running/created are live states; "
                    "use progress and dependency phase, not an empty parent directory, to assess work. "
                    "Keep observing this handle while it is progressing. An observer polling pause "
                    "is not a worker deadline or failure."
                )
            artifact_id = str(persisted.get("result_artifact_id") or "").strip()
            if status == "succeeded" and artifact_id:
                # This remains inside the registered agent.manage handler. The
                # artifact is the durable authority for a completed child result;
                # do not downgrade it to the diagnostic summary field.
                from artifacts.store import read_artifact_content

                full_result = read_artifact_content(ws, artifact_id)
                if full_result is not None:
                    payload.update(
                        {
                            "artifact_id": artifact_id,
                            "artifact_ids": [artifact_id],
                            "artifact_type": "output_data",
                            "preview": full_result,
                            "content_chars": len(full_result),
                            "content_complete": True,
                            "subagent_result_complete": True,
                        }
                    )
                    return _ok(
                        inv,
                        f"Subagent result ready: {len(full_result)} chars in artifact {artifact_id}",
                        payload,
                    )
            if status in {"failed", "cancelled", "canceled"}:
                error_code = (
                    "SUBAGENT_CANCELLED"
                    if status in {"cancelled", "canceled"}
                    else "SUBAGENT_FAILED"
                )
                errors = [
                    str(item) for item in (persisted.get("errors") or []) if str(item)
                ]
                summary = str(
                    persisted.get("summary")
                    or (errors[0] if errors else f"Subagent {status}")
                )
                return _result(
                    inv,
                    False,
                    {
                        **payload,
                        "summary": summary,
                        "error": summary,
                        "errors": errors or [summary],
                        "error_code": error_code,
                        "retryable": False,
                    },
                )
            return _ok(
                inv,
                str(persisted.get("summary") or f"Subagent status: {status}"),
                payload,
            )

        return _error_inv(inv, "subtask not found")
    except Exception as e:
        return _error_inv(inv, str(e)[:200])


def handle_agent_cancel(inv: ToolInvocation) -> dict:
    """Cancel a running subagent by subtask_id."""
    args = inv.arguments
    subtask_id = str(args.get("subtask_id", "")).strip()
    if not subtask_id:
        return _error_inv(inv, "subtask_id is required")
    try:
        ws = _caller_workspace(inv)
        validate_workspace_id(ws)
        from agent.runtime.durable.subagent import cancel_subagent_task

        cancelled = cancel_subagent_task(subtask_id, ws)
        if not cancelled.get("ok"):
            return _error_inv(inv, cancelled.get("error", "cancel failed"))
        return _ok(
            inv,
            "",
            {
                "subtask_id": subtask_id,
                "cancelled": True,
                "_hint": f"Subagent {subtask_id} 已取消。",
            },
        )
    except Exception as e:
        return _error_inv(inv, str(e)[:200])


def handle_agent_review(inv: ToolInvocation) -> dict:
    """Record only the calling QA worker's server-bound candidate judgement."""
    from core.tools.project_execution import environment_for

    if not inv.workspace_id or not inv.session_id:
        return _error_inv(inv, "coding_review_requires_trusted_identity")
    environment = environment_for(_caller_workspace(inv))
    if (environment is None or environment.closed or environment.source_mode != "review"
            or not callable(environment.review_submit)):
        return _error_inv(inv, "coding_review_requires_active_qa_binding")
    try:
        return environment.review_submit(_inv_session_id(inv), inv.arguments["review"])
    except (ValueError, TypeError, KeyError) as exc:
        return _error_inv(inv, str(exc))


def handle_agent_merge(inv: ToolInvocation) -> dict:
    """Integrate only the current trusted parent's independently reviewed task."""
    args = inv.arguments or {}
    subtask_id = str(args.get("subtask_id") or "").strip()
    if not subtask_id:
        return _error_inv(inv, "subtask_id is required")
    try:
        ws = _caller_workspace(inv)
        from agent.runtime.durable.subagent import _load_task, merge_subagent_result

        task = _load_task(ws, subtask_id)
        if task is None:
            return _error_inv(inv, "subtask not found")
        trusted_parent = str(getattr(inv, "task_id", "") or "").strip()
        supplied_parent = str(args.get("parent_task_id") or "").strip()
        if trusted_parent and supplied_parent and supplied_parent != trusted_parent:
            return _error_inv(inv, "subtask parent mismatch")
        parent = trusted_parent or supplied_parent
        if task.coding:
            if not parent or task.session_id != _inv_session_id(inv):
                return _error_inv(inv, "coding_parent_identity_mismatch")
        if not parent:
            return _error_inv(inv, "parent_task_id is required")
        return merge_subagent_result(parent, subtask_id, ws)
    except Exception as exc:
        return _error_inv(inv, str(exc)[:200])


def handle_agent_reconcile(inv: ToolInvocation) -> dict:
    """Use the runtime parent's scope and persisted execution identity only."""
    from agent.runtime.durable.subagent import _load_task
    from agent.runtime.durable.coding_recovery import reconcile_execution
    try:
        task = _load_task(_caller_workspace(inv), inv.arguments["subtask_id"])
        if (not task or not inv.task_id or task.parent_task_id != inv.task_id
                or task.session_id != _inv_session_id(inv)
                or inv.arguments.get("parent_task_id", inv.task_id) != inv.task_id):
            return _error_inv(inv, "coding_parent_identity_mismatch")
        return reconcile_execution(task)
    except (ValueError, OSError) as exc:
        return _error_inv(inv, str(exc)[:200])


def handle_agent_status(inv: ToolInvocation) -> dict:
    """List all running/completed subagent tasks."""
    try:
        ws = _caller_workspace(inv)
        validate_workspace_id(ws)
        from agent.runtime.durable.subagent import list_subagent_tasks

        tasks = list_subagent_tasks(ws)
        return _ok(
            inv,
            "",
            {
                "tasks": tasks,
                "count": len(tasks),
                "_hint": f"{len(tasks)} 个子Agent任务。用 agent.manage(action=cancel) 取消运行中的任务。",
            },
        )
    except Exception as e:
        return _error_inv(inv, str(e)[:200])


# ── Exports ──────────────────────────────────────────────────────────

__all__ = [
    # Other action handlers
    "handle_agent_spawn",
    "handle_agent_list",
    "handle_agent_get_result",
    "handle_agent_cancel",
    "handle_agent_merge",
    "handle_agent_reconcile",
    "handle_agent_review",
    "handle_agent_status",
]
