"""Coding team lifecycle, identity, conflicts and crash recovery contracts."""
from types import SimpleNamespace

import pytest

from agent.runtime.durable import subagent, coding_team
from core.tools.context import ToolRuntimeContext
from core.tools.integration import get_default_tool_runtime_client
from core.tools.project_execution import DockerProjectEnvironment
from storage import project_changes
from storage.paths import workspace_root


@pytest.fixture
def team(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LZCORE_CODING_DOCKER_COMMAND", '["docker"]')
    def start(environment):
        environment.started = True
        environment.image_id = "sha256:" + "1" * 64
        return environment
    def close(environment):
        environment.closed = environment.cleanup_confirmed = True
        return True
    monkeypatch.setattr(DockerProjectEnvironment, "start", start)
    monkeypatch.setattr(DockerProjectEnvironment, "close", close)
    monkeypatch.setattr(DockerProjectEnvironment, "execute", lambda *a, **kw: {"ok": True, "exit_code": 0, "stdout": "checked"})
    client = get_default_tool_runtime_client()
    parent = ToolRuntimeContext(workspace_id="parent-ws", session_id="parent-session", task_id="parent-task", requested_by="turn_runner")
    def spawn(profile="coding_agent", *, review="", depends=None, responsibilities=None, instruction="Implement"):
        arguments = {"action": "spawn", "instruction": instruction, "profile_id": profile, "background": False,
            "coding_assignment": {"project_dir": "files/data/app", "responsibilities": responsibilities or ["src"],
                "depends_on": depends or [], "validation_commands": ["python3 -c 'assert True'"], "review_subtask_id": review}}
        result = client.invoke("agent.manage", arguments, context=parent)
        return result.output
    def runtime(session, turn, **kwargs):
        assert session.workspace_id != parent.workspace_id
        assert kwargs.get("requested_by") == "subagent" and kwargs.get("allowed_tool_ids") is None
        role = turn.op.runtime_control.profile["profile_id"] if hasattr(turn, "op") else ""
        # The typed runtime profile lives on AgentTurn.runtime_control.
        control = getattr(turn, "runtime_control", None)
        if control is not None:
            role = control.profile["profile_id"]
        if role != "qa_agent":
            context = ToolRuntimeContext(workspace_id=session.workspace_id, session_id=session.session_id, requested_by="subagent")
            result = client.invoke("workspace.file", {"action": "create", "filepath": "files/data/app/src/value.py", "content": "VALUE = 42\n"}, context=context)
            assert result.status == "succeeded"
        return SimpleNamespace(ok=True, final_response="Implemented" if role != "qa_agent" else "Reviewed", tool_calls=[])
    monkeypatch.setattr("agent.runtime.ssot_runtime.run_ssot_turn", runtime)
    return SimpleNamespace(spawn=spawn, client=client, parent=parent)


def test_role_runtime_has_real_isolated_changes_and_independent_qa_gate(team):
    implementation = team.spawn()
    assert implementation["task_status"] == "succeeded"
    identity = implementation["subtask_id"]
    assert not (workspace_root("parent-ws") / "files/data/app/src/value.py").exists()
    rejected = subagent.merge_subagent_result("parent-task", identity, "parent-ws")
    assert not rejected["ok"] and rejected["error"] == "coding_independent_qa_required"
    qa = team.spawn("qa_agent", review=identity)
    assert qa["task_status"] == "succeeded", qa
    integrated = subagent.merge_subagent_result("parent-task", identity, "parent-ws")
    assert integrated["ok"] and integrated["phase"] == "integrated"
    assert (workspace_root("parent-ws") / "files/data/app/src/value.py").read_text() == "VALUE = 42\n"
    assert subagent.merge_subagent_result("parent-task", identity, "parent-ws")["ok"]


def test_dependencies_do_not_run_or_merge_before_ready(team):
    first = team.spawn()
    waiting = team.spawn(depends=[first["subtask_id"]])
    assert waiting["task_status"] == "created"
    stored = subagent._load_task("parent-ws", waiting["subtask_id"])
    assert stored.coding["phase"] == "dependency_wait"
    assert not project_changes.project_path(stored.coding["branch_workspace"], "files/data/app").exists()
    assert not subagent.merge_subagent_result("parent-task", waiting["subtask_id"], "parent-ws")["ok"]


def test_file_responsibilities_fail_closed(team):
    result = team.spawn(responsibilities=["frontend"])
    assert result["task_status"] == "failed"
    assert "responsibility_violation" in str(result["errors"])
    assert not (workspace_root("parent-ws") / "files/data/app/src/value.py").exists()


def test_qa_exit_failure_never_integrates(team, monkeypatch):
    first = team.spawn()
    monkeypatch.setattr(DockerProjectEnvironment, "execute", lambda *a, **kw: {"ok": False, "exit_code": 1, "stderr": "failed assertion"})
    qa = team.spawn("qa_agent", review=first["subtask_id"])
    assert qa["task_status"] == "failed", qa
    assert not subagent.merge_subagent_result("parent-task", first["subtask_id"], "parent-ws")["ok"]


def test_parent_conflict_preserves_users_file(team):
    first = team.spawn()
    qa = team.spawn("qa_agent", review=first["subtask_id"])
    assert qa["task_status"] == "succeeded", qa
    target = workspace_root("parent-ws") / "files/data/app/src/value.py"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("VALUE = 'user edit'\n")
    result = subagent.merge_subagent_result("parent-task", first["subtask_id"], "parent-ws")
    assert result["phase"] == "conflict" and not result["ok"]
    assert target.read_text() == "VALUE = 'user edit'\n"


def test_candidate_change_after_qa_rejected(team):
    first = team.spawn()
    assert team.spawn("qa_agent", review=first["subtask_id"])["task_status"] == "succeeded"
    task = subagent._load_task("parent-ws", first["subtask_id"])
    branch = project_changes.project_path(task.coding["branch_workspace"], "files/data/app")
    (branch / "src/value.py").write_text("VALUE = 99\n")
    result = subagent.merge_subagent_result("parent-task", first["subtask_id"], "parent-ws")
    assert not result["ok"] and result["error"] == "coding_candidate_changed_after_qa"


def test_related_tasks_cannot_cross_parent_or_workspace(team):
    first = team.spawn()
    assert not subagent.merge_subagent_result("other-parent", first["subtask_id"], "parent-ws")["ok"]
    assert not subagent.merge_subagent_result("parent-task", first["subtask_id"], "other-ws")["ok"]
    task = subagent._load_task("parent-ws", first["subtask_id"])
    task.session_id = "other-session"
    subagent._save_task(task)
    invalid = team.spawn(depends=[first["subtask_id"]])
    assert not invalid["ok"] and "outside_parent" in str(invalid)


def test_source_links_cannot_escape_snapshot(team, tmp_path):
    project = project_changes.project_path("parent-ws", "files/data/app")
    project.mkdir(parents=True)
    (project / "escape").symlink_to(tmp_path / "private")
    with pytest.raises(ValueError, match="symlink"):
        project_changes.source_manifest(project)


def test_partial_publication_recovers_without_claiming_success(team, monkeypatch):
    project = project_changes.project_path("parent-ws", "files/data/app")
    branch = project_changes.project_path("branch-ws", "files/data/app")
    project.mkdir(parents=True)
    branch.mkdir(parents=True)
    for path in ("a.py", "b.py"):
        (project / path).write_text("before")
        (branch / path).write_text("after")
    change = project_changes.changeset(project_changes.source_manifest(project), project_changes.source_manifest(branch), ["."])
    replace = project_changes._replace
    failure = [True]
    def interrupt(target, source):
        if target.name == "b.py" and failure[0]:
            failure[0] = False
            raise OSError("test publication interruption")
        return replace(target, source)
    monkeypatch.setattr(project_changes, "_replace", interrupt)
    result = project_changes.publish_changes("parent-ws", "files/data/app", "sub-12345678", branch, change)
    assert not result["ok"] and result["phase"] == "rolled_back"
    assert all((project / path).read_text() == "before" for path in ("a.py", "b.py"))
    retry = project_changes.publish_changes("parent-ws", "files/data/app", "sub-12345678", branch, change)
    assert retry["ok"] and retry["phase"] == "integrated"


def test_whole_project_scope_has_one_canonical_root(team):
    result = team.spawn(responsibilities=["."])
    assert result["task_status"] == "succeeded", result
    assert result["coding"]["responsibilities"] == ["."]


def test_unpublished_wildcard_scope_is_rejected(team):
    result = team.spawn(responsibilities=["src/*"])
    assert result["task_status"] == "failed"
    assert "responsibility_violation" in str(result["errors"])


def test_governed_merge_derives_trusted_parent_without_model_identity(team):
    implementation = team.spawn()
    qa = team.spawn("qa_agent", review=implementation["subtask_id"])
    assert qa["task_status"] == "succeeded"
    result = team.client.invoke("agent.manage", {"action": "merge", "subtask_id": implementation["subtask_id"]}, context=team.parent)
    assert result.status == "succeeded" and result.output["phase"] == "integrated", result.output
    from scripts.benchmark_team_acceptance import verify_team
    assert verify_team("parent-ws", "parent-session", "files/data/app")["status"] == "PASS"


def test_governed_spawn_rejects_forged_session(team):
    result = team.client.invoke("agent.manage", {"action": "spawn", "instruction": "inspect", "session_id": "foreign-session"}, context=team.parent)
    assert result.status == "failed" and "session_id_mismatch" in str(result.output)


def test_ssot_tool_adapter_transfers_current_task_identity():
    import asyncio
    from agent.runtime.ssot_tools import _make_tool_handler
    from core.tools.schemas import ToolResult
    calls = []
    def invoke(tool_id, args, *, context):
        calls.append(context)
        return ToolResult(tool_id=tool_id, output={"ok": True})
    client = SimpleNamespace(canonicalize_arguments=lambda tool,args: args, invoke=invoke)
    handler = _make_tool_handler(client=client, tool_id="agent.manage", workspace_id="ws", session_id="session",
        run_id="run", trace_id="trace", requested_by="turn_runner", task_id="durable-parent")
    asyncio.run(handler({"action": "list"}))
    assert calls[0].task_id == "durable-parent" and calls[0].session_id == "session"


def test_created_coding_task_can_only_start_from_its_parent(team):
    first = team.spawn()
    waiting = team.spawn(depends=[first['subtask_id']])
    other = ToolRuntimeContext(workspace_id='parent-ws', session_id='foreign', task_id='foreign', requested_by='turn_runner')
    result = team.client.invoke('agent.manage', {'action': 'start', 'subtask_id': waiting['subtask_id']}, context=other)
    assert result.status == 'failed' and 'coding_parent_identity_mismatch' in str(result.output)
    assert subagent._load_task('parent-ws', waiting['subtask_id']).coding['phase'] == 'dependency_wait'


def test_worker_cancellation_is_principal_scoped(team):
    from storage.principal import storage_principal
    from agent.runtime.durable.subagent_control import register_parent_cancel, cancellation_probe, release_parent_cancel
    with storage_principal('alice'):
        event_a = subagent._cancel_event('same-ws', 'sub-12345678')
        event_a.clear()
        register_parent_cancel('same-ws', 'sub-12345678', lambda: True)
    with storage_principal('bob'):
        event_b = subagent._cancel_event('same-ws', 'sub-12345678')
        assert event_a is not event_b
        assert not cancellation_probe('same-ws', 'sub-12345678', event_b)()
    with storage_principal('alice'):
        assert cancellation_probe('same-ws', 'sub-12345678', event_a)()
        release_parent_cancel('same-ws', 'sub-12345678')
        subagent._release_worker('same-ws', 'sub-12345678')
    with storage_principal('bob'):
        assert not event_b.is_set()
        subagent._release_worker('same-ws', 'sub-12345678')
