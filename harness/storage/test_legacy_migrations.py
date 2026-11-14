"""Startup migrations for pre-isolation data: approval payloads, extension
secret references, the API-token storage root and workspace display names."""
from __future__ import annotations

import json

import pytest


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LZCORE_MASTER_KEY", "legacy-migration-synthetic-master-key")
    monkeypatch.setenv("LZCORE_MASTER_KEY_FILE", "")
    monkeypatch.setenv("LZCORE_OS_SECRET_STORE", "memory")
    monkeypatch.delenv("LZCORE_LOGIN_USERNAME", raising=False)
    for flag in ("LZCORE_IDENTITY_ENABLED", "LZCORE_AUTH_ENABLED", "LZCORE_LOGIN_ENABLED"):
        monkeypatch.setenv(flag, "false")
    from storage import os_secret_store
    monkeypatch.setattr(os_secret_store, "_MEMORY", {})
    return tmp_path


# ── approval plaintext ──

def test_legacy_approval_records_move_payload_into_secret_store(isolated):
    from extensions.approval import service as approval

    store = approval._store("default")
    frozen = {key: "" for key in approval.FROZEN_OPERATION_FIELDS}
    frozen.update({"tool_id": "network.exec", "workspace_id": "default", "timeout": 30,
                   "commands": ["password hunter2-legacy"]})
    store.save("operations", "op_live", {"operation_id": "op_live", "status": "pending", **frozen})
    store.save("operations", "op_done", {"operation_id": "op_done", "status": "executed",
                                        "commands": ["password done-secret"]})
    store.save("continuations", "cp_1", {"checkpoint_id": "cp_1", "status": "waiting_decisions",
                                         "user_input": "token sk-legacyinput123456", "messages": []})
    result = approval.migrate_legacy_records("default")
    assert result == {"migrated": 3, "failed": 0}
    raw = "".join(p.read_text() for p in store.root().rglob("*.json"))
    for secret in ("hunter2-legacy", "done-secret", "sk-legacyinput123456"):
        assert secret not in raw
    live = approval.load_record(store, "operations", "op_live")
    assert live["commands"] == ["password hunter2-legacy"]
    assert approval.load_record(store, "continuations", "cp_1")["user_input"] == "token sk-legacyinput123456"
    assert approval.migrate_legacy_records("default") == {"migrated": 0, "failed": 0}


def test_approval_migration_leaves_record_when_secret_store_unavailable(isolated, monkeypatch):
    from extensions.approval import service as approval
    from extensions.approval import private_records

    store = approval._store("default")
    store.save("operations", "op_x", {"operation_id": "op_x", "status": "pending", "commands": ["show run"]})

    def broken(*_a, **_k):
        raise RuntimeError("no secure backend")

    monkeypatch.setattr(private_records.secret_store, "set_secret", broken)
    assert approval.migrate_legacy_records("default") == {"migrated": 0, "failed": 1}
    assert store.get("operations", "op_x")["commands"] == ["show run"]


# ── extension secret references ──

def _connection(principal, workspace, ref):
    from extensions.sdk import ExtensionDataStore
    from storage.principal import storage_principal
    with storage_principal(principal):
        ExtensionDataStore("network.operations", workspace).save(
            "connections", "c1", {"connection_id": "c1", "password_ref": ref})


def test_single_owner_legacy_extension_secret_is_rekeyed(isolated, monkeypatch):
    from extensions import sdk
    from storage import secret_store
    from storage.principal import storage_principal

    monkeypatch.setattr("storage.principal.known_storage_principals", lambda: ["alice", "bob"])
    monkeypatch.setattr("storage.workspace_store.list_workspace_ids", lambda include_system=False: ["team"])
    legacy = secret_store.set_secret("extension/network_operations/team/pw", "synthetic-device-pw")
    shared = secret_store.set_secret("extension/network_operations/team/shared", "shared-pw")
    _connection("alice", "team", legacy)
    from extensions.sdk import ExtensionDataStore
    with storage_principal("alice"):
        ExtensionDataStore("network.operations", "team").save(
            "connections", "c2", {"connection_id": "c2", "password_ref": shared})
    with storage_principal("bob"):
        ExtensionDataStore("network.operations", "team").save(
            "connections", "c2", {"connection_id": "c2", "password_ref": shared})

    result = sdk.migrate_legacy_extension_secrets()
    assert result == {"migrated": 1, "ambiguous": 1, "failed": 0}
    with storage_principal("alice"):
        record = ExtensionDataStore("network.operations", "team").get("connections", "c1")
        assert record["password_ref"].startswith("secret://extension-v2/")
        assert sdk.ExtensionSecretStore("network.operations", "team").get(record["password_ref"]) == "synthetic-device-pw"
    assert secret_store._read_secret("extension/network_operations/team/pw") == ""
    # Shared reference stays untouched and still cannot be claimed.
    assert secret_store._read_secret("extension/network_operations/team/shared") == "shared-pw"
    with storage_principal("bob"):
        assert ExtensionDataStore("network.operations", "team").get("connections", "c2")["password_ref"] == shared


# ── API token storage root ──

def test_api_token_keeps_pre_split_storage_root(isolated, monkeypatch):
    from backend.core.identity import _bootstrap_storage_id, api_token_storage_id
    from storage.principal import principal_storage_key

    legacy = _bootstrap_storage_id("api-token")
    current = _bootstrap_storage_id("service/api-token")
    assert api_token_storage_id() == current
    (isolated / "users" / legacy / "workspaces" / "default").mkdir(parents=True)
    assert api_token_storage_id() == legacy == principal_storage_key("api-token")
    # A login administrator literally named api-token owns that legacy root.
    monkeypatch.setenv("LZCORE_LOGIN_USERNAME", "API-Token")
    assert api_token_storage_id() == current
    monkeypatch.delenv("LZCORE_LOGIN_USERNAME")
    (isolated / "users" / current).mkdir(parents=True)
    assert api_token_storage_id() == current


# ── workspace display name ──

def test_workspace_display_name_rename_keeps_id(isolated):
    from storage.workspace_store import ensure_workspace, list_workspaces, set_workspace_display_name

    ensure_workspace("core-net")
    assert set_workspace_display_name("core-net", "  核心网巡检 ")["ok"]
    listed = {w["workspace_id"]: w for w in list_workspaces()}
    assert listed["core-net"]["name"] == "核心网巡检"
    assert not set_workspace_display_name("core-net", "")["ok"]
    assert not set_workspace_display_name("core-net", "x" * 65)["ok"]
    assert not set_workspace_display_name("missing-ws", "名字")["ok"]


def test_rename_route_accepts_display_name(isolated):
    from backend.main import create_app
    from storage.workspace_store import ensure_workspace

    ensure_workspace("core-net")
    client = create_app().test_client()
    response = client.post("/api/workspaces/core-net/rename", json={"name": "核心网"})
    assert response.status_code == 200 and response.json["name"] == "核心网"
    moved = client.post("/api/workspaces/core-net/rename", json={"new_workspace_id": "other"})
    assert moved.json["error"] == "workspace_id_rename_requires_offline_migration"
