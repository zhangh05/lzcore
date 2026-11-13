"""Credential APIs use subprocess substitutes and temporary filesystem data."""

import logging
import os
import stat
import subprocess
from types import SimpleNamespace

import pytest

from storage import os_secret_store as store


@pytest.fixture
def keychain(monkeypatch):
    tool = SimpleNamespace(values={"synthetic_id": "synthetic-old"}, calls=[],
                           write_status=0, command_fails=False, find_status=None,
                           delete_status=0)

    def run(argv, **kwargs):
        tool.calls.append((argv, kwargs))
        assert kwargs["capture_output"] is True
        assert kwargs["text"] is True
        assert kwargs["timeout"] == 8
        assert "shell" not in kwargs
        if argv == ["security", "-i"]:
            parts = kwargs["input"].split()
            assert parts[:5] == ["add-generic-password", "-U", "-s", "lzcore.secret", "-a"]
            assert parts[6] == "-X"
            if not tool.command_fails and tool.write_status == 0:
                tool.values[parts[5]] = bytes.fromhex(parts[7]).decode("utf-8")
            return SimpleNamespace(returncode=tool.write_status,
                                   stdout="synthetic-sensitive-output", stderr="synthetic-sensitive-error")
        assert argv[:2] in (["security", "find-generic-password"],
                            ["security", "delete-generic-password"])
        assert "input" not in kwargs
        account = argv[5]
        if argv[1] == "find-generic-password":
            status = tool.find_status if tool.find_status is not None else (0 if account in tool.values else 44)
            return SimpleNamespace(returncode=status, stdout=tool.values.get(account, "") + "\n",
                                   stderr="synthetic-sensitive-error")
        status = tool.delete_status if account in tool.values else 44
        if status == 0:
            del tool.values[account]
        return SimpleNamespace(returncode=status, stdout="synthetic-sensitive-output",
                               stderr="synthetic-sensitive-error")

    monkeypatch.setattr(store.subprocess, "run", run)
    return tool


@pytest.mark.parametrize("initial", [None, "synthetic-old"])
def test_keychain_write_uses_hex_stdin_and_updates_without_delete(keychain, initial):
    keychain.values = {} if initial is None else {"synthetic_id": initial}
    value = 'synthetic-密钥 "quoted" \\ $variable\nsecond line\x00tail'
    assert store._keychain_set("synthetic/id", value)
    assert keychain.values["synthetic_id"] == value
    assert [argv[:2] for argv, _ in keychain.calls] == [
        ["security", "-i"], ["security", "find-generic-password"],
    ]
    assert keychain.calls[0][1]["input"] == (
        "add-generic-password -U -s lzcore.secret -a synthetic_id -X " + value.encode("utf-8").hex() + "\n"
    )
    assert all(value not in str(argv) for argv, _ in keychain.calls)
    assert value not in keychain.calls[0][1]["input"]


@pytest.mark.parametrize("failure", ["process", "interactive", "readback"])
def test_keychain_failed_write_or_readback_is_not_success(keychain, caplog, failure):
    if failure == "process":
        keychain.write_status = 1
    elif failure == "interactive":
        keychain.command_fails = True  # security -i itself still returns zero.
        keychain.values["synthetic|id"] = "synthetic-new"
    else:
        keychain.find_status = 36
    assert store._keychain_set("synthetic/id", "synthetic-new") is False
    assert all(argv[1] != "delete-generic-password" for argv, _ in keychain.calls)
    if failure != "readback":
        assert keychain.values["synthetic_id"] == "synthetic-old"
    assert "synthetic" not in caplog.text
    assert "Keychain" in caplog.text


@pytest.mark.parametrize("account", ["bad name", "bad\ninjected-command", "bad;command", ""])
def test_keychain_rejects_invalid_interactive_account(keychain, monkeypatch, caplog, account):
    monkeypatch.setattr(store, "_account", lambda _id: account)
    assert store._keychain_set("synthetic/id", "synthetic-value") is False
    assert keychain.calls == []
    assert "ValueError" in caplog.text
    assert "synthetic" not in caplog.text


@pytest.mark.parametrize("operation", ["set", "verify", "get", "delete"])
@pytest.mark.parametrize("error_type", [subprocess.TimeoutExpired, subprocess.CalledProcessError])
def test_keychain_exception_logs_exclude_commands_and_values(monkeypatch, caplog, operation, error_type):
    def fail(argv, **_kwargs):
        if operation == "verify" and argv == ["security", "-i"]:
            return SimpleNamespace(returncode=0)
        if error_type is subprocess.TimeoutExpired:
            raise error_type(["security", "synthetic-secret-in-command"], 8,
                             output="synthetic-sensitive-output", stderr="synthetic-sensitive-error")
        raise error_type(1, ["security", "synthetic-secret-in-command"],
                         output="synthetic-sensitive-output", stderr="synthetic-sensitive-error")

    monkeypatch.setattr(store.subprocess, "run", fail)
    with caplog.at_level(logging.WARNING):
        if operation in {"set", "verify"}:
            assert store._keychain_set("synthetic-sensitive-id", "synthetic-value") is False
        else:
            result = getattr(store, f"_keychain_{operation}")("synthetic-sensitive-id")
            assert result == ("" if operation == "get" else False)
    assert error_type.__name__ in caplog.text
    assert "synthetic" not in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


@pytest.mark.parametrize("accounts", [("synthetic_id",), ("synthetic|id",), ("synthetic_id", "synthetic|id")])
def test_keychain_read_delete_preserve_legacy_accounts(keychain, accounts):
    keychain.values = dict.fromkeys(accounts, "synthetic-value")
    assert store._keychain_get("synthetic/id") == "synthetic-value"
    assert store._keychain_delete("synthetic/id") is True
    assert keychain.values == {}
    assert store._keychain_get("synthetic/id") == ""
    assert store._keychain_delete("synthetic/id") is False
    assert all("synthetic-value" not in str(argv) for argv, _ in keychain.calls)


@pytest.mark.parametrize("operation", ["get", "delete"])
def test_keychain_failure_logs_only_return_code(keychain, caplog, operation):
    keychain.find_status = keychain.delete_status = 36
    result = getattr(store, f"_keychain_{operation}")("synthetic/id")
    assert result == ("" if operation == "get" else False)
    assert keychain.values["synthetic_id"] == "synthetic-old"
    assert "returncode=36" in caplog.text
    assert "synthetic" not in caplog.text


@pytest.fixture
def dpapi_file(tmp_path, monkeypatch):
    path = tmp_path / "synthetic.bin"
    path.write_bytes(b"old-ciphertext")
    monkeypatch.setattr(store, "_dpapi_path", lambda _id: path)
    monkeypatch.setattr(store, "_dpapi_protect", lambda _value: b"new-ciphertext")
    return path


@pytest.mark.parametrize("stage", ["protect", "write", "fsync", "replace"])
def test_dpapi_failed_update_preserves_previous_blob(dpapi_file, monkeypatch, caplog, stage):
    def fail(*_args, **_kwargs):
        raise OSError("synthetic-sensitive-error")

    if stage == "protect":
        monkeypatch.setattr(store, "_dpapi_protect", fail)
    elif stage == "write":
        fdopen = os.fdopen

        class BrokenWriter:
            def __init__(self, fd, mode):
                self.handle = fdopen(fd, mode)
            def __enter__(self):
                return self
            def __exit__(self, *_):
                self.handle.close()
            def write(self, data):
                self.handle.write(data[:3])
                fail()

        monkeypatch.setattr(store.os, "fdopen", BrokenWriter)
    else:
        monkeypatch.setattr(store.os, stage, fail)
    assert not store._dpapi_set("synthetic-sensitive-id", "synthetic-value")
    assert dpapi_file.read_bytes() == b"old-ciphertext"
    assert list(dpapi_file.parent.iterdir()) == [dpapi_file]
    assert "OSError" in caplog.text
    assert "synthetic" not in caplog.text


def test_dpapi_success_replaces_only_after_fsync(dpapi_file, monkeypatch):
    fsync, replace = os.fsync, os.replace
    events = []

    def synced(fd):
        assert dpapi_file.read_bytes() == b"old-ciphertext"
        events.append("fsync")
        fsync(fd)

    def publish(source, target):
        assert events == ["fsync"]
        if os.name != "nt":
            assert stat.S_IMODE(os.stat(source).st_mode) == 0o600
        assert dpapi_file.read_bytes() == b"old-ciphertext"
        replace(source, target)

    monkeypatch.setattr(store.os, "fsync", synced)
    monkeypatch.setattr(store.os, "replace", publish)
    assert store._dpapi_set("synthetic/id", "synthetic-value")
    assert dpapi_file.read_bytes() == b"new-ciphertext"
    assert list(dpapi_file.parent.iterdir()) == [dpapi_file]


@pytest.mark.parametrize("operation", ["get", "delete", "protect", "unprotect"])
def test_dpapi_exception_logs_exclude_sensitive_messages(monkeypatch, caplog, operation):
    def fail(*_args, **_kwargs):
        raise OSError("synthetic-sensitive-error")

    if operation in {"get", "delete"}:
        monkeypatch.setattr(store, "_dpapi_path", fail)
        args = ("synthetic-sensitive-id",)
    else:
        monkeypatch.setattr(store.sys, "platform", "win32")
        monkeypatch.setattr(store, "_get_crypt32", fail)
        args = (b"synthetic-value",)
    with caplog.at_level(logging.WARNING):
        getattr(store, f"_dpapi_{operation}")(*args)
    assert "OSError" in caplog.text
    assert "synthetic" not in caplog.text
