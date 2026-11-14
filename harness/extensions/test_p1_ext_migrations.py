from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from extensions.sdk import ExtensionDataStore, run_migrations
from storage.principal import storage_principal


@pytest.fixture
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setattr("backend.core.identity.resolve_user_storage_id", lambda name: f"test_{name}")


def test_same_workspace_migrates_each_principal_independently(isolated):
    from extensions.state import set_workspace_schema_version
    set_workspace_schema_version("vendor.sample", "team", 99)
    calls = []
    roots = []
    def migrate(store):
        calls.append(str(store.root()))
        store.save("records", "migrated", {"version": 1})
    for principal in ("alice", "bob"):
        with storage_principal(principal):
            assert run_migrations("vendor.sample", "team", [(1, migrate)]) == 1
            assert run_migrations("vendor.sample", "team", [(1, migrate)]) == 1
            assert ExtensionDataStore("vendor.sample", "team").get("records", "migrated") == {"version": 1}
            roots.append(ExtensionDataStore("vendor.sample", "team").root())
    assert len(calls) == 2 and roots[0] != roots[1]


def test_concurrent_migrations_on_same_data_root_only_run_once(isolated):
    barrier = Barrier(2)
    calls = []
    def run(_):
        with storage_principal("alice"):
            barrier.wait(timeout=5)
            return run_migrations("vendor.sample", "team", [(1, lambda store: calls.append(store.workspace_id))])
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(run, range(2))) == [1, 1]
    assert calls == ["team"]


def test_failed_migration_does_not_advance_version_and_corrupt_marker_is_rejected(isolated):
    def fail(_store):
        raise OSError("synthetic_failure")
    with pytest.raises(OSError):
        run_migrations("vendor.sample", "team", [(1, fail)])
    calls = []
    assert run_migrations("vendor.sample", "team", [(1, lambda _: calls.append(1))]) == 1
    marker = ExtensionDataStore("vendor.sample", "team").root() / ".schema-version.json"
    marker.write_text("bad-json")
    with pytest.raises(ValueError):
        run_migrations("vendor.sample", "team", [(2, lambda _: calls.append(2))])
    assert calls == [1]
