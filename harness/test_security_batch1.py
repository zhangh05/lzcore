from __future__ import annotations

import os
import pytest
from core.tools.schemas import ToolInvocation
from core.tools.general_tools.command_tools import _reject_unsafe_local_exec
from agent.modules.browser.core import _validate_browser_url, browser_evaluate


def test_destructive_shell_blocks_dangerous_commands():
    inv = ToolInvocation(
        invocation_id="call_test_1",
        tool_id="command.exec",
        arguments={"command": "rd /s /q C:\\Users"},
    )
    assert _reject_unsafe_local_exec(inv, "rd /s /q C:\\Users") is not None
    assert _reject_unsafe_local_exec(inv, "del /s /q file.txt") is not None
    assert _reject_unsafe_local_exec(inv, "erase /s /q file.txt") is not None
    assert _reject_unsafe_local_exec(inv, "Remove-Item -Recurse -Force C:\\dir") is not None
    assert _reject_unsafe_local_exec(inv, "ri -Force -Recurse C:\\dir") is not None
    assert _reject_unsafe_local_exec(inv, "rm -r -f ~") is not None
    assert _reject_unsafe_local_exec(inv, "rm -f -r /") is not None
    assert _reject_unsafe_local_exec(inv, "rm --recursive --force /tmp") is not None
    assert _reject_unsafe_local_exec(inv, "find ~ -delete") is not None
    assert _reject_unsafe_local_exec(inv, "rm -rf /") is not None


def test_destructive_shell_permits_safe_commands():
    inv = ToolInvocation(
        invocation_id="call_test_2",
        tool_id="command.exec",
        arguments={"command": "echo hello"},
    )
    assert _reject_unsafe_local_exec(inv, "echo hello") is None
    assert _reject_unsafe_local_exec(inv, "ls -la") is None
    assert _reject_unsafe_local_exec(inv, "git status") is None
    assert _reject_unsafe_local_exec(inv, "python -m pytest") is None
    assert _reject_unsafe_local_exec(inv, "cat requirements.txt") is None
    assert _reject_unsafe_local_exec(inv, "cat config/providers/minimax.json") is not None


def test_browser_url_validation_blocks_unsafe_targets():
    # File scheme
    res = _validate_browser_url("file:///etc/passwd")
    assert res is not None
    assert res.get("ok") is False

    # Loopback
    assert _validate_browser_url("http://127.0.0.1:8011/api/health") is not None
    assert _validate_browser_url("http://localhost:8011/") is not None
    assert _validate_browser_url("http://[::1]:8011/") is not None

    # Cloud metadata service (SSRF)
    assert _validate_browser_url("http://169.254.169.254/latest/meta-data/") is not None

    # Private network IP
    assert _validate_browser_url("http://192.168.1.1/admin") is not None
    assert _validate_browser_url("http://10.0.0.1/") is not None

    # .local domain
    assert _validate_browser_url("http://printer.local/") is not None

    # Schemes and mapped loopback that the literal private check used to miss
    assert _validate_browser_url("data:text/html,hi") is not None
    assert _validate_browser_url("http://[::ffff:127.0.0.1]/") is not None
    assert _validate_browser_url("http://[::ffff:169.254.169.254]/") is not None


def test_browser_url_validation_fails_closed_when_dns_cannot_be_checked(monkeypatch):
    import socket
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("dns down")))
    blocked = _validate_browser_url("https://example.com/")
    assert blocked is not None
    assert blocked.get("error") == "url_blocked"


def test_browser_evaluate_gated():
    # By default, disabled
    old_val = os.environ.get("LZCORE_BROWSER_EVALUATE_ENABLED")
    try:
        os.environ.pop("LZCORE_BROWSER_EVALUATE_ENABLED", None)
        res = browser_evaluate("window.location.href")
        assert res.get("ok") is False
        assert res.get("error") == "browser_evaluate_disabled"

        # Explicitly enabled
        os.environ["LZCORE_BROWSER_EVALUATE_ENABLED"] = "true"
        # Since playwright may not be installed/running in simple test env, calling it will reach _run
        # but shouldn't fail with browser_evaluate_disabled
        res = browser_evaluate("1 + 1")
        assert res.get("error") != "browser_evaluate_disabled"
    finally:
        if old_val is not None:
            os.environ["LZCORE_BROWSER_EVALUATE_ENABLED"] = old_val
        else:
            os.environ.pop("LZCORE_BROWSER_EVALUATE_ENABLED", None)


def test_local_browser_token_lifecycle(tmp_path, monkeypatch):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    from backend.core.local_token import local_browser_token, local_browser_token_matches

    token1 = local_browser_token()
    assert len(token1) >= 32
    # Calling it again returns the same cached/persisted token
    assert local_browser_token() == token1

    # Matching logic
    assert local_browser_token_matches(token1) is True
    assert local_browser_token_matches("wrong-token-of-same-length-------------------") is False
    assert local_browser_token_matches("") is False
    assert local_browser_token_matches("short") is False


def test_os_secret_store_memory_backend(monkeypatch):
    monkeypatch.setenv("LZCORE_OS_SECRET_STORE", "memory")
    from storage.os_secret_store import (
        available,
        backend_name,
        delete_os_secret,
        get_os_secret,
        set_os_secret,
    )
    assert available() is True
    assert backend_name() == "memory"

    # Set and get
    assert set_os_secret("test/secret/key1", "val-12345") is True
    assert get_os_secret("test/secret/key1") == "val-12345"

    # Non-existent
    assert get_os_secret("test/secret/missing") == ""

    # Delete
    assert delete_os_secret("test/secret/key1") is True
    assert get_os_secret("test/secret/key1") == ""
    assert delete_os_secret("test/secret/key1") is False


def test_atomic_replace_with_retry_succeeds_after_transient_failure(tmp_path, monkeypatch):
    from storage.atomic_io import _replace_with_retry, atomic_write_text

    target = tmp_path / "target.txt"
    tmp_file = tmp_path / "target.txt.tmp"
    atomic_write_text(tmp_file, "new content")

    calls = 0
    real_replace = os.replace

    def mock_replace(src, dst):
        nonlocal calls
        calls += 1
        if calls < 3:
            raise OSError("WinError 32: The process cannot access the file")
        return real_replace(src, dst)

    monkeypatch.setattr(os, "replace", mock_replace)
    _replace_with_retry(tmp_file, target)
    assert target.read_text(encoding="utf-8") == "new content"
    assert calls == 3

