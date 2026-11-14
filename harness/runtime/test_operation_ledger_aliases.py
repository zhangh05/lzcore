"""R1b: constant-cost alias lookup and fail-closed write planning, offline."""

import json
import logging
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest

from core.runtime_engine import operation_ledger as ledger
from storage.records import workspace_record_dir


@pytest.fixture
def ledger_context(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    ctx = SimpleNamespace(workspace_id="r1b", request_id="turn", session_id="session", extras={})
    return ctx, workspace_record_dir(ctx.workspace_id, "operations")


def _alias_path(directory):
    return next(path for path in directory.iterdir() if path.name.startswith("alias_") and path.suffix == ".json")


@pytest.mark.parametrize("damaged", [False, True])
def test_plan_reads_no_unrelated_operations_even_with_500_files(ledger_context, monkeypatch, damaged):
    ctx, directory = ledger_context
    for index in range(500):
        (directory / f"op_{index:024x}.json").write_text(
            "{broken unrelated JSON" if damaged else json.dumps({"operation_id": f"op_{index:024x}"}),
            encoding="utf-8",
        )
    reads = []
    original_read = Path.read_text
    original_glob = Path.glob

    def read(path, *args, **kwargs):
        if path.parent == directory:
            reads.append(path.name)
            assert path.name.startswith("alias_") or path.name in allowed_operations
        return original_read(path, *args, **kwargs)

    def glob(path, *args, **kwargs):
        assert path != directory, "write planning must not enumerate operations"
        return original_glob(path, *args, **kwargs)

    allowed_operations = {f"{ledger.operation_id(ctx.workspace_id, ctx.request_id, call)}.json"
                          for call in ("write", "renamed")}
    monkeypatch.setattr(Path, "read_text", read)
    monkeypatch.setattr(Path, "glob", glob)
    first = ledger.plan_operation(ctx, "workspace.file", "write", {"action": "write"})
    assert len(reads) == 2  # Missing call record and missing alias; no directory scan.
    reads.clear()
    renamed = ledger.plan_operation(ctx, "workspace.file", "renamed", {"action": "write"})
    assert renamed == first
    assert len(reads) == 3  # Missing new call record, alias and its one target.


@pytest.mark.parametrize("status", ["planned", "running", "unknown", "indeterminate"])
def test_alias_reuses_each_unresolved_state_and_only_stores_operation_id(ledger_context, status):
    ctx, directory = ledger_context
    arguments = {"action": "write", "content": "test-only-sensitive-content"}
    first = ledger.plan_operation(ctx, "workspace.file", "write", arguments)
    if status != "planned":
        ledger.start_operation(ctx.workspace_id, first["operation_id"])
    if status == "unknown":
        ledger.finish_operation(ctx.workspace_id, first["operation_id"], SimpleNamespace(
            ok=False, output={}, execution_may_continue=True))
    if status == "indeterminate":
        ledger.settle_operation(ctx.workspace_id, first["operation_id"], status=status, resolved_by="test")

    renamed = ledger.plan_operation(ctx, "workspace.file", "renamed", dict(reversed(list(arguments.items()))))
    assert renamed["operation_id"] == first["operation_id"]
    assert renamed["status"] == status
    alias_path = _alias_path(directory)
    assert json.loads(alias_path.read_text()) == {"operation_id": first["operation_id"]}
    assert "test-only-sensitive-content" not in alias_path.name + alias_path.read_text()


@pytest.mark.parametrize("status", ["succeeded", "failed", "blocked", "reconciled"])
def test_terminal_alias_allows_new_write_and_old_call_does_not_rewind_index(ledger_context, status):
    ctx, directory = ledger_context
    first = ledger.plan_operation(ctx, "workspace.file", "write", {})
    ledger.settle_operation(ctx.workspace_id, first["operation_id"], status=status, resolved_by="test")
    second = ledger.plan_operation(ctx, "workspace.file", "new-write", {})
    assert second["operation_id"] != first["operation_id"]
    assert second["status"] == "planned"
    assert ledger.plan_operation(ctx, "workspace.file", "write", {})["status"] == status
    assert ledger.plan_operation(ctx, "workspace.file", "third-id", {}) == second
    assert json.loads(_alias_path(directory).read_text()) == {"operation_id": second["operation_id"]}
    # Index JSON must never appear as an operation or inflate status counts.
    assert {item["operation_id"] for item in ledger.list_operations(ctx.workspace_id)} == {
        first["operation_id"], second["operation_id"],
    }
    assert ledger.operation_counts(ctx.workspace_id) == {status: 1, "planned": 1}


@pytest.mark.parametrize("damage,expected_error,exception_type", [
    ("alias-json", "operation_alias_unreadable", "JSONDecodeError"),
    ("alias-null", "operation_alias_unreadable", "ValueError"),
    ("alias-fields", "operation_alias_invalid", "ValueError"),
    ("alias-id", "operation_alias_invalid", "ValueError"),
    ("alias-io", "operation_alias_unreadable", "PermissionError"),
    ("target-json", "operation_alias_target_unreadable", "JSONDecodeError"),
    ("target-null", "operation_alias_target_unreadable", "ValueError"),
    ("target-missing", "operation_alias_target_unreadable", "FileNotFoundError"),
    ("target-identity", "operation_alias_invalid", "ValueError"),
    ("target-status", "operation_alias_invalid", "ValueError"),
    ("target-io", "operation_alias_target_unreadable", "PermissionError"),
])
def test_broken_alias_or_target_refuses_new_operation(
    ledger_context, monkeypatch, caplog, damage, expected_error, exception_type,
):
    ctx, directory = ledger_context
    first = ledger.plan_operation(ctx, "workspace.file", "write", {})
    target_path = directory / f'{first["operation_id"]}.json'
    alias_path = _alias_path(directory)
    broken_path = alias_path if damage.startswith("alias-") else target_path
    if damage.endswith("json"):
        broken_path.write_text("{test-only-sensitive-damage", encoding="utf-8")
    elif damage.endswith("null"):
        broken_path.write_text("null", encoding="utf-8")
    elif damage == "alias-fields":
        alias_path.write_text("{}", encoding="utf-8")
    elif damage == "alias-id":
        alias_path.write_text(json.dumps({"operation_id": "../test-only-sensitive-path"}))
    elif damage == "target-missing":
        target_path.unlink()
    elif damage == "target-identity":
        target_path.write_text(json.dumps({**first, "turn_id": "different-turn"}))
    elif damage == "target-status":
        target_path.write_text(json.dumps({**first, "status": "unrecognized"}))

    alias_before = alias_path.read_bytes()
    target_before = target_path.read_bytes() if target_path.exists() else None
    if damage.endswith("io"):
        original_read = Path.read_text

        def read(path, *args, **kwargs):
            if path == broken_path:
                raise PermissionError("test-only-sensitive-error")
            return original_read(path, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", read)

    caplog.clear()
    with caplog.at_level(logging.WARNING, logger=ledger.__name__):
        with pytest.raises(RuntimeError, match=f"^{expected_error}$") as error:
            ledger.plan_operation(ctx, "workspace.file", "renamed", {})
    assert error.value.__suppress_context__
    warnings = [item for item in caplog.records if item.name == ledger.__name__]
    assert [item.getMessage() for item in warnings] == [exception_type]
    assert alias_path.read_bytes() == alias_before
    assert (target_path.read_bytes() if target_path.exists() else None) == target_before
    new_id = ledger.operation_id(ctx.workspace_id, ctx.request_id, "renamed")
    assert not (directory / f"{new_id}.json").exists()


def test_concurrent_alias_planning_creates_one_operation(ledger_context):
    ctx, directory = ledger_context
    with ThreadPoolExecutor(max_workers=2) as pool:
        records = list(pool.map(lambda call: ledger.plan_operation(ctx, "workspace.file", call, {}),
                                ["write", "renamed"]))
    assert records[0] == records[1]
    assert len([path for path in directory.iterdir() if path.name.startswith("op_") and path.suffix == ".json"]) == 1


@pytest.mark.parametrize("failed_write", ["alias", "operation"])
def test_incomplete_index_publication_never_returns_a_plan(ledger_context, monkeypatch, failed_write):
    ctx, directory = ledger_context
    original_write = ledger.atomic_write_json

    def write(path, record):
        is_alias = path.name.startswith("alias_")
        if is_alias == (failed_write == "alias"):
            raise OSError("test storage unavailable")
        original_write(path, record)

    with monkeypatch.context() as patch:
        patch.setattr(ledger, "atomic_write_json", write)
        with pytest.raises(OSError, match="test storage unavailable"):
            ledger.plan_operation(ctx, "workspace.file", "write", {})
    assert not (directory / f'{ledger.operation_id(ctx.workspace_id, ctx.request_id, "write")}.json').exists()
    if failed_write == "operation":
        assert _alias_path(directory).is_file()
        with pytest.raises(RuntimeError, match="operation_alias_target_unreadable"):
            ledger.plan_operation(ctx, "workspace.file", "renamed", {})
    else:
        assert ledger.plan_operation(ctx, "workspace.file", "renamed", {})["status"] == "planned"
