"""MCP protocol-level failures must not become successful tool calls."""

from types import SimpleNamespace

from core.tools.general_tools.skill_tools import handle_mcp_call
from core.tools.schemas import ToolInvocation


def test_mcp_is_error_result_is_reported_as_tool_failure(monkeypatch):
    provider = SimpleNamespace(
        provider_id="test", provider_type="mcp", status="enabled",
        trust_level="local", command=("unused",), root_path="", permissions=[],
        tools=[{"name": "inspect", "enabled": True}],
    )
    monkeypatch.setattr("core.tools.general_tools.skill_tools._mcp_provider", lambda _inv: provider)

    class _Client:
        def __init__(self, *_args, **_kwargs): pass
        def __enter__(self): return self
        def __exit__(self, *_args): return None
        def call_tool(self, *_args, **_kwargs):
            return {"isError": True, "content": [{"type": "text", "text": "device unavailable"}]}

    monkeypatch.setattr("core.tools.mcp_client.StdioMcpClient", _Client)
    result = handle_mcp_call(ToolInvocation(
        tool_id="skill.manage", workspace_id="ws_mcp", 
        arguments={"action": "mcp_call", "provider_id": "test", "tool_name": "inspect"},
    ))
    assert result["ok"] is False
    assert "device unavailable" in result["error"]


def test_mcp_subprocess_inherits_only_safe_environment_and_explicit_config(monkeypatch):
    from unittest.mock import Mock
    from core.tools import mcp_client

    safe = {
        "PATH": "/synthetic/bin", "HOME": "/synthetic/home", "USER": "tester",
        "LANG": "zh_CN.UTF-8", "LC_CTYPE": "UTF-8", "LC_MESSAGES": "C",
        "TMPDIR": "/synthetic/tmp", "TEMP": "/synthetic/temp", "TMP": "/synthetic/tmp",
        "SYSTEMROOT": "C:\\Windows", "WINDIR": "C:\\Windows",
        "APPDATA": "C:\\synthetic\\app", "LOCALAPPDATA": "C:\\synthetic\\local",
        "USERPROFILE": "C:\\synthetic", "COMSPEC": "cmd.exe", "PATHEXT": ".EXE;.CMD",
        "SHELL": "/synthetic/bin/zsh", "LOGNAME": "tester",
        "SSL_CERT_FILE": "/synthetic/ca.pem", "SSL_CERT_DIR": "/synthetic/certs",
        "REQUESTS_CA_BUNDLE": "/synthetic/requests-ca.pem",
        "NODE_EXTRA_CA_CERTS": "/synthetic/node-ca.pem",
    }
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"):
        safe[name] = "http://synthetic-user:synthetic-password@proxy.invalid:8080"
        safe[name.lower()] = "http://synthetic-user:synthetic-token@proxy.invalid:8081"
    blocked = {
        "LZCORE_MASTER_KEY": "synthetic-master", "LZCORE_DATA_DIR": "/synthetic/data",
        "API_KEY": "synthetic-key", "ACCESS_TOKEN": "synthetic-token",
        "SECRET": "synthetic-secret", "PASSWORD": "synthetic-password",
        "LC_API_KEY": "synthetic-locale-key", "lc_token": "synthetic-locale-token",
        "LC_SECRET": "synthetic-locale-secret", "LC_PASSWORD": "synthetic-locale-password",
        "PYTHONPATH": "/synthetic/injection", "LD_PRELOAD": "/synthetic/injection.so",
        "https_proxy_password": "synthetic-proxy-password",
        "HTTP_PROXY_KEY": "synthetic-proxy-key", "HTTPS_PROXY_TOKEN": "synthetic-proxy-token",
        "all_proxy_secret": "synthetic-proxy-secret", "lzcore_https_proxy": "synthetic-internal-proxy",
        "UNRELATED": "synthetic-other",
    }
    monkeypatch.setattr(mcp_client.os, "environ", {**safe, **blocked})
    popen = Mock()
    monkeypatch.setattr(mcp_client.subprocess, "Popen", popen)
    monkeypatch.setattr(mcp_client.StdioMcpClient, "request", lambda *_a, **_k: {})
    monkeypatch.setattr(mcp_client.StdioMcpClient, "notify", lambda *_a, **_k: None)
    explicit = {"ACCESS_TOKEN": "synthetic-explicit", "LZCORE_EXPLICIT": "synthetic-config",
                "PATH": "/synthetic/custom-bin", "PYTHONIOENCODING": "ascii",
                "HTTP_PROXY": "http://explicit.invalid:8080", "no_proxy": "localhost"}
    client = mcp_client.StdioMcpClient(mcp_client.McpServerConfig("synthetic", ("unused",), env=explicit))
    client.__enter__()
    assert popen.call_args.kwargs["env"] == {**safe, **explicit, "PYTHONIOENCODING": "utf-8"}
    assert explicit["PYTHONIOENCODING"] == "ascii"
    # Without explicit configuration even platform-prefixed variables stay out.
    assert mcp_client._subprocess_env(None) == {**safe, "PYTHONIOENCODING": "utf-8"}
