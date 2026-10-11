"""exec.run shell may run on a network bind; destructive payloads stay blocked."""

from core.tools.general_tools import command_tools
from core.tools.schemas import ToolInvocation


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
