from __future__ import annotations

from types import SimpleNamespace

import pytest

from extensions.approval import service as approval
from extensions.network_operations import service as network


def _setup(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setenv("LZCORE_MASTER_KEY", "test-approval-extension-master-key")


@pytest.mark.parametrize("phase", ["before_submit", "after_submit", "returned_failure", "enqueue"])
def test_continuation_failure_is_not_resumed_and_only_known_unsubmitted_work_is_retryable(monkeypatch, tmp_path, phase):
    from extensions.approval import backend
    from agent.runtime.result import AgentResult
    _setup(monkeypatch, tmp_path)
    store = approval._store("default")
    store.save("operations", "op_test", {"operation_id": "op_test", "status": "rejected",
                                        "continuation": {"checkpoint_id": "cp_test"}})
    store.save("continuations", "cp_test", {"checkpoint_id": "cp_test", "status": "waiting_decisions",
                                           "operation_ids": ["op_test"], "messages": [], "tool_calls": []})
    checkpoint = approval.claim_ready_continuation("default", "op_test")
    request_id = checkpoint["client_request_id"]
    calls = []

    class App:
        def submit_user_message(self, **kwargs):
            calls.append(kwargs)
            if phase == "after_submit":
                raise OSError("synthetic failure")
            return AgentResult(ok=False, errors=["synthetic failure"])

    def get_app():
        if phase == "before_submit":
            raise OSError("synthetic unavailable")
        return App()

    monkeypatch.setattr("agent.app.service.get_default_agent_app", get_app)
    if phase == "enqueue":
        approval.settle_continuation("default", "cp_test", result={"ok": False}, retry_safe=True)
        class FailingExecutor:
            def submit(self, *_args):
                raise RuntimeError("synthetic executor shutdown")
        monkeypatch.setattr(backend, "_CONTINUATION_EXECUTOR", FailingExecutor())
        with pytest.raises(RuntimeError):
            backend._start_ready_continuation("default", "op_test")
    else:
        backend._resume_checkpoint("default", checkpoint)
    settled = approval.get_continuation("default", "cp_test")
    assert settled["status"] == ("resuming_unknown" if phase == "after_submit" else "resume_failed")
    assert "resumed_at" not in settled
    retry = approval.claim_ready_continuation("default", "op_test")
    if phase in {"before_submit", "enqueue"}:
        assert retry and retry["client_request_id"] == request_id
        assert not calls
    else:
        assert retry is None and len(calls) == 1
    assert approval.get_operation("default", "op_test")["status"] == "rejected"


def _connection_and_skill(workspace_id: str, *, approval_enabled: bool):
    device = network.save_device(workspace_id, {
        "name": "CE-1", "host": "127.0.0.1", "vendor": "h3c",
    })
    connection = network.save_connection(workspace_id, {
        "device_id": device["device_id"], "protocol": "telnet", "port": 30001,
        "auth_method": "none",
    }, auto_test=False)
    skill = network.save_skill(workspace_id, {
        "name": "变更 Skill",
        "device_ids": [device["device_id"]],
        "connection_ids": [connection["connection_id"]],
        "approval_enabled": approval_enabled,
    })
    return device, connection, skill


def _request(workspace_id: str, skill: dict, connection: dict):
    context = network.resolve_workbench_selection(workspace_id, {"skill_id": skill["skill_id"]})
    return {
        "tool_id": "network.operations.device.manage",
        "call_id": "call_exact",
        "workspace_id": workspace_id,
        "session_id": "session_approval",
        "run_id": "run_approval",
        "arguments": {
            "action": "configure",
            "connection_id": connection["connection_id"],
            "commands": ["system-view", "interface LoopBack 100", "description exact text", "return"],
            "timeout": 31,
        },
        "workbench_context": context,
    }


def _boundary_operation(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    monkeypatch.setenv("LZCORE_OS_SECRET_STORE", "memory")
    from extensions.network_operations import device_tools
    monkeypatch.setattr(device_tools, "resolve_source_address", lambda *_: "")
    device, connection, skill = _connection_and_skill("default", approval_enabled=True)
    connection = network.save_connection("default", {
        **connection, "auth_method": "password", "username": "test-operator",
        "password": "synthetic-boundary-password-v1",
    }, auto_test=False)
    request = _request("default", skill, connection)
    record = approval.prepare_network_operation(request)
    approval.attach_continuation_checkpoint(
        "default", session_id="session", run_id="run", request_id="request",
        user_input="test", messages=[], tool_calls=[request], prior_results=[], round_results=[],
        interruption_ids=[record["operation_id"]], workbench_context=request["workbench_context"],
    )
    return device, connection, request, record


@pytest.mark.parametrize("mutation", ["host", "password", "port", "username"])
@pytest.mark.parametrize("stage", ["before_claim", "after_claim", "after_target"])
def test_approved_connection_is_bound_through_the_real_tool_pipeline(monkeypatch, tmp_path, mutation, stage):
    from flask import Flask
    from extensions.approval import backend
    from extensions.network_operations import device_tools, network_inventory

    device, connection, request, record = _boundary_operation(monkeypatch, tmp_path)
    frozen = record["target"]["connection"]
    assert frozen["revision"] and frozen["identity_digest"]
    assert "synthetic-boundary-password-v1" not in str(record)
    assert not any(key.endswith("_ref") for key in frozen)
    assert "revision" not in network.get_connection("default", connection["connection_id"])

    def change():
        if mutation == "host":
            network.save_device("default", {**device, "host": "127.0.0.2"})
        else:
            value = {"password": "synthetic-boundary-password-v2", "port": 30002,
                     "username": "different-operator"}[mutation]
            network.save_connection("default", {**connection, mutation: value}, auto_test=False)

    if stage == "before_claim":
        approval.decide_operation("default", record["operation_id"], "approve")
        change()
    elif stage == "after_claim":
        original_claim = approval.claim_execution
        def claim_then_change(*args):
            claimed = original_claim(*args)
            assert claimed["status"] == "executing"
            change()
            return claimed
        monkeypatch.setattr(approval, "claim_execution", claim_then_change)
    else:
        original_normalize = network_inventory.normalize_configuration_commands
        def normalize_then_change(*args):
            result = original_normalize(*args)
            change()
            return result
        monkeypatch.setattr(network_inventory, "normalize_configuration_commands", normalize_then_change)
    seen = []
    monkeypatch.setattr(device_tools, "probe_target", lambda *_a, **_kw: seen.append(True))
    monkeypatch.setattr(backend, "_start_ready_continuation", lambda *_: None)
    app = Flask(__name__)
    backend.register_routes(app)
    response = app.test_client().post(
        f"/api/extensions/approval/operations/{record['operation_id']}/decision?workspace_id=default",
        json={"decision": "approve"},
    )
    assert response.status_code == 409, response.get_json()
    assert seen == []
    settled = response.get_json()["operation"]
    assert settled["status"] == "invalidated", settled
    assert settled["invalidated_reason"] == "server_scope_or_connection_changed"
    current = network.get_connection_for_approval("default", connection["connection_id"])
    assert current["revision"] != frozen["revision"]
    assert current["identity_digest"] != frozen["identity_digest"]
    from extensions.network_operations.approval_binding import current_approval_binding
    assert current_approval_binding() is None


def test_unchanged_approved_connection_executes_once_with_frozen_credentials(monkeypatch, tmp_path):
    from flask import Flask
    from extensions.approval import backend
    from extensions.network_operations import device_tools
    from extensions.network_operations.approval_binding import current_approval_binding

    _, connection, request, record = _boundary_operation(monkeypatch, tmp_path)
    seen = []
    def probe(target, **kwargs):
        seen.append((target.host, target.port, target.credential.password, kwargs["commands"]))
        assert current_approval_binding().consumed
        return {"ok": True, "configuration_ok": True}
    monkeypatch.setattr(device_tools, "probe_target", probe)
    monkeypatch.setattr(backend, "_start_ready_continuation", lambda *_: None)
    app = Flask(__name__)
    backend.register_routes(app)
    url = f"/api/extensions/approval/operations/{record['operation_id']}/decision?workspace_id=default"
    response = app.test_client().post(url, json={"decision": "approve"})
    assert response.status_code == 200
    assert response.get_json()["operation"]["status"] == "executed", response.get_json()
    assert seen == [("127.0.0.1", connection["port"], "synthetic-boundary-password-v1", request["arguments"]["commands"])]
    assert current_approval_binding() is None
    app.test_client().post(url, json={"decision": "approve"})
    assert len(seen) == 1


def test_missing_connection_revision_fails_closed(monkeypatch, tmp_path):
    from extensions.network_operations import network_inventory
    _, connection, request, record = _boundary_operation(monkeypatch, tmp_path)
    store = network_inventory._store("default")
    raw = store.get("connections", connection["connection_id"])
    raw.pop("revision")
    store.save("connections", connection["connection_id"], raw)
    with pytest.raises(ValueError, match="connection_revision_missing"):
        approval.prepare_network_operation(request)
    approval.decide_operation("default", record["operation_id"], "approve")
    assert approval.claim_execution("default", record["operation_id"])["status"] == "invalidated"


@pytest.mark.parametrize("field", ["host", "port", "password_ref", "private_key_ref", "passphrase_ref"])
def test_identity_digest_covers_endpoints_and_credential_versions_without_exposing_references(monkeypatch, tmp_path, field):
    from extensions.network_operations import network_inventory
    device, connection, _, record = _boundary_operation(monkeypatch, tmp_path)
    store = network_inventory._store("default")
    collection, identifier = ("devices", device["device_id"]) if field == "host" else ("connections", connection["connection_id"])
    raw = store.get(collection, identifier)
    raw[field] = 30002 if field == "port" else "127.0.0.2" if field == "host" else "fake-replaced-credential-version"
    store.save(collection, identifier, raw)
    current = network.get_connection_for_approval("default", connection["connection_id"])
    frozen = record["target"]["connection"]
    assert current["revision"] == frozen["revision"]
    assert current["identity_digest"] != frozen["identity_digest"]
    assert "fake-replaced-credential-version" not in str(current)
    approval.decide_operation("default", record["operation_id"], "approve")
    assert approval.claim_execution("default", record["operation_id"])["status"] == "invalidated"


@pytest.mark.parametrize("field", ["revision", "identity_digest"])
def test_legacy_approvals_without_frozen_identity_fail_closed(monkeypatch, tmp_path, field):
    from extensions.approval.private_records import load_record, save_record
    _, _, _, record = _boundary_operation(monkeypatch, tmp_path)
    store = approval._store("default")
    legacy = load_record(store, "operations", record["operation_id"])
    legacy["target"]["connection"].pop(field)
    legacy["digest"] = approval._digest(approval._frozen_projection(legacy))
    save_record(store, "operations", record["operation_id"], legacy)
    approval.decide_operation("default", record["operation_id"], "approve")
    assert approval.claim_execution("default", record["operation_id"])["status"] == "invalidated"


@pytest.mark.parametrize("substitute", ["commands", "workspace", "reuse"])
def test_execution_binding_rejects_substitution_and_second_transport_call(monkeypatch, tmp_path, substitute):
    from extensions.network_operations import device_tools
    from extensions.network_operations.approval_binding import bind_approved_execution, current_approval_binding
    _, connection, request, record = _boundary_operation(monkeypatch, tmp_path)
    approval.decide_operation("default", record["operation_id"], "approve")
    claimed = approval.claim_execution("default", record["operation_id"])
    seen = []
    def probe(*_args, **_kwargs):
        seen.append(True)
        return {"ok": True}
    monkeypatch.setattr(device_tools, "probe_target", probe)
    kwargs = {"commands": request["arguments"]["commands"], "configure": True}
    with bind_approved_execution(claimed):
        if substitute == "reuse":
            assert network.test_connection("default", connection["connection_id"], **kwargs)["ok"]
        if substitute == "commands":
            kwargs["commands"] = ["reboot"]
        result = network.test_connection(
            "other-test-workspace" if substitute == "workspace" else "default",
            connection["connection_id"], **kwargs,
        )
    assert not result["ok"] and result["approval_invalidated"]
    assert len(seen) == (1 if substitute == "reuse" else 0)
    assert current_approval_binding() is None


@pytest.mark.parametrize("command", ["ping 1.1.1.1 | touch x", "display x | save", "show x | include key | write"])
def test_unknown_pipeline_cannot_skip_enabled_approval(monkeypatch, tmp_path, command):
    _setup(monkeypatch, tmp_path)
    _, connection, skill = _connection_and_skill("default", approval_enabled=True)
    request = _request("default", skill, connection)
    request["arguments"].update(action="read", commands=[command])
    record = approval.prepare_network_operation(request)
    assert record and record["status"] == "pending" and record["action"] == "configure"


def test_approval_is_absent_when_the_skill_has_not_enabled_it(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _, connection, skill = _connection_and_skill("default", approval_enabled=False)
    assert approval.prepare_network_operation(_request("default", skill, connection)) is None


def test_connection_suffix_cannot_bypass_enabled_approval(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _, connection, skill = _connection_and_skill("default", approval_enabled=True)
    request = _request("default", skill, connection)
    request["arguments"]["connection_id"] = connection["connection_id"].removeprefix("connection_")
    record = approval.prepare_network_operation(request)
    assert record is not None
    assert record["target"]["connection"]["connection_id"] == connection["connection_id"]


@pytest.mark.parametrize("initial, current", [(False, True), (True, False)])
def test_approval_uses_current_skill_setting_not_selection_snapshot(monkeypatch, tmp_path, initial, current):
    _setup(monkeypatch, tmp_path)
    _, connection, skill = _connection_and_skill("default", approval_enabled=initial)
    request = _request("default", skill, connection)
    network.save_skill("default", {**skill, "approval_enabled": current})
    record = approval.prepare_network_operation(request)
    assert (record is not None) is current


@pytest.mark.parametrize("failure_stage", ["discovery", "hook"])
def test_interceptor_failure_never_executes_the_write(monkeypatch, tmp_path, failure_stage):
    import asyncio
    from agent.llm.schemas import LLMToolCall
    from core.runtime_engine.models import SSOTRuntimeConfig, StatelessContext
    from core.runtime_engine.query_loop import StreamingToolExecutor

    _setup(monkeypatch, tmp_path)
    _, connection, skill = _connection_and_skill("default", approval_enabled=True)
    request = _request("default", skill, connection)

    def broken_hook(_request):
        raise OSError("private error details")

    def discover_hooks():
        if failure_stage == "discovery":
            raise OSError("private error details")
        return [("approval", broken_hook)]

    monkeypatch.setattr("extensions.runtime.execution_interceptors", discover_hooks)
    invoked = []

    class Runtime:
        def invoke_raw(self, tool_id, arguments):
            invoked.append(tool_id)
            return {"ok": True}

    ctx = StatelessContext(
        workspace_id="default", session_id="session_approval", request_id="request_approval",
        user_input="configure device", extras={"workbench_context": request["workbench_context"]},
    )
    result = asyncio.run(StreamingToolExecutor(Runtime(), SSOTRuntimeConfig()).execute([
        LLMToolCall(id="write", name=request["tool_id"], arguments=request["arguments"]),
    ], ctx=ctx))[0]
    assert invoked == []
    assert result.ok is False
    assert result.output["executed"] is False
    assert result.error_code == "EXECUTION_INTERCEPTOR_FAILED"
    assert "private error details" not in str(result.output)


def test_approval_actor_is_taken_from_authenticated_storage_principal(monkeypatch, tmp_path):
    from flask import Flask
    from extensions.approval.backend import register_routes
    from storage.principal import storage_principal

    _setup(monkeypatch, tmp_path)
    app = Flask(__name__)
    register_routes(app)
    with storage_principal("api-token"):
        _, connection, skill = _connection_and_skill("default", approval_enabled=True)
        record = approval.prepare_network_operation(_request("default", skill, connection))
        response = app.test_client().post(
            f"/api/extensions/approval/operations/{record['operation_id']}/decision?workspace_id=default",
            json={"decision": "reject", "decided_by": "forged-admin"},
        )
    assert response.status_code == 200
    assert response.get_json()["operation"]["decision"]["decided_by"] == "api-token"


def test_only_display_and_show_command_batches_bypass_approval(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _, connection, skill = _connection_and_skill("default", approval_enabled=True)
    request = _request("default", skill, connection)
    request["arguments"]["action"] = "read"
    request["arguments"]["commands"] = ["display current-configuration", "show interface brief"]
    assert approval.prepare_network_operation(request) is None
    request["arguments"]["commands"] = ["display version", "system-view"]
    assert approval.prepare_network_operation(request) is not None


def test_approval_freezes_exact_operation_and_revalidates_current_scope(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    device, connection, skill = _connection_and_skill("default", approval_enabled=True)
    record = approval.prepare_network_operation(_request("default", skill, connection))
    assert record is not None
    assert record["status"] == "pending"
    assert record["commands"] == ["system-view", "interface LoopBack 100", "description exact text", "return"]
    assert record["target"]["connection"]["connection_id"] == connection["connection_id"]
    assert approval.get_operation("default", record["operation_id"])["digest"] == record["digest"]

    approval.decide_operation("default", record["operation_id"], "approve")
    # A device edit changes the frozen target identity and must invalidate the
    # prepared operation before any socket can be opened.
    network.save_device("default", {**device, "name": "CE-1-renamed"})
    claimed = approval.claim_execution("default", record["operation_id"])
    assert claimed["status"] == "invalidated"
    assert claimed["invalidated_reason"] == "server_scope_or_connection_changed"


def test_approval_interceptor_returns_server_owned_interruption(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _, connection, skill = _connection_and_skill("default", approval_enabled=True)
    outcome = approval.execution_interceptor(_request("default", skill, connection))
    assert outcome and outcome["action"] == "suspend"
    assert outcome["kind"] == "approval"
    record = approval.get_operation("default", outcome["interruption_id"])
    assert record and record["digest"] == outcome["payload"]["digest"]


def test_runtime_interceptor_uses_the_enabled_extension_hook(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _, connection, skill = _connection_and_skill("default", approval_enabled=True)
    from extensions.runtime import reset_extension_cache_for_tests
    from core.runtime_engine.execution_interceptors import before_tool_execution

    reset_extension_cache_for_tests()
    request = _request("default", skill, connection)
    interception = before_tool_execution(
        tool_id=request["tool_id"], call_id=request["call_id"], arguments=request["arguments"],
        ctx=SimpleNamespace(
            workspace_id="default", session_id="session_approval", run_id="run_approval",
            request_id="request_approval", extras={"workbench_context": request["workbench_context"]},
        ),
    )
    assert interception is not None
    assert interception.kind == "approval"
    assert interception.as_tool_output()["executed"] is False


def test_external_interruption_is_a_waiting_task_not_a_completed_task():
    from agent.runtime.task_state import _derive_status

    assert _derive_status(
        {"assertions": {}, "failure": {}}, {"execution_outcome": "waiting_external_input"}, True,
    ) == ("waiting_user", "await_external_decision")


def test_approval_reject_never_claims_or_executes(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _, connection, skill = _connection_and_skill("default", approval_enabled=True)
    record = approval.prepare_network_operation(_request("default", skill, connection))
    rejected = approval.decide_operation("default", record["operation_id"], "reject")
    assert rejected["status"] == "rejected"
    with pytest.raises(ValueError, match="operation_not_approved"):
        approval.claim_execution("default", record["operation_id"])


def test_claim_execution_refuses_operations_without_a_continuation(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _, connection, skill = _connection_and_skill("default", approval_enabled=True)
    record = approval.prepare_network_operation(_request("default", skill, connection))
    approval.decide_operation("default", record["operation_id"], "approve")
    claimed = approval.claim_execution("default", record["operation_id"])
    assert claimed["status"] == "invalidated"
    assert claimed["invalidated_reason"] == "approval_checkpoint_missing"


def test_checkpoint_persist_failure_invalidates_pending_operations(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _, connection, skill = _connection_and_skill("default", approval_enabled=True)
    record = approval.prepare_network_operation(_request("default", skill, connection))
    approval.invalidate_uncheckpointed_operations("default", [record["operation_id"]])
    stored = approval.get_operation("default", record["operation_id"])
    assert stored["status"] == "invalidated"
    assert stored["invalidated_reason"] == "approval_checkpoint_persist_failed"


def test_continuation_waits_for_every_operation_and_preserves_full_checkpoint(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _, connection, skill = _connection_and_skill("default", approval_enabled=True)
    first = approval.prepare_network_operation(_request("default", skill, connection))
    second_request = _request("default", skill, connection)
    second_request["call_id"] = "call_second"
    second_request["arguments"]["commands"] = ["system-view", "interface LoopBack 200"]
    second = approval.prepare_network_operation(second_request)
    checkpoint = approval.attach_continuation_checkpoint(
        "default", session_id="session_approval", run_id="run_approval", request_id="request_approval",
        user_input="原始请求，不得截断" * 200,
        messages=[{"role": "user", "content": "完整上下文" * 1000, "tool_call_id": None, "tool_calls": None}],
        tool_calls=[{"id": "call_exact", "name": "network.operations.device.manage", "arguments": {}}, {"id": "call_second", "name": "network.operations.device.manage", "arguments": {}}],
        prior_results=[{"call_id": "old", "tool_name": "x", "output": {"full": "evidence" * 1000}, "ok": True}],
        round_results=[], interruption_ids=[first["operation_id"], second["operation_id"]],
        workbench_context={"skill_id": skill["skill_id"], "connection_ids": [connection["connection_id"]]},
    )
    assert "user_input" not in approval.get_continuation("default", checkpoint["checkpoint_id"])
    approval.decide_operation("default", first["operation_id"], "reject")
    assert approval.claim_ready_continuation("default", first["operation_id"]) is None
    approval.decide_operation("default", second["operation_id"], "cancel")
    claimed = approval.claim_ready_continuation("default", second["operation_id"])
    assert claimed and claimed["status"] == "resuming"
    assert claimed["user_input"] == "原始请求，不得截断" * 200
    assert claimed["messages"][0]["content"] == "完整上下文" * 1000
    assert approval.claim_ready_continuation("default", second["operation_id"]) is None


def test_decision_returns_the_actual_continuation_request_identity(monkeypatch, tmp_path):
    from flask import Flask
    from extensions.approval import backend
    from agent.runtime.result import AgentResult

    _setup(monkeypatch, tmp_path)
    _, connection, skill = _connection_and_skill("default", approval_enabled=True)
    operation = approval.prepare_network_operation(_request("default", skill, connection))
    checkpoint = approval.attach_continuation_checkpoint(
        "default", session_id="session_approval", run_id="old-run", request_id="old-request",
        user_input="continue the original task", messages=[], tool_calls=[], prior_results=[],
        round_results=[], interruption_ids=[operation["operation_id"]], workbench_context={},
    )
    queued = []
    submitted = []
    class DeferredExecutor:
        def submit(self, fn, *args):
            queued.append((fn, args))
    class App:
        def submit_user_message(self, **kwargs):
            submitted.append(kwargs)
            return AgentResult(ok=True, final_response="settled")
    monkeypatch.setattr(backend, "_CONTINUATION_EXECUTOR", DeferredExecutor())
    monkeypatch.setattr("agent.app.service.get_default_agent_app", lambda: App())
    app = Flask(__name__)
    backend.register_routes(app)
    url = f"/api/extensions/approval/operations/{operation['operation_id']}/decision?workspace_id=default"
    response = app.test_client().post(url, json={"decision": "reject"})
    assert response.status_code == 200
    continuation = response.json["continuation"]
    assert continuation["status"] == "resuming"
    assert continuation["session_id"] == "session_approval"
    assert continuation["client_request_id"] and continuation["client_request_id"] != "old-request"
    assert "job_id" not in continuation  # direct AgentApp execution has no Job
    stored = approval.get_continuation("default", checkpoint["checkpoint_id"])
    assert stored["client_request_id"] == continuation["client_request_id"]
    assert len(queued) == 1 and submitted == []
    fn, args = queued.pop()
    fn(*args)
    assert len(submitted) == 1
    assert submitted[0]["session_id"] == continuation["session_id"]
    assert submitted[0]["metadata"]["client_request_id"] == continuation["client_request_id"]
    settled = approval.get_continuation("default", checkpoint["checkpoint_id"])
    assert settled["status"] == "resumed" and settled["resume_result"]["ok"] is True
    # Another decision cannot enqueue another continuation for this checkpoint.
    again = app.test_client().post(url, json={"decision": "reject"})
    assert again.json["continuation"] is None and queued == []


_DEVICE_COMMAND_CASES = [
    ('username demo password 0 "synthetic approval password"', ("synthetic approval password",)),
    ("key synthetic-key-value", ("synthetic-key-value",)),
    ("tacacs-server key synthetic-tacacs", ("synthetic-tacacs",)),
    ("radius-server key 7 synthetic-radius", ("synthetic-radius",)),
    ('key-string "synthetic key string"', ("synthetic key string",)),
    ("pre-shared-key synthetic-psk", ("synthetic-psk",)),
    ("authentication-key synthetic-authentication", ("synthetic-authentication",)),
    ("ip ospf message-digest-key 1 md5 synthetic-ospf", ("synthetic-ospf",)),
    ("snmp-server user u g v3 auth sha synthetic-auth priv aes 128 synthetic-priv",
     ("synthetic-auth", "synthetic-priv")),
    ("snmp-server user u g v3 auth md5 synthetic-md5 priv des synthetic-des",
     ("synthetic-md5", "synthetic-des")),
    ("username a secret 5 synthetic-hash", ("synthetic-hash",)),
    ("snmp-server community synthetic-community", ("synthetic-community",)),
]
_QUERY_COMMANDS = [
    "show running-config | include key",
    "show key chain",
    "display current-configuration | include community",
    "display key chain",
    "  SHOW key chain",
    "ping key.example.invalid",
    "traceroute key.example.invalid",
    "tracert key.example.invalid",
]


@pytest.mark.parametrize("command,secrets", _DEVICE_COMMAND_CASES)
def test_approval_device_command_projection_masks_credentials(command, secrets):
    from extensions.approval.private_records import public_record

    raw = {"commands": [command], "digest": "synthetic-digest"}
    safe = public_record(raw)
    for secret in secrets:
        assert secret not in str(safe)
    assert safe["commands"][0].count("[REDACTED]") == len(secrets)
    assert safe["digest"] == raw["digest"]
    assert raw["commands"] == [command]
    assert public_record(safe) == safe


@pytest.mark.parametrize("keyword", [
    "key", "key-string", "pre-shared-key", "authentication-key", "password", "secret", "community",
    "ip ospf message-digest-key 1 md5", "auth sha", "priv aes 256",
])
@pytest.mark.parametrize("encryption_type", ["", "0 ", "5 ", "7 ", "8 ", "9 "])
def test_approval_device_credentials_accept_encryption_types(keyword, encryption_type):
    from extensions.approval.private_records import public_record

    command = f"{keyword} {encryption_type}'synthetic quoted credential'"
    safe = public_record({"commands": [command]})["commands"][0]
    assert "synthetic quoted credential" not in safe
    assert safe.startswith(keyword + " ")
    assert safe.count("[REDACTED]") == 1


@pytest.mark.parametrize("command", _QUERY_COMMANDS)
def test_approval_query_command_projection_preserves_filter_words(command):
    from extensions.approval.private_records import public_record

    assert public_record({"commands": [command]}) == {"commands": [command]}


def test_approval_query_commands_still_receive_general_secret_redaction():
    from extensions.approval.private_records import public_record

    command = "show key chain | include token=synthetic-filter-credential"
    assert public_record({"commands": [command]}) == {
        "commands": ["show key chain | include token=[REDACTED]"],
    }


def test_approval_device_command_projection_covers_nested_echoes_and_mapping_keys():
    from extensions.approval.private_records import public_record

    raw = {"execution": {"result": {
        "output": "show key chain\r\nkey synthetic-multiline\nshow key chain",
        "key synthetic-first": "first result",
        "key synthetic-second": "second result",
        "key [REDACTED]": "existing result",
    }}}
    safe = public_record(raw)
    assert "synthetic-" not in str(safe)
    result = safe["execution"]["result"]
    assert result["output"] == "show key chain\r\nkey [REDACTED]\nshow key chain"
    assert set(result.values()) == {
        result["output"], "first result", "second result", "existing result",
    }
    assert len(result) == 4
    assert public_record(safe) == safe
    assert "synthetic-first" in str(raw)


def _credential_operation(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    _, connection, skill = _connection_and_skill("default", approval_enabled=True)
    request = _request("default", skill, connection)
    request["arguments"]["commands"] = [command for command, _ in _DEVICE_COMMAND_CASES] + _QUERY_COMMANDS + [
        'copy https://demo:' + 'synthetic-url-password' + '@example.invalid/config',
    ]
    record = approval.prepare_network_operation(request)
    checkpoint = approval.attach_continuation_checkpoint(
        "default", session_id="session_approval", run_id="run", request_id="request",
        user_input="unlabelled synthetic approval password",
        messages=[{"role": "assistant", "content": "synthetic approval password"}],
        tool_calls=[request], prior_results=[], round_results=[],
        interruption_ids=[record["operation_id"]], workbench_context={},
    )
    return request, record, checkpoint


def test_approval_credentials_are_encrypted_and_api_projections_are_safe(monkeypatch, tmp_path):
    from flask import Flask
    from extensions.approval import backend
    from storage import secret_store

    # Exercise the real Fernet fallback, confined to tmp_path, not the keychain.
    monkeypatch.setenv("LZCORE_OS_SECRET_STORE", "off")
    monkeypatch.setenv("LZCORE_MASTER_KEY_FILE", "")
    monkeypatch.setattr(secret_store, "_path", lambda: tmp_path / "encrypted.json")
    request, record, checkpoint = _credential_operation(monkeypatch, tmp_path)
    secrets = [secret for _, values in _DEVICE_COMMAND_CASES for secret in values]
    assert all(secret not in str(record) for secret in secrets)
    assert record["commands"][-len(_QUERY_COMMANDS) - 1:-1] == _QUERY_COMMANDS
    assert record["digest"] == approval._digest({
        **approval._frozen_projection(record), "commands": request["arguments"]["commands"],
    })
    app = Flask(__name__)
    backend.register_routes(app)
    monkeypatch.setattr(backend, "_start_ready_continuation", lambda *_: None)
    client = app.test_client()
    for url in (
        "/api/extensions/approval/operations?workspace_id=default",
        f"/api/extensions/approval/operations/{record['operation_id']}?workspace_id=default",
    ):
        response = client.get(url)
        assert response.status_code == 200
        assert all(secret not in response.get_data(as_text=True) for secret in secrets)
        assert "_payload_ref" not in response.get_data(as_text=True)
    persisted = "".join(path.read_text() for path in tmp_path.rglob("*.json"))
    for secret in secrets + ["synthetic-url-password"]:
        assert secret not in persisted
    assert approval.get_operation("default", record["operation_id"])["digest"] == record["digest"]
    assert "messages" not in approval.get_continuation("default", checkpoint["checkpoint_id"])

    invoked = []
    def invoke(tool_id, arguments, **kwargs):
        invoked.append(arguments)
        return SimpleNamespace(output={"commands": arguments["commands"]}, status="succeeded", errors=[])
    monkeypatch.setattr("core.tools.integration.get_default_tool_runtime_client", lambda: SimpleNamespace(invoke=invoke))
    response = client.post(
        f"/api/extensions/approval/operations/{record['operation_id']}/decision?workspace_id=default",
        json={"decision": "approve", "note": "password synthetic-note-secret"},
    )
    assert response.status_code == 200
    assert invoked[0]["commands"] == request["arguments"]["commands"]
    assert all(secret not in response.get_data(as_text=True) for secret in secrets)
    assert "synthetic-note-secret" not in response.get_data(as_text=True)
    persisted = "".join(path.read_text() for path in tmp_path.rglob("*.json"))
    assert all(secret not in persisted for secret in secrets)
    assert "_payload_ref" not in approval._store("default").get("operations", record["operation_id"])
    resumed = approval.claim_ready_continuation("default", record["operation_id"])
    assert resumed["tool_calls"][0]["arguments"]["commands"] == request["arguments"]["commands"]
    assert resumed["messages"][0]["content"] == "synthetic approval password"
    approval.settle_continuation("default", checkpoint["checkpoint_id"], result={"ok": True})
    assert "_payload_ref" not in approval._store("default").get("continuations", checkpoint["checkpoint_id"])
    assert not __import__("json").loads((tmp_path / "encrypted.json").read_text())


@pytest.mark.parametrize("decision", ["reject", "cancel"])
def test_approval_terminal_decisions_retire_command_secret(monkeypatch, tmp_path, decision):
    from storage.secret_store import get_secret
    _, record, _ = _credential_operation(monkeypatch, tmp_path)
    stored = approval._store("default").get("operations", record["operation_id"])
    reference = stored["_payload_ref"]
    assert get_secret(reference)
    approval.decide_operation("default", record["operation_id"], decision)
    assert get_secret(reference) == ""
    assert "_payload_ref" not in approval._store("default").get("operations", record["operation_id"])


@pytest.mark.parametrize("tamper", ["secret", "digest", "display", "missing", "missing_reference"])
def test_approval_never_claims_a_changed_or_missing_frozen_payload(monkeypatch, tmp_path, tamper):
    import json
    from storage import secret_store
    _, record, _ = _credential_operation(monkeypatch, tmp_path)
    approval.decide_operation("default", record["operation_id"], "approve")
    store = approval._store("default")
    stored = store.get("operations", record["operation_id"])
    if tamper == "secret":
        envelope = json.loads(secret_store.get_secret(stored["_payload_ref"]))
        envelope["payload"]["commands"][0] = 'username demo password 0 "different synthetic password"'
        stored["_payload_ref"] = secret_store.set_secret("synthetic-altered-approval", json.dumps(envelope))
    elif tamper == "digest":
        stored["digest"] = "altered"
    elif tamper == "display":
        stored["commands"] = ["different public command"]
    elif tamper == "missing_reference":
        stored.pop("_payload_ref")
    else:
        secret_store.delete_secret(stored["_payload_ref"])
    store.save("operations", record["operation_id"], stored)
    if tamper in {"display", "missing", "missing_reference"}:
        with pytest.raises(ValueError, match="approval_payload_unavailable_or_invalid"):
            approval.claim_execution("default", record["operation_id"])
    else:
        claimed = approval.claim_execution("default", record["operation_id"])
        assert claimed["status"] == "invalidated"
        assert claimed["invalidated_reason"] == "prepared_operation_digest_mismatch"


def test_approval_failed_record_save_keeps_previous_secret(monkeypatch, tmp_path):
    from extensions.approval.private_records import load_record, save_record
    from storage.secret_store import get_secret
    _, record, _ = _credential_operation(monkeypatch, tmp_path)
    store = approval._store("default")
    original = store.get("operations", record["operation_id"])
    raw = load_record(store, "operations", record["operation_id"])
    def failed_save(*_args):
        raise OSError("synthetic disk failure")
    monkeypatch.setattr(store, "save", failed_save)
    with pytest.raises(OSError, match="synthetic disk failure"):
        save_record(store, "operations", record["operation_id"], raw)
    assert store.get("operations", record["operation_id"]) == original
    assert get_secret(original["_payload_ref"])


def test_approval_redacted_target_does_not_change_exact_digest(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    device, connection, skill = _connection_and_skill("default", approval_enabled=True)
    network.save_device("default", {**device, "name": "router password synthetic-label-secret"})
    record = approval.prepare_network_operation(_request("default", skill, connection))
    assert "synthetic-label-secret" not in str(record)
    approval.attach_continuation_checkpoint(
        "default", session_id="session", run_id="run", request_id="request",
        user_input="test", messages=[], tool_calls=[], prior_results=[], round_results=[],
        interruption_ids=[record["operation_id"]], workbench_context={},
    )
    approval.decide_operation("default", record["operation_id"], "approve")
    claimed = approval.claim_execution("default", record["operation_id"])
    assert claimed["status"] == "executing"
    assert claimed["digest"] == record["digest"] == approval._digest(approval._frozen_projection(claimed))


def test_legacy_approval_reads_are_redacted_without_rewriting_data(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    commands = [command for command, _ in _DEVICE_COMMAND_CASES] + _QUERY_COMMANDS
    legacy = {"operation_id": "legacy", "commands": commands, "status": "pending"}
    store = approval._store("default")
    store.save("operations", "legacy", legacy)
    for _, secrets in _DEVICE_COMMAND_CASES:
        for secret in secrets:
            assert secret not in str(approval.get_operation("default", "legacy"))
            assert secret not in str(approval.list_operations("default"))
    assert store.get("operations", "legacy") == legacy
    store.save("continuations", "legacy-checkpoint", {
        "checkpoint_id": "legacy-checkpoint", "messages": [{"content": "opaque synthetic credential"}],
    })
    assert "messages" not in approval.get_continuation("default", "legacy-checkpoint")


def test_approval_without_secure_storage_never_writes_plaintext(monkeypatch, tmp_path):
    from storage import secret_store
    _setup(monkeypatch, tmp_path)
    _, connection, skill = _connection_and_skill("default", approval_enabled=True)
    def unavailable(*_args):
        raise RuntimeError("No secure secret backend available")
    monkeypatch.setattr(secret_store, "set_secret", unavailable)
    with pytest.raises(RuntimeError, match="No secure secret backend available"):
        approval.prepare_network_operation(_request("default", skill, connection))
    assert approval.list_operations("default") == []
