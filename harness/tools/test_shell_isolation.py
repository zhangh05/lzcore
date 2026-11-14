"""exec.run shell may run on a network bind; destructive payloads stay blocked."""

from core.tools.general_tools import command_tools
from core.tools.schemas import ToolInvocation
import pytest


@pytest.fixture(autouse=True)
def personal_mode(monkeypatch):
    for key in ("LZCORE_AUTH_ENABLED", "LZCORE_IDENTITY_ENABLED", "LZCORE_OIDC_ENABLED",
                "LZCORE_LOGIN_ENABLED", "LZCORE_LOGIN_USERNAME", "LZCORE_LOGIN_PASSWORD",
                "LZCORE_LOGIN_PASSWORD_FILE", "LZCORE_PYTHON_REQUIRE_STRONG_ISOLATION"):
        monkeypatch.delenv(key, raising=False)


def _shell(command: str, **kwargs) -> dict:
    arguments = {"action": "shell", "command": command, **kwargs}
    return command_tools.handle_command_exec(ToolInvocation(
        tool_id="exec.run",
        workspace_id="test_ws",
        arguments=arguments,
    ))


def test_non_loopback_runtime_still_runs_non_destructive_shell(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LZCORE_RUNTIME_BIND_HOST", "0.0.0.0")
    monkeypatch.delenv("LZCORE_TRUSTED_LOCAL_PYTHON_EXECUTION", raising=False)
    from storage.paths import ensure_workspace_storage_dirs

    ensure_workspace_storage_dirs("test_ws")
    result = _shell("echo allowed-on-lan")
    assert result.get("ok") is True
    assert "allowed-on-lan" in str(result.get("summary") or result.get("stdout") or result)


def test_destructive_shell_is_blocked_on_loopback(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LZCORE_RUNTIME_BIND_HOST", "127.0.0.1")
    from storage.paths import ensure_workspace_storage_dirs

    ensure_workspace_storage_dirs("test_ws")
    result = _shell("rm -rf /")
    assert result.get("ok") is False
    assert "destructive" in str(result.get("error") or result).lower()


def test_powershell_working_dir_stays_in_workspace(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LZCORE_RUNTIME_BIND_HOST", "127.0.0.1")
    monkeypatch.setattr("platform.system", lambda: "Windows")
    result = command_tools.handle_powershell_script(ToolInvocation(
        tool_id="exec.run",
        workspace_id="test_ws",
        arguments={"command": "Get-Date", "working_dir": "C:\\"},
    ))
    assert result.get("ok") is False


@pytest.mark.parametrize("mode", [
    {"LZCORE_AUTH_ENABLED": "true"}, {"LZCORE_IDENTITY_ENABLED": "true"},
    {"LZCORE_OIDC_ENABLED": "true"}, {"LZCORE_LOGIN_ENABLED": "true"},
    {"LZCORE_LOGIN_USERNAME": "synthetic", "LZCORE_LOGIN_PASSWORD": "synthetic-password"},
    {"LZCORE_LOGIN_USERNAME": "synthetic", "LZCORE_LOGIN_PASSWORD_FILE": "/unused/synthetic-secret"},
    {"LZCORE_PYTHON_REQUIRE_STRONG_ISOLATION": "true"},
])
@pytest.mark.parametrize("host", ["127.0.0.1", "0.0.0.0"])
@pytest.mark.parametrize("handler", ["handle_command_exec", "handle_powershell_script"])
def test_authenticated_shell_never_starts_host_process(monkeypatch, tmp_path, mode, host, handler):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LZCORE_RUNTIME_BIND_HOST", host)
    monkeypatch.setenv("LZCORE_TRUSTED_LOCAL_PYTHON_EXECUTION", "true")
    for key, value in mode.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr("subprocess.Popen", lambda *a, **kw: pytest.fail("host process started"))
    monkeypatch.setattr("subprocess.run", lambda *a, **kw: pytest.fail("host process started"))
    result = getattr(command_tools, handler)(ToolInvocation(
        tool_id="exec.run", workspace_id="test_ws", arguments={"command": "echo synthetic"},
    ))
    assert result["ok"] is False
    assert "execution_requires_strong_isolation" in str(result)


@pytest.mark.parametrize("state", ["ready", "closed", "not_started", "missing_image", "untrusted_type", "runner_failure"])
def test_authenticated_shell_requires_live_typed_binding_and_never_falls_back(monkeypatch, tmp_path, state):
    from core.tools import project_execution as execution
    from storage.paths import workspace_root
    from types import SimpleNamespace

    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LZCORE_AUTH_ENABLED", "true")
    monkeypatch.setattr(execution, "_client_configuration", lambda: (["fake-docker"], {}))
    project = workspace_root("test_ws") / "files" / "data" / "project"
    environment = execution.DockerProjectEnvironment("test_ws", project, 18080)
    environment.started = state != "not_started"
    environment.closed = state == "closed"
    environment.image_id = "" if state == "missing_image" else "sha256:" + "a" * 64
    calls = []
    def execute(command, **kwargs):
        calls.append((command, kwargs))
        return {"ok": state != "runner_failure", "stdout": "container", "error": "failed" if state == "runner_failure" else ""}
    monkeypatch.setattr(environment, "execute", execute)
    if state == "untrusted_type":
        environment = SimpleNamespace(started=True, closed=False, image_id="fake", project=project, execute=execute)
    monkeypatch.setattr(execution, "environment_for", lambda ws: environment)
    monkeypatch.setattr(command_tools, "_run_shell", lambda *a, **kw: pytest.fail("host fallback"))
    result = _shell("echo synthetic")
    assert result["ok"] is (state == "ready")
    assert bool(calls) is (state in {"ready", "runner_failure"})


def test_python_personal_mode_does_not_infer_tenancy_from_listener(monkeypatch):
    from core.tools.python_runner import BestEffortPythonRunner, select_python_runner
    monkeypatch.setenv("LZCORE_RUNTIME_BIND_HOST", "0.0.0.0")
    monkeypatch.setenv("LZCORE_TRUSTED_LOCAL_PYTHON_EXECUTION", "true")
    assert isinstance(select_python_runner(), BestEffortPythonRunner)
