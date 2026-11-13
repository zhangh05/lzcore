"""Credential-file failures must never initialize an existing store as empty."""

import json
import logging
from pathlib import Path

import pytest

from storage import os_secret_store, secret_store


@pytest.fixture
def secret_file(tmp_path, monkeypatch):
    path = tmp_path / "encrypted.json"
    monkeypatch.setattr(secret_store, "_path", lambda **_kwargs: path)
    monkeypatch.setenv("LZCORE_OS_SECRET_STORE", "off")
    monkeypatch.setenv("LZCORE_MASTER_KEY", "synthetic-master-key-for-tests")
    monkeypatch.setenv("LZCORE_MASTER_KEY_FILE", "")
    return path


def mutate(operation):
    if operation == "set":
        return secret_store.set_secret("new", "synthetic-new-value")
    if operation == "delete":
        return secret_store.delete_secret("secret://old")
    return secret_store._forget_file_copy("old")


@pytest.mark.parametrize("operation", ["set", "delete", "forget"])
@pytest.mark.parametrize("content", [b'{"old":', b'[]', b'null', b'"text"', b'\xff'])
def test_invalid_existing_file_rejects_mutation_without_changing_bytes(secret_file, operation, content):
    secret_file.write_bytes(content)
    with pytest.raises(RuntimeError, match="Encrypted secret store"):
        mutate(operation)
    assert secret_file.read_bytes() == content


@pytest.mark.parametrize("operation", ["set", "delete", "forget"])
def test_read_failure_preserves_entire_store(secret_file, monkeypatch, operation):
    original = b'{"old": "first-ciphertext", "other": "second-ciphertext"}'
    secret_file.write_bytes(original)
    read_text = Path.read_text

    def fail_read(path, *args, **kwargs):
        if path == secret_file:
            raise PermissionError("synthetic-sensitive-error")
        return read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", fail_read)
    with pytest.raises(RuntimeError, match="PermissionError") as error:
        mutate(operation)
    assert "synthetic-sensitive-error" not in str(error.value)
    assert secret_file.read_bytes() == original


def test_absent_file_initializes_and_mutations_preserve_other_secrets(secret_file):
    assert secret_store.get_secret("missing") == ""
    assert secret_store.delete_secret("missing") is False
    assert not secret_file.exists()
    first = secret_store.set_secret("first", "synthetic-first")
    second = secret_store.set_secret("second", "synthetic-second")
    secret_store.set_secret("first", "synthetic-updated")
    assert secret_store.get_secret(first) == "synthetic-updated"
    assert secret_store.get_secret(second) == "synthetic-second"
    assert secret_store.delete_secret(first)
    assert secret_store.get_secret(second) == "synthetic-second"
    assert set(json.loads(secret_file.read_text())) == {"second"}
    secret_store._forget_file_copy("second")
    assert json.loads(secret_file.read_text()) == {}


def test_delete_validates_file_before_removing_os_copy(secret_file, monkeypatch):
    secret_file.write_bytes(b'[]')
    monkeypatch.setenv("LZCORE_OS_SECRET_STORE", "memory")
    monkeypatch.setattr(os_secret_store, "_MEMORY", {})
    os_secret_store.set_os_secret("old", "synthetic-old")
    with pytest.raises(RuntimeError, match="JSON object"):
        secret_store.delete_secret("old")
    assert os_secret_store.get_os_secret("old") == "synthetic-old"


@pytest.mark.parametrize("failure", ["corrupt", "read", "write", "lock"])
def test_os_save_succeeds_when_file_cleanup_fails(secret_file, monkeypatch, caplog, failure):
    original = b'{broken' if failure == "corrupt" else b'{"new": "old-ciphertext", "other": "other-ciphertext"}'
    secret_file.write_bytes(original)
    monkeypatch.setenv("LZCORE_OS_SECRET_STORE", "memory")
    monkeypatch.setattr(os_secret_store, "_MEMORY", {})

    def fail(*_args, **_kwargs):
        raise PermissionError("synthetic-sensitive-error")

    if failure == "read":
        monkeypatch.setattr(Path, "read_text", fail)
    elif failure == "write":
        monkeypatch.setattr(secret_store, "atomic_write_json", fail)
    elif failure == "lock":
        monkeypatch.setattr(secret_store, "FileLock", fail)
    with caplog.at_level(logging.WARNING):
        reference = secret_store.set_secret("new", "synthetic-new")
    assert reference == "secret://new"
    assert secret_store.get_secret(reference) == "synthetic-new"
    assert secret_file.read_bytes() == original
    expected_type = "RuntimeError" if failure in {"corrupt", "read"} else "PermissionError"
    assert expected_type in caplog.text
    assert "synthetic" not in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


def test_os_save_cleans_only_matching_file_copy(secret_file, monkeypatch):
    secret_file.write_text('{"new": "old-ciphertext", "other": "other-ciphertext"}')
    monkeypatch.setenv("LZCORE_OS_SECRET_STORE", "memory")
    monkeypatch.setattr(os_secret_store, "_MEMORY", {})
    assert secret_store.set_secret("new", "synthetic-new") == "secret://new"
    assert json.loads(secret_file.read_text()) == {"other": "other-ciphertext"}
    assert os_secret_store.get_os_secret("new") == "synthetic-new"


@pytest.mark.parametrize("parent_exists", [False, True])
def test_os_save_without_file_does_not_create_directories_or_lock(tmp_path, monkeypatch, parent_exists):
    root = tmp_path / "synthetic-workspaces"
    parent = root / "_runtime" / "secrets"
    if parent_exists:
        parent.mkdir(parents=True)
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(root))
    monkeypatch.setenv("LZCORE_OS_SECRET_STORE", "memory")
    monkeypatch.setattr(os_secret_store, "_MEMORY", {})

    def forbidden(*_args, **_kwargs):
        pytest.fail("An absent file must not need a lock or file-store key")

    monkeypatch.setattr(secret_store, "FileLock", forbidden)
    monkeypatch.setattr(secret_store, "_fernet", forbidden)
    secret_store._forget_file_copy("new")
    assert secret_store.set_secret("new", "synthetic-new") == "secret://new"
    assert parent.exists() is parent_exists
    assert list(root.rglob("*")) == ([root / "_runtime", parent] if parent_exists else [])


def test_read_failure_log_does_not_include_exception_contents(secret_file, monkeypatch, caplog):
    def fail_read(_path):
        raise RuntimeError("synthetic-sensitive-error")

    monkeypatch.setattr(secret_store, "_read_encrypted", fail_read)
    with caplog.at_level(logging.WARNING):
        assert secret_store.get_secret("synthetic-sensitive-id") == ""
    assert "RuntimeError" in caplog.text
    assert "synthetic-sensitive-error" not in caplog.text
    assert "synthetic-sensitive-id" not in caplog.text
