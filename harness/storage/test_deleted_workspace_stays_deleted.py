"""A workspace deleted while background work is still running must stay deleted."""
from __future__ import annotations

import pytest

from storage.paths import workspace_root
from storage.records import append_jsonl
from storage.workspace_store import delete_workspace, ensure_workspace, update_workspace_state
from storage.workspace_tombstones import WorkspaceDeletedError


@pytest.fixture
def root(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    return tmp_path


def test_late_record_and_state_writes_do_not_recreate_deleted_workspace(root):
    ensure_workspace("gone")
    append_jsonl("gone", ("context", "items.jsonl"), {"id": 1})
    assert delete_workspace("gone")["ok"] is True

    with pytest.raises(WorkspaceDeletedError):
        append_jsonl("gone", ("context", "items.jsonl"), {"id": 2})
    with pytest.raises(WorkspaceDeletedError):
        update_workspace_state("gone", {"last_intent": "late"})
    assert not (root / "gone").exists()
    assert not (root / "catalog" / "gone").exists()


def test_explicit_create_revives_a_deleted_id(root):
    ensure_workspace("again")
    assert delete_workspace("again")["ok"] is True
    ensure_workspace("again", revive=True)
    append_jsonl("again", ("context", "items.jsonl"), {"id": 1})
    assert (workspace_root("again") / "context" / "items.jsonl").exists()


def test_background_reflection_skips_deleted_workspace(root, monkeypatch):
    from agent.runtime.memory_write import consolidator

    ensure_workspace("bye")
    assert delete_workspace("bye")["ok"] is True
    called = []
    monkeypatch.setattr(consolidator, "_consolidate_locked", lambda **kw: called.append(kw))
    out = consolidator.consolidate_experiences(workspace_id="bye", session_id="sess_1", task_id="t")
    assert out["status"] == "workspace_deleted" and not called
    assert not (root / "bye").exists()


def test_api_delete_then_create_same_id(root, monkeypatch):
    monkeypatch.delenv("LZCORE_IDENTITY_ENABLED", raising=False)
    from backend.main import create_app
    client = create_app().test_client()
    assert client.post("/api/workspaces", json={"workspace_id": "cycle"}).status_code == 200
    assert client.delete("/api/workspaces/cycle?confirm=true").get_json()["ok"] is True
    with pytest.raises(WorkspaceDeletedError):
        append_jsonl("cycle", ("usage", "token_usage.jsonl"), {"late": True})
    assert not (root / "cycle").exists()
    assert client.post("/api/workspaces", json={"workspace_id": "cycle"}).status_code == 200
    append_jsonl("cycle", ("usage", "token_usage.jsonl"), {"fresh": True})
    assert (root / "catalog" / "cycle").is_dir()


@pytest.mark.parametrize("restart", [False, True])
def test_user_memory_from_deleted_workspace_does_not_recreate_it(root, restart):
    from storage.memory_governance import MemoryRecord, MemoryStore, MemoryWriteGate, expire_memory
    from storage.workspace_tombstones import reset

    ensure_workspace("origin")
    ensure_workspace("other")
    record = MemoryRecord(workspace_id="origin", scope="global", memory_type="profile",
                          source="user", status="active", content="常驻城市：杭州")
    assert MemoryWriteGate().write(record)["ok"] is True
    assert delete_workspace("origin")["ok"] is True
    if restart:
        reset()  # a new server process no longer remembers the deletion

    # The memory is user-level, so it is still visible and can be retired
    # from another workspace without bringing "origin" back.
    assert MemoryStore().get("other", record.memory_id) is not None
    assert expire_memory("origin", record.memory_id)["ok"] is True
    assert not (root / "origin").exists()
    assert not (root / "catalog" / "origin").exists()
