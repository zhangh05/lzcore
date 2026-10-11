"""Invocation-level dry-run must be opt-in and side-effect free."""

from core.tools.executor import ToolExecutor
from core.tools.registry import ToolRegistry
from core.tools.schemas import ToolInvocation, ToolSpec


def test_mutating_handler_is_not_called_when_dry_run_is_not_declared():
    called = []
    registry = ToolRegistry()
    registry.register_tool(
        ToolSpec(tool_id="test.mutate", category="workspace"),
        lambda _inv: called.append(True) or {"ok": True},
    )

    result = ToolExecutor(registry).execute(ToolInvocation(
        tool_id="test.mutate", workspace_id="default", dry_run=True,
    ))

    assert result.status == "blocked"
    assert "dry_run_not_supported" in result.policy_decision.blocked_rules
    assert called == []


def test_declared_dry_run_does_not_invoke_the_mutating_handler():
    called = []
    registry = ToolRegistry()
    registry.register_tool(
        ToolSpec(tool_id="test.preview", category="workspace", dry_run_supported=True),
        lambda _inv: called.append(True) or {"ok": True, "wrote": True},
    )

    result = ToolExecutor(registry).execute(ToolInvocation(
        tool_id="test.preview", workspace_id="default", dry_run=True,
    ))

    assert result.status == "dry_run"
    assert called == []
    assert result.output.get("executed") is False


def test_canonical_tools_fail_closed_for_invocation_dry_run():
    from core.tools.canonical_registry import to_tool_specs

    specs = [spec for spec, _handler in to_tool_specs()]
    assert specs
    assert all(spec.dry_run_supported is False for spec in specs if not spec.tool_id.startswith("network."))


def test_rest_dry_run_previews_policy_without_requesting_handler_dry_run(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setenv("LZCORE_AUTH_ENABLED", "false")
    from backend.main import create_app

    from backend.core.local_token import local_browser_token
    response = create_app().test_client().post(
        "/api/tools/dry-run?workspace_id=default",
        json={"tool_id": "workspace.file", "arguments": {"action": "read", "filepath": "files/data/a.txt"}},
        headers={"Origin": "http://localhost:8011", "X-LZCore-Local-Token": local_browser_token()},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["ok"] is True
    assert body["dry_run"] is True
    assert body["handler_will_execute"] is False
    assert body["policy_decision"]["allowed"] is True


def test_executor_explicitly_blocks_dry_run_even_if_policy_allowed():
    called = []
    registry = ToolRegistry()
    registry.register_tool(
        ToolSpec(tool_id="test.mutate", category="workspace", dry_run_supported=False),
        lambda _inv: called.append(True) or {"ok": True},
    )

    class PermissivePolicy:
        def check(self, spec, invocation):
            from core.tools.schemas import PolicyDecision
            return PolicyDecision(allowed=True)

    executor = ToolExecutor(registry, policy=PermissivePolicy())
    result = executor.execute(ToolInvocation(
        tool_id="test.mutate", workspace_id="default", dry_run=True,
    ))

    assert result.status == "blocked"
    assert "dry_run not supported" in result.summary
    assert called == []

