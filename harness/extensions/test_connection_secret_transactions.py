"""Connection credential transactions, entirely in memory and without probes."""

from contextlib import nullcontext
from copy import deepcopy
from types import SimpleNamespace

import pytest

from extensions.network_operations import network_inventory as inventory


@pytest.fixture
def transaction(monkeypatch):
    class Records:
        def __init__(self):
            self.items = {"devices": {"device_test": {"device_id": "device_test"}}, "connections": {}}
            self.save_error = False
            self.after_commit_error = False
            self.delete_error = False

        def get(self, collection, record_id):
            return deepcopy(self.items.get(collection, {}).get(record_id))

        def list(self, collection, limit=None):
            return deepcopy(list(self.items.get(collection, {}).values()))[:limit]

        def save(self, collection, record_id, record):
            if self.save_error:
                raise OSError("synthetic-save-error")
            self.items.setdefault(collection, {})[record_id] = deepcopy(record)
            if self.after_commit_error:
                raise OSError("synthetic-after-commit-error")
            return record

        def delete(self, collection, record_id):
            if self.delete_error:
                raise OSError("synthetic-delete-error")
            return self.items[collection].pop(record_id, None) is not None

    class Secrets:
        values = {}
        writes = 0
        fail_write = 0
        deleted = []

        def __init__(self, *_):
            pass

        def set(self, name, value):
            Secrets.writes += 1
            if Secrets.writes == Secrets.fail_write:
                raise OSError("synthetic-secret-write-error")
            reference = "secret://" + name
            # Writing a new revision must never overwrite a referenced secret.
            assert reference not in Secrets.values
            Secrets.values[reference] = value
            return reference

        @staticmethod
        def delete(reference):
            Secrets.deleted.append(reference)
            return Secrets.values.pop(reference, None) is not None

    records = Records()
    monkeypatch.setattr(inventory, "_store", lambda _ws: records)
    monkeypatch.setattr(inventory, "_connection_lock", lambda _ws: nullcontext())
    monkeypatch.setattr(inventory, "ExtensionSecretStore", Secrets)
    return SimpleNamespace(records=records, secrets=Secrets)


def payload(**changes):
    return {"device_id": "device_test", "protocol": "ssh", "username": "synthetic-user",
            "auth_method": "private_key", "private_key": "synthetic-old-key",
            "passphrase": "synthetic-old-passphrase", **changes}


def save(values):
    return inventory.save_connection("synthetic-workspace", values, auto_test=False)


@pytest.mark.parametrize("change", ["auth_switch", "key_rotation", "password_rotation", "auth_none"])
def test_metadata_save_failure_keeps_all_old_secrets_and_rolls_back_new(transaction, change):
    initial = payload(auth_method="password", password="synthetic-old-password") if change == "password_rotation" else payload()
    if change == "auth_none":
        initial = payload(protocol="telnet", auth_method="password", password="synthetic-old-password")
    first = save(initial)
    cid = first["connection_id"]
    previous = deepcopy(transaction.records.items)
    old_secrets = dict(transaction.secrets.values)
    updates = {
        "auth_switch": {"auth_method": "password", "password": "synthetic-new-password"},
        "key_rotation": {"private_key": "synthetic-new-key", "passphrase": "synthetic-new-passphrase"},
        "password_rotation": {"password": "synthetic-new-password"},
        "auth_none": {"auth_method": "none"},
    }[change]
    transaction.records.save_error = True
    with pytest.raises(OSError, match="synthetic-save-error"):
        save({**first, **updates})
    assert transaction.records.items == previous
    assert transaction.secrets.values == old_secrets
    assert cid in transaction.records.items["connections"]


def test_failure_while_staging_second_secret_rolls_back_first(transaction):
    first = save(payload())
    old_secrets = dict(transaction.secrets.values)
    previous = deepcopy(transaction.records.items)
    transaction.secrets.fail_write = transaction.secrets.writes + 2
    with pytest.raises(OSError, match="synthetic-secret-write-error"):
        save({**first, "private_key": "synthetic-new-key", "passphrase": "synthetic-new-passphrase"})
    assert transaction.secrets.values == old_secrets
    assert transaction.records.items == previous


def test_new_connection_failure_leaves_no_staged_secrets(transaction):
    transaction.records.save_error = True
    with pytest.raises(OSError):
        save(payload())
    assert transaction.secrets.values == {}
    assert transaction.records.items["connections"] == {}


def test_commit_precedes_old_secret_cleanup_and_new_refs_are_unique(transaction, monkeypatch):
    first = save(payload())
    old_secrets = dict(transaction.secrets.values)
    original_save = transaction.records.save

    def commit(collection, record_id, record):
        assert old_secrets.items() <= transaction.secrets.values.items()
        assert transaction.secrets.values[record["password_ref"]] == "synthetic-new-password"
        assert record["password_ref"] not in old_secrets
        return original_save(collection, record_id, record)

    monkeypatch.setattr(transaction.records, "save", commit)
    second = save({**first, "auth_method": "password", "password": "synthetic-new-password"})
    current = transaction.records.items["connections"][first["connection_id"]]
    assert current["private_key_ref"] == current["passphrase_ref"] == ""
    assert transaction.secrets.values == {current["password_ref"]: "synthetic-new-password"}
    assert not any(key.endswith("_ref") for key in second)


def test_error_after_metadata_commit_does_not_roll_back_referenced_secrets(transaction):
    first = save(payload())
    transaction.records.after_commit_error = True
    with pytest.raises(OSError, match="synthetic-after-commit-error"):
        save({**first, "private_key": "synthetic-new-key"})
    current = transaction.records.items["connections"][first["connection_id"]]
    assert transaction.secrets.values[current["private_key_ref"]] == "synthetic-new-key"
    assert transaction.secrets.values[current["passphrase_ref"]] == "synthetic-old-passphrase"


def test_connection_delete_failure_keeps_credentials(transaction):
    first = save(payload())
    old_secrets = dict(transaction.secrets.values)
    transaction.records.delete_error = True
    with pytest.raises(OSError, match="synthetic-delete-error"):
        inventory._delete_connection_record("synthetic-workspace", first["connection_id"])
    assert transaction.secrets.values == old_secrets
    assert first["connection_id"] in transaction.records.items["connections"]


def test_shared_legacy_refs_survive_rotation_and_are_reclaimed_after_last_delete(transaction):
    first = save(payload())
    cid = first["connection_id"]
    second = {**transaction.records.items["connections"][cid], "connection_id": "connection_other", "port": 2222}
    transaction.records.items["connections"][second["connection_id"]] = second
    old_secrets = dict(transaction.secrets.values)
    save({**first, "auth_method": "password", "password": "synthetic-new-password"})
    assert old_secrets.items() <= transaction.secrets.values.items()
    assert inventory._delete_connection_record("synthetic-workspace", second["connection_id"])
    assert not old_secrets.keys() & transaction.secrets.values.keys()
    assert inventory._delete_connection_record("synthetic-workspace", cid)
    assert transaction.secrets.values == {}


def test_cleanup_failure_keeps_committed_auth_and_logs_only_type(transaction, monkeypatch, caplog):
    first = save(payload())

    def fail(_reference):
        raise OSError("synthetic-sensitive-exception")

    monkeypatch.setattr(transaction.secrets, "delete", fail)
    save({**first, "private_key": "synthetic-new-key"})
    current = transaction.records.items["connections"][first["connection_id"]]
    assert transaction.secrets.values[current["private_key_ref"]] == "synthetic-new-key"
    assert "OSError" in caplog.text
    assert "synthetic-sensitive-exception" not in caplog.text
