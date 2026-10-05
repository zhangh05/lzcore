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
    monkeypatch.setattr(
        DockerProjectEnvironment,
        "execute",
        lambda *a, **kw: {"ok": True, "exit_code": 0, "stdout": "checked"},
    )
    client = get_default_tool_runtime_client()
    parent = ToolRuntimeContext(
        workspace_id="parent-ws",
        session_id="parent-session",
        task_id="parent-task",
        requested_by="turn_runner",
    )

    def spawn(
        profile="coding_agent",
        *,
        review="",
        depends=None,
        responsibilities=None,
        instruction="Implement",
        generated_paths=None,
        background=False,
    ):
        arguments = {
            "action": "spawn",
            "instruction": instruction,
            "profile_id": profile,
            "background": background,
            "coding_assignment": {
                "project_dir": "files/data/app",
                "responsibilities": responsibilities or ["src"],
                "depends_on": depends or [],
                "validation_commands": ["python3 -c 'assert True'"],
                "review_subtask_id": review,
                "generated_paths": generated_paths or [],
            },
        }
        result = client.invoke("agent.manage", arguments, context=parent)
        return result.output

    def runtime(session, turn, **kwargs):
        assert session.workspace_id != parent.workspace_id
        assert (
            kwargs.get("requested_by") == "subagent"
            and kwargs.get("allowed_tool_ids") is None
        )
        role = (
            turn.op.runtime_control.profile["profile_id"] if hasattr(turn, "op") else ""
        )
        # The typed runtime profile lives on AgentTurn.runtime_control.
        control = getattr(turn, "runtime_control", None)
        if control is not None:
            role = control.profile["profile_id"]
        if role != "qa_agent":
            context = ToolRuntimeContext(
                workspace_id=session.workspace_id,
                session_id=session.session_id,
                requested_by="subagent",
            )
            result = client.invoke(
                "workspace.file",
                {
                    "action": "create",
                    "filepath": "files/data/app/src/value.py",
                    "content": "VALUE = 42\n",
                },
                context=context,
            )
            assert result.status == "succeeded"
        return SimpleNamespace(
            ok=True,
            final_response="Implemented" if role != "qa_agent" else "Reviewed",
            tool_calls=[],
        )

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
    assert (
        workspace_root("parent-ws") / "files/data/app/src/value.py"
    ).read_text() == "VALUE = 42\n"
    assert subagent.merge_subagent_result("parent-task", identity, "parent-ws")["ok"]


def test_dependencies_do_not_run_or_merge_before_ready(team):
    first = team.spawn()
    waiting = team.spawn(depends=[first["subtask_id"]])
    assert waiting["task_status"] == "created"
    stored = subagent._load_task("parent-ws", waiting["subtask_id"])
    assert stored.coding["phase"] == "dependency_wait"
    assert not project_changes.project_path(
        stored.coding["branch_workspace"], "files/data/app"
    ).exists()
    assert not subagent.merge_subagent_result(
        "parent-task", waiting["subtask_id"], "parent-ws"
    )["ok"]


@pytest.mark.parametrize("unknown", [False, True])
def test_implementation_cannot_publish_when_declared_check_fails(team, monkeypatch, unknown):
    monkeypatch.setattr(DockerProjectEnvironment, "execute", lambda *a, **kw: {
        "ok": False, "exit_code": 1, "execution_may_continue": unknown})
    item = team.spawn()
    task = subagent._load_task("parent-ws", item["subtask_id"])
    assert task.status == "failed"
    validation = task.coding["completion_validation"]
    assert validation["status"] == ("unknown" if unknown else "failed")
    assert validation["automatic_retry_allowed"] is not unknown
    assert task.coding["phase"] != "changes_ready"
    assert not subagent.merge_subagent_result("parent-task", task.subtask_id, "parent-ws")["ok"]


def test_progress_prunes_dependencies_and_declared_outputs(team):
    item = team.spawn(generated_paths=["dist"])
    task = subagent._load_task("parent-ws", item["subtask_id"])
    branch = project_changes.project_path(task.coding["branch_workspace"], "files/data/app")
    for directory in ("node_modules/pkg", "dist", ".git"):
        (branch / directory).mkdir(parents=True, exist_ok=True)
        (branch / directory / "ignored").write_text("cache")
    observed = subagent.get_subagent_task("parent-ws", task.subtask_id)["progress"]
    assert observed["source_files"] == 1 and observed["source_bytes"] == len("VALUE = 42\n")
    assert observed["completion_status"] == "passed"
    assert "percent" not in observed


def test_changed_source_invalidates_completion_evidence(team, monkeypatch):
    item = team.spawn()
    task = subagent._load_task("parent-ws", item["subtask_id"])
    before = task.coding["completion_validation"]["source_digest"]
    branch = project_changes.project_path(task.coding["branch_workspace"], "files/data/app")
    (branch / "src/value.py").write_text("VALUE = 43\n")
    calls = []

    def execute(*args, **kwargs):
        calls.append(args)
        return {"ok": False, "exit_code": 1}

    monkeypatch.setattr(DockerProjectEnvironment, "execute", execute)
    validation = coding_team.check_implementation(task)
    assert validation["source_digest"] != before and validation["status"] == "failed"
    assert len(calls) == 1


def test_coding_spawn_requires_explicit_assignment_before_side_effects(team):
    result = team.client.invoke("agent.manage", {"action": "spawn", "profile_id": "coding_agent",
                                "instruction": "Implement"}, context=team.parent)
    assert result.status != "succeeded"
    assert "coding_assignment" in str(result.output)


def test_parent_contract_preserves_full_original_request_and_scope(tmp_path, monkeypatch):
    from agent.runtime.task_state import begin_task_state, load_task_state
    from storage.message_store import SessionMessageStore

    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    store = SessionMessageStore("parent-session", "parent-ws")
    store.write_message("old", "user", "Unrelated previous task", metadata={"created_at": "1"})
    original = "complete requirements " * 3000 + " exact final API field: noBuffers"
    store.write_message("initial", "user", original, metadata={"created_at": "2"})
    begin_task_state(workspace_id="parent-ws", session_id="parent-session", run_id="initial",
                     user_input=original)
    state = load_task_state("parent-ws", "parent-session")["task"]
    task = SimpleNamespace(workspace_id="parent-ws", session_id="parent-session",
                           parent_task_id=state["task_id"])
    messages = coding_team.parent_contract(task)
    assert len(state["objective"]) == 1200
    assert len(messages) == 1 and messages[0]["content"] == original
    refs = [{k: item[k] for k in ("run_id", "sha256")} for item in messages]
    assert coding_team.parent_contract(task, refs) == messages
    task.parent_task_id = "other-task"
    assert coding_team.parent_contract(task) == []
    store.write_message("initial", "user", "tampered requirements")
    with pytest.raises(ValueError, match="coding_parent_contract_changed"):
        coding_team.parent_contract(task, refs)


def test_qa_dependency_consumes_completed_candidate_before_publication(team):
    first = team.spawn()
    review = team.spawn("qa_agent", review=first["subtask_id"], depends=[first["subtask_id"]])
    assert review["task_status"] == "succeeded", review
    assert subagent.merge_subagent_result("parent-task", first["subtask_id"], "parent-ws")["ok"]


@pytest.mark.parametrize("cancel_review,fail_implementation", [(False, False), (True, False), (False, True)])
def test_queued_review_wakes_once_or_propagates_cancellation_and_failure(team, monkeypatch, cancel_review, fail_implementation):
    import threading
    from agent.runtime import ssot_runtime
    original = ssot_runtime.run_ssot_turn
    entered, release = threading.Event(), threading.Event()
    reviews = []
    def controlled(session, turn, **kwargs):
        if turn.op.runtime_control.profile["profile_id"] != "qa_agent":
            entered.set()
            assert release.wait(3)
            if fail_implementation:
                raise RuntimeError('owned implementation test failure')
        else:
            reviews.append(session.session_id)
        return original(session, turn, **kwargs)
    monkeypatch.setattr(ssot_runtime, "run_ssot_turn", controlled)
    first = team.spawn(background=True)
    assert entered.wait(2)
    try:
        queued = team.spawn("qa_agent", review=first["subtask_id"], depends=[first["subtask_id"]], background=True)
        assert queued["task_status"] == "created"
        if cancel_review:
            assert subagent.cancel_subagent_task(queued["subtask_id"], "parent-ws")["ok"]
    finally:
        release.set()
    subagent.wait_subagent_task(first["subtask_id"], "parent-ws", timeout=2)
    result = subagent.wait_subagent_task(queued["subtask_id"], "parent-ws", timeout=2)
    expected = "cancelled" if cancel_review else "failed" if fail_implementation else "succeeded"
    assert result["status"] == expected, result
    from agent.runtime.durable.coding_dispatch import dispatch_dependents
    dispatch_dependents(subagent._load_task("parent-ws", first["subtask_id"]))
    assert len(reviews) == (1 if expected == "succeeded" else 0)
    assert not (workspace_root("parent-ws") / "files/data/app/src/value.py").exists()


def test_publication_automatically_activates_requested_next_implementation(team, monkeypatch):
    from agent.runtime import ssot_runtime
    original = ssot_runtime.run_ssot_turn
    called = []
    def update(session, turn, **kwargs):
        if turn.op.runtime_control.profile["profile_id"] == "qa_agent":
            return original(session, turn, **kwargs)
        called.append(session.session_id)
        path = workspace_root(session.workspace_id) / "files/data/app/src/value.py"
        if not path.exists():
            return original(session, turn, **kwargs)
        result = team.client.invoke('workspace.file', {'action':'edit','filepath':'files/data/app/src/value.py','old_string':'42','new_string':'84'}, context=ToolRuntimeContext(workspace_id=session.workspace_id, session_id=session.session_id, requested_by='subagent'))
        assert result.status == 'succeeded'
        return SimpleNamespace(ok=True, final_response='Revised', tool_calls=[])
    monkeypatch.setattr(ssot_runtime, 'run_ssot_turn', update)
    first = team.spawn()
    next_task = team.spawn(depends=[first['subtask_id']], background=True)
    assert next_task['task_status'] == 'created'
    assert team.spawn('qa_agent', review=first['subtask_id'])['task_status'] == 'succeeded'
    assert subagent.merge_subagent_result('parent-task', first['subtask_id'], 'parent-ws')['ok']
    result = subagent.wait_subagent_task(next_task['subtask_id'], 'parent-ws', timeout=2)
    assert result['status'] == 'succeeded' and result['coding']['phase'] == 'changes_ready', result
    assert len(called) == 2
    assert (workspace_root('parent-ws') / 'files/data/app/src/value.py').read_text() == 'VALUE = 42\n'


def test_file_responsibilities_fail_closed(team):
    result = team.spawn(responsibilities=["frontend"])
    assert result["task_status"] == "failed"
    assert "responsibility_violation" in str(result["errors"])
    assert not (workspace_root("parent-ws") / "files/data/app/src/value.py").exists()


def test_qa_exit_failure_never_integrates(team, monkeypatch):
    first = team.spawn()
    monkeypatch.setattr(
        DockerProjectEnvironment,
        "execute",
        lambda *a, **kw: {"ok": False, "exit_code": 1, "stderr": "failed assertion"},
    )
    qa = team.spawn("qa_agent", review=first["subtask_id"])
    assert qa["task_status"] == "failed", qa
    assert not subagent.merge_subagent_result(
        "parent-task", first["subtask_id"], "parent-ws"
    )["ok"]


def test_parent_conflict_preserves_users_file(team):
    first = team.spawn()
    qa = team.spawn("qa_agent", review=first["subtask_id"])
    assert qa["task_status"] == "succeeded", qa

    target = workspace_root("parent-ws") / "files/data/app/src/value.py"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("VALUE = 'user edit'\n")
    result = subagent.merge_subagent_result(
        "parent-task", first["subtask_id"], "parent-ws"
    )
    assert result["phase"] == "conflict" and not result["ok"]
    assert target.read_text() == "VALUE = 'user edit'\n"


def test_qa_cannot_be_a_publication_dependency(team):
    implementation = team.spawn()
    qa = team.spawn("qa_agent", review=implementation["subtask_id"])
    invalid = team.spawn(depends=[qa["subtask_id"]])
    assert not invalid["ok"]
    assert "requires_implementation_candidate" in str(invalid)


def test_cancelled_dependency_propagates_through_waiting_dag(team):
    from agent.runtime.durable.coding_dispatch import dispatch_dependents
    from storage.records import atomic_save_json
    from dataclasses import asdict

    implementation = team.spawn()
    second = team.spawn(depends=[implementation["subtask_id"]])
    third = team.spawn(depends=[second["subtask_id"]])
    target = subagent._load_task("parent-ws", implementation["subtask_id"])
    # Simulate a predecessor's durable failed result without running a provider.
    target.status = "failed"
    atomic_save_json("parent-ws", ("subagents", f"{target.subtask_id}.json"), asdict(target))
    dispatch_dependents(target)
    for identity in [second["subtask_id"], third["subtask_id"]]:
        task = subagent._load_task("parent-ws", identity)
        assert task.status == "failed"
        assert task.coding["phase"] == "dependency_failed"


def test_candidate_change_after_qa_rejected(team):
    first = team.spawn()
    assert (
        team.spawn("qa_agent", review=first["subtask_id"])["task_status"] == "succeeded"
    )
    task = subagent._load_task("parent-ws", first["subtask_id"])
    branch = project_changes.project_path(
        task.coding["branch_workspace"], "files/data/app"
    )
    (branch / "src/value.py").write_text("VALUE = 99\n")
    result = subagent.merge_subagent_result(
        "parent-task", first["subtask_id"], "parent-ws"
    )
    assert not result["ok"] and result["error"] == "coding_candidate_changed_after_qa"


def test_related_tasks_cannot_cross_parent_or_workspace(team):
    first = team.spawn()
    assert not subagent.merge_subagent_result(
        "other-parent", first["subtask_id"], "parent-ws"
    )["ok"]
    assert not subagent.merge_subagent_result(
        "parent-task", first["subtask_id"], "other-ws"
    )["ok"]
    task = subagent._load_task("parent-ws", first["subtask_id"])
    task.session_id = "other-session"
    with pytest.raises(ValueError, match="identity_is_immutable"):
        subagent._save_task(task)
    from storage.records import atomic_save_json
    from dataclasses import asdict
    atomic_save_json("parent-ws", ("subagents", f"{task.subtask_id}.json"), asdict(task))
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
    change = project_changes.changeset(
        project_changes.source_manifest(project),
        project_changes.source_manifest(branch),
        ["."],
    )
    replace = project_changes._replace
    failure = [True]

    def interrupt(target, source):
        if target.name == "b.py" and failure[0]:
            failure[0] = False
            raise OSError("test publication interruption")
        return replace(target, source)

    monkeypatch.setattr(project_changes, "_replace", interrupt)
    result = project_changes.publish_changes(
        "parent-ws", "files/data/app", "sub-12345678", branch, change
    )
    assert not result["ok"] and result["phase"] == "rolled_back"
    assert all((project / path).read_text() == "before" for path in ("a.py", "b.py"))
    retry = project_changes.publish_changes(
        "parent-ws", "files/data/app", "sub-12345678", branch, change
    )
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
    result = team.client.invoke(
        "agent.manage",
        {"action": "merge", "subtask_id": implementation["subtask_id"]},
        context=team.parent,
    )
    assert result.status == "succeeded" and result.output["phase"] == "integrated", (
        result.output
    )
    from scripts.benchmark_team_acceptance import verify_team

    assert (
        verify_team("parent-ws", "parent-session", "files/data/app")["status"] == "PASS"
    )


def test_governed_spawn_rejects_forged_session(team):
    result = team.client.invoke(
        "agent.manage",
        {"action": "spawn", "instruction": "inspect", "session_id": "foreign-session"},
        context=team.parent,
    )
    assert result.status == "failed" and "session_id_mismatch" in str(result.output)


def test_team_acceptance_uses_declared_generated_output_contract(team, monkeypatch):
    from scripts.benchmark_team_acceptance import verify_team
    first = team.spawn(generated_paths=["dist"])
    assert team.spawn("qa_agent", review=first["subtask_id"])["task_status"] == "succeeded"
    assert subagent.merge_subagent_result("parent-task", first["subtask_id"], "parent-ws")["ok"]
    output = workspace_root("parent-ws") / "files/data/app/dist/asset.js"
    output.parent.mkdir()
    output.write_text("x" * 256)
    monkeypatch.setattr(project_changes, "MAX_BYTES", 128)
    assert verify_team("parent-ws", "parent-session", "files/data/app")["status"] == "PASS"


def test_acceptance_replays_reviewed_updates_and_rejects_unreviewed_changes(team, monkeypatch):
    from agent.runtime import ssot_runtime
    from scripts.benchmark_team_acceptance import verify_team

    first = team.spawn()
    assert team.spawn("qa_agent", review=first["subtask_id"])["task_status"] == "succeeded"
    merged = subagent.merge_subagent_result("parent-task", first["subtask_id"], "parent-ws")
    first_order = merged["publication_order"]
    original = ssot_runtime.run_ssot_turn

    def update(session, turn, **kwargs):
        if turn.op.runtime_control.profile["profile_id"] == "qa_agent":
            return original(session, turn, **kwargs)
        else:
            written = team.client.invoke("workspace.file", {
                "action": "edit", "filepath": "files/data/app/src/value.py", "old_string": "VALUE = 42", "new_string": "VALUE = 99",
            }, context=ToolRuntimeContext(workspace_id=session.workspace_id, session_id=session.session_id, requested_by="subagent"))
            assert written.status == "succeeded"
        return SimpleNamespace(ok=True, final_response="Updated", tool_calls=[])

    monkeypatch.setattr(ssot_runtime, "run_ssot_turn", update)
    second = team.spawn(depends=[first["subtask_id"]])
    assert second["task_status"] == "succeeded", second
    assert team.spawn("qa_agent", review=second["subtask_id"])["task_status"] == "succeeded"
    merged = subagent.merge_subagent_result("parent-task", second["subtask_id"], "parent-ws")
    assert merged["ok"] and merged["publication_order"] > first_order
    replay = subagent.merge_subagent_result("parent-task", first["subtask_id"], "parent-ws")
    assert replay["coding"]["publication"]["publication_order"] == first_order
    assert len(verify_team("parent-ws", "parent-session", "files/data/app")["integrations"]) == 2

    extra = workspace_root("parent-ws") / "files/data/app/src/unreviewed.py"
    extra.write_text("VALUE = 'unreviewed new module'\n")
    with pytest.raises(AssertionError, match="parent source changed"):
        verify_team("parent-ws", "parent-session", "files/data/app")
    extra.unlink()

    target = workspace_root("parent-ws") / "files/data/app/src/value.py"
    target.write_text("VALUE = 'unreviewed'\n")
    with pytest.raises(AssertionError, match="parent source changed"):
        verify_team("parent-ws", "parent-session", "files/data/app")
    target.write_text("VALUE = 99\n")
    task = subagent._load_task("parent-ws", second["subtask_id"])
    task.coding["publication"]["publication_order"] = first_order
    subagent._save_task(task)
    with pytest.raises(AssertionError, match="durable journal"):
        verify_team("parent-ws", "parent-session", "files/data/app")


def test_ssot_tool_adapter_transfers_current_task_identity():
    import asyncio
    from agent.runtime.ssot_tools import _make_tool_handler
    from core.tools.schemas import ToolResult

    calls = []

    def invoke(tool_id, args, *, context):
        calls.append(context)
        return ToolResult(tool_id=tool_id, output={"ok": True})

    client = SimpleNamespace(
        canonicalize_arguments=lambda tool, args: args, invoke=invoke
    )
    handler = _make_tool_handler(
        client=client,
        tool_id="agent.manage",
        workspace_id="ws",
        session_id="session",
        run_id="run",
        trace_id="trace",
        requested_by="turn_runner",
        task_id="durable-parent",
    )
    asyncio.run(handler({"action": "list"}))
    assert calls[0].task_id == "durable-parent" and calls[0].session_id == "session"


def test_created_coding_task_can_only_start_from_its_parent(team):
    first = team.spawn()
    waiting = team.spawn(depends=[first["subtask_id"]])
    other = ToolRuntimeContext(
        workspace_id="parent-ws",
        session_id="foreign",
        task_id="foreign",
        requested_by="turn_runner",
    )
    result = team.client.invoke(
        "agent.manage",
        {"action": "start", "subtask_id": waiting["subtask_id"]},
        context=other,
    )
    assert result.status == "failed" and "coding_parent_identity_mismatch" in str(
        result.output
    )
    assert (
        subagent._load_task("parent-ws", waiting["subtask_id"]).coding["phase"]
        == "dependency_wait"
    )


def test_worker_cancellation_is_principal_scoped(team):
    from storage.principal import storage_principal
    from agent.runtime.durable.subagent_control import (
        register_parent_cancel,
        cancellation_probe,
        release_parent_cancel,
    )

    with storage_principal("alice"):
        event_a = subagent._cancel_event("same-ws", "sub-12345678")
        event_a.clear()
        register_parent_cancel("same-ws", "sub-12345678", lambda: True)
    with storage_principal("bob"):
        event_b = subagent._cancel_event("same-ws", "sub-12345678")
        assert event_a is not event_b
        assert not cancellation_probe("same-ws", "sub-12345678", event_b)()
    with storage_principal("alice"):
        assert cancellation_probe("same-ws", "sub-12345678", event_a)()
        release_parent_cancel("same-ws", "sub-12345678")
        subagent._release_worker("same-ws", "sub-12345678")
    with storage_principal("bob"):
        assert not event_b.is_set()
        subagent._release_worker("same-ws", "sub-12345678")


def test_output_contract_preserves_build_and_nested_dist_sources(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    project = project_changes.project_path("parent-ws", "files/data/app")
    project.mkdir(parents=True)
    for name in (
        "package.json",
        "build/build.js",
        "src/dist/source.js",
        "dist/generated.js",
    ):
        path = project / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{}" if name == "package.json" else "// valid source\n")
    assert set(project_changes.source_manifest(project)) == {
        "package.json",
        "build/build.js",
        "src/dist/source.js",
        "dist/generated.js",
    }
    source = project_changes.source_manifest(project, ["dist"])
    assert set(source) == {"package.json", "build/build.js", "src/dist/source.js"}
    branch = tmp_path / "candidate"
    project_changes.copy_sources(project, branch, source)
    assert (branch / "build/build.js").is_file() and not (branch / "dist").exists()
    (branch / "build/build.js").write_text("// corrected build source\n")
    output = branch / "dist/generated.js"
    output.parent.mkdir()
    output.write_text("// generated output\n")
    change = project_changes.changeset(
        source, project_changes.source_manifest(branch, ["dist"]), ["."]
    )
    result = project_changes.publish_changes(
        "parent-ws",
        "files/data/app",
        "sub-abcdef12",
        branch,
        change,
        generated_paths=["dist"],
    )
    assert result["phase"] == "integrated"
    assert (project / "build/build.js").read_text() == "// corrected build source\n"
    assert (project / "dist/generated.js").read_text() == "// valid source\n"


@pytest.mark.parametrize(
    "path",
    [".", "../outside", "/source", "package.json", "package-lock.json", "dist/*"],
)
def test_generated_paths_cannot_hide_entire_project_or_its_contract(path):
    with pytest.raises(ValueError):
        project_changes.validate_generated_paths([path])


def test_request_wait_returns_same_running_worker_without_cancelling(team, monkeypatch):
    import threading
    original_run = __import__('agent.runtime.ssot_runtime', fromlist=['run_ssot_turn']).run_ssot_turn
    entered, release = threading.Event(), threading.Event()
    def slow_run(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return original_run(*args, **kwargs)
    monkeypatch.setattr('agent.runtime.ssot_runtime.run_ssot_turn', slow_run)
    original_wait = subagent.wait_subagent_task
    monkeypatch.setattr(subagent, 'wait_subagent_task', lambda identity, ws: original_wait(identity, ws, 0.01))
    try:
        result=team.spawn()
        identity=result['subtask_id']
        assert result['task_status']=='running' and result['deferred']
        assert subagent.subagent_worker_alive('parent-ws',identity)
        assert subagent._load_task('parent-ws',identity).status=='running'
        # A 10 ms request wait can expire before worker setup reaches the
        # mocked runtime. Synchronize on entry instead of racing the scheduler.
        assert entered.wait(2)
    finally:
        release.set()
    result=original_wait(identity,'parent-ws',2)
    assert result['status']=='succeeded'
    assert subagent._load_task('parent-ws',identity).coding['phase']=='changes_ready'


def test_cancel_probe_reads_durable_marker_without_a_process_local_signal(monkeypatch,tmp_path):
    import threading
    from agent.runtime.durable.subagent_control import cancellation_probe
    monkeypatch.setenv('LZCORE_WORKSPACE_ROOT',str(tmp_path))
    created=subagent.create_subagent_task(parent_task_id='parent',workspace_id='cancel-ws',session_id='session',profile_id='research_agent',goal='read')
    identity=created['subtask_id'];event=threading.Event()
    assert not cancellation_probe('cancel-ws',identity,event)()
    task=subagent._load_task('cancel-ws',identity);task.status='cancelled';subagent._save_task(task)
    assert not event.is_set()
    assert cancellation_probe('cancel-ws',identity,event)()
    assert event.is_set()


def test_unknown_check_with_source_changes_is_never_replayed(team, monkeypatch):
    calls = []

    def execute(environment, *args, **kwargs):
        calls.append(args)
        (environment.project / 'src/value.py').write_text('VALUE = 43\n')
        return {'ok': False, 'execution_outcome': 'unknown', 'execution_may_continue': True}

    monkeypatch.setattr(DockerProjectEnvironment, 'execute', execute)
    item = team.spawn()
    task = subagent._load_task('parent-ws', item['subtask_id'])
    validation = task.coding['completion_validation']
    assert validation['source_changed_during_checks']
    assert validation['status'] == 'unknown' and not validation['automatic_retry_allowed']
    branch = project_changes.project_path(task.coding['branch_workspace'], 'files/data/app')
    (branch / 'src/value.py').write_text('VALUE = 44\n')
    assert coding_team.check_implementation(task) == validation
    assert len(calls) == 1
