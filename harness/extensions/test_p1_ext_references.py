from __future__ import annotations

import pytest

from extensions.network_operations import network_observations as observations


class MemoryStore:
    def __init__(self):
        self.records = {"observations": {"o1": {"observation_id": "o1"}}, "references": {}}
        self.fail_delete = False

    def get(self, collection, key):
        value = self.records.get(collection, {}).get(key)
        return dict(value) if value else None

    def list(self, collection, *, limit=200):
        return list(self.records.get(collection, {}).values())[:limit]

    def save(self, collection, key, value):
        self.records.setdefault(collection, {})[key] = dict(value)

    def delete(self, collection, key):
        if self.fail_delete:
            return False
        return self.records[collection].pop(key, None) is not None


@pytest.fixture
def store(monkeypatch, tmp_path):
    from contextlib import nullcontext
    from extensions.network_operations import network_records
    store = MemoryStore()
    monkeypatch.setattr(observations, "_store", lambda *_: store)
    monkeypatch.setattr(network_records, "_connection_lock", lambda *_: nullcontext())
    for index in range(501):
        key = f"r{index}"
        store.save("references", key, {"reference_id": key, "source_observation_ids": ["o1"] if index == 500 else [],
                                      "scope_key": "scope", "state": "confirmed", "current": True})
    return store


@pytest.mark.parametrize("batch", [False, True])
def test_deleting_observation_removes_old_dependency_beyond_display_limit(store, batch):
    assert len(observations.list_references("ws", limit=5000)) == 500
    result = (observations.delete_observations("ws", ["o1"]) if batch
              else observations.delete_observation("ws", "o1"))
    assert result["deleted_dependent_references"] == 1
    assert store.get("references", "r500") is None
    assert store.get("observations", "o1") is None


def test_confirmation_supersedes_all_old_current_references(store):
    store.save("references", "candidate", {"reference_id": "candidate", "scope_key": "scope",
                                          "state": "candidate", "completeness": "complete",
                                          "source_observation_ids": ["o1"]})
    result = observations.transition_reference("ws", "candidate", "confirm")
    assert result["current"] is True
    assert all(not item["current"] for item in store.list("references", limit=None) if item["reference_id"] != "candidate")


def test_failed_dependency_delete_preserves_observation(store):
    store.fail_delete = True
    with pytest.raises(RuntimeError, match="reference_delete_failed"):
        observations.delete_observation("ws", "o1")
    assert store.get("observations", "o1")
