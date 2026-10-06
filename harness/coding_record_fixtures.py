"""Inject storage corruption, bypassing domain APIs, for fail-closed tests."""
from storage.coding_state_store import read
from storage.records import atomic_save_json


def corrupt_record(workspace_id, kind, identity, mutation):
    record = read(workspace_id, kind, identity)
    assert record is not None
    mutation(record)
    atomic_save_json(workspace_id, ("coding-state", kind, identity + ".json"), record)
