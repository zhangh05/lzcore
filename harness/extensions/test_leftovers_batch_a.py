"""Regressions for the leftover batch: extension lifecycle, approval recovery,
location cancellation and catalog permission vocabulary."""
from __future__ import annotations

import json

import pytest


# ── Extension enable preflight and tolerant lookup ──

def _plugin(root, identifier, *, entry_source=None, min_version=""):
    source = root / identifier
    source.mkdir(parents=True)
    manifest = {"extension_id": identifier, "name": identifier, "version": "1.0.0",
                "capabilities": ["test"], "enabled": False}
    if min_version:
        manifest["min_platform_version"] = min_version
    if entry_source is not None:
        manifest["entrypoint"] = "hooks/main.py:register"
        hook = source / "hooks" / "main.py"
        hook.parent.mkdir()
        hook.write_text(entry_source)
    (source / "extension.json").write_text(json.dumps(manifest))


@pytest.fixture
def plugin_client(monkeypatch, tmp_path):
    from extensions import registry as registry_module, runtime

    root = tmp_path / "plugins"
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setenv("LZCORE_AUTH_ENABLED", "false")
    _plugin(root, "good.sample", entry_source="def register():\n    return {}\n")
    _plugin(root, "syntax.sample", entry_source="def register(:\n")
    _plugin(root, "future.sample", min_version="99.0.0")
    broken = root / "broken.sample"
    broken.mkdir()
    (broken / "extension.json").write_text("not-json")
    real = registry_module.ExtensionRegistry

    class Isolated(real):
        def __init__(self, roots=None):
            super().__init__([root])

    monkeypatch.setattr(registry_module, "ExtensionRegistry", Isolated)
    monkeypatch.setattr(runtime, "ExtensionRegistry", Isolated)
    runtime.reset_extension_cache_for_tests()
    from backend.main import create_app
    try:
        yield create_app().test_client()
    finally:
        runtime.reset_extension_cache_for_tests()


def test_enable_runs_static_preflight_without_executing_code(plugin_client):
    from extensions.state import get_extension_state

    ok = plugin_client.post("/api/extensions/good.sample/enable")
    assert ok.status_code == 200, ok.json
    assert get_extension_state("good.sample", default_enabled=False)["enabled"] is True
    bad = plugin_client.post("/api/extensions/syntax.sample/enable")
    assert bad.status_code == 422 and bad.json["stage"] == "entrypoint"
    assert get_extension_state("syntax.sample", default_enabled=False)["enabled"] is False
    old = plugin_client.post("/api/extensions/future.sample/enable")
    assert old.status_code == 422 and old.json["stage"] == "compatibility"
    assert plugin_client.post("/api/extensions/missing.sample/enable").status_code == 404


def test_cancel_is_reachable_while_disabled_but_other_routes_are_not():
    from extensions.state import is_lifecycle_exempt_cancel

    assert is_lifecycle_exempt_cancel("/api/extensions/network.operations/inspections/t1/cancel", "POST")
    assert not is_lifecycle_exempt_cancel("/api/extensions/network.operations/inspections/t1/cancel", "GET")
    assert not is_lifecycle_exempt_cancel("/api/extensions/network.operations/inspections/t1", "POST")
    assert not is_lifecycle_exempt_cancel("/api/extensions/network.operations/cancel-all/run", "POST")


def test_cancel_route_passes_disabled_gate(monkeypatch, tmp_path):
    from flask import Flask
    from extensions import runtime

    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    manifest = type("M", (), {"extension_id": "demo.sample", "enabled": False})()
    monkeypatch.setattr(runtime.ExtensionRegistry, "validate_all", lambda self: ([], [manifest]))
    app = Flask(__name__)
    view = runtime._guard_extension_route("demo.sample", lambda **_: {"ok": True}) \
        if hasattr(runtime, "_guard_extension_route") else None
    if view is None:
        pytest.skip("route guard is not exposed separately")
    app.add_url_rule("/api/extensions/demo.sample/jobs/<task_id>/cancel", "c", view, methods=["POST"])
    app.add_url_rule("/api/extensions/demo.sample/jobs/<task_id>", "r", view, methods=["POST"])
    client = app.test_client()
    assert client.post("/api/extensions/demo.sample/jobs/t1/cancel").status_code == 200
    assert client.post("/api/extensions/demo.sample/jobs/t1").status_code == 409


# ── Approval continuation crash recovery ──

def _approval_setup(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setenv("LZCORE_MASTER_KEY", "test-approval-extension-master-key")
    from extensions.approval import service as approval
    store = approval._store("default")
    store.save("operations", "op_test", {"operation_id": "op_test", "status": "rejected",
                                        "continuation": {"checkpoint_id": "cp_test"}})
    store.save("continuations", "cp_test", {"checkpoint_id": "cp_test", "status": "waiting_decisions",
                                           "operation_ids": ["op_test"], "messages": [], "tool_calls": []})
    return approval


def test_crashed_resume_owner_becomes_unknown_and_is_never_replayed(monkeypatch, tmp_path):
    approval = _approval_setup(monkeypatch, tmp_path)
    claimed = approval.claim_ready_continuation("default", "op_test")
    assert claimed["status"] == "resuming"
    # Same process still owns it: nothing changes.
    assert approval.reconcile_continuation("default", "cp_test") == "resuming"
    # Simulate a restart: new process instance, same pid reused.
    monkeypatch.setattr(approval, "_PROCESS_INSTANCE", "restarted-instance")
    assert approval.reconcile_continuation("default", "cp_test") == "resuming_unknown"
    public = approval.get_continuation("default", "cp_test")
    assert public["resume_result"]["error"] == "resume_owner_lost"
    assert "resume_owner" not in public
    assert approval.claim_ready_continuation("default", "op_test") is None


def test_live_owner_on_other_host_is_left_alone(monkeypatch, tmp_path):
    approval = _approval_setup(monkeypatch, tmp_path)
    assert approval._owner_lost({"host": "another-host", "pid": 1, "instance": "x"}) is False
    assert approval._owner_lost(None) is True
    import os
    import socket
    assert approval._owner_lost({"host": socket.gethostname(), "pid": 2 ** 22 + 12345, "instance": "gone"}) is True
    assert approval._owner_lost({"host": socket.gethostname(), "pid": os.getpid(),
                                 "instance": approval._PROCESS_INSTANCE}) is False


# ── Location resolution honours cancellation ──

def test_location_resolution_stops_when_cancelled():
    from core.resolution.location_service import LocationResolver

    calls = []

    class Provider:
        name = "synthetic"

        def search(self, query, **_):
            calls.append(query)
            return []

    resolver = LocationResolver(providers=[Provider(), Provider()])
    resolver._ensure_persistent_cache_loaded = lambda: None
    result = resolver.resolve("北京", cancel_check=lambda: True)
    assert result.status == "location_resolution_cancelled" and calls == []
    assert resolver._cache_ttl(result) == 0


def test_location_tool_passes_cancel_check(monkeypatch):
    from core.tools.general_tools import location_tools
    from core.tools.schemas import ToolInvocation

    seen = {}

    def fake_resolve(query, **kwargs):
        seen.update(kwargs)
        from core.resolution.location_service import LocationResolution
        return LocationResolution(False, query, "location_resolution_cancelled")

    monkeypatch.setattr(location_tools, "resolve_location", fake_resolve)
    probe = lambda: True  # noqa: E731
    location_tools.handle_location_manage(ToolInvocation(
        tool_id="location.manage", arguments={"action": "resolve", "query": "北京"}, cancel_check=probe,
    ))
    assert seen["cancel_check"] is probe


# ── Catalog permission vocabulary ──

def test_catalog_never_leaks_action_class_as_permission():
    from core.tools.catalog_snapshot import _action_permission, build_catalog_snapshot

    assert _action_permission("agent.manage", "start", "execute") == "exec"
    assert _action_permission("x.manage", "purge", "delete") == "write"
    assert _action_permission("x.manage", "configure", "admin") == "write"
    snapshot = build_catalog_snapshot()
    tools = snapshot.get("tools") if isinstance(snapshot, dict) else None
    assert tools
    for tool in tools:
        for profile in tool.get("action_profiles") or []:
            assert profile["permission_action"] in {"read", "write", "exec", "network"}, (tool.get("tool_id"), profile)
