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
