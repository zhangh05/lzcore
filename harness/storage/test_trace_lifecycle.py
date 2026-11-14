"""Regression coverage for trace transactions and deleted-session writers."""
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import threading
import pytest

from observability.schemas import TraceRecord
from observability.store import append_event, get_trace, list_traces, write_trace
from storage.records import atomic_save_json, workspace_record_file
from storage.run_record_store import save_trace_record, write_run_record, update_run_record
from storage.session_store import delete_session_permanently, ensure_session, add_run_to_session


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    monkeypatch.setattr("observability.exporters.export_configured_trace", lambda _data: None)


def state(run_id="run_synthetic", session_id="session_synthetic"):
    return SimpleNamespace(request_id=run_id, session_id=session_id, context={}, user_input="synthetic input")


def test_deleted_session_rejects_late_run_and_both_trace_entrypoints():
    ensure_session("session_synthetic", "team")
    write_run_record(state(), "team")
    assert delete_session_permanently("session_synthetic", "team", True)
    for writer in (
        lambda: write_run_record(state(), "team"),
        lambda: save_trace_record("team", "run_synthetic", {"run_id": "run_synthetic"}),
        lambda: write_trace(TraceRecord(run_id="run_synthetic", trace_id="trace_synthetic"), "team"),
        lambda: update_run_record("team", "run_synthetic", {"status": "succeeded"}),
    ):
        with pytest.raises(ValueError, match="permanently deleted"):
            writer()
    assert not workspace_record_file("team", "runs", "run_synthetic.json").exists()
    assert get_trace("run_synthetic", "team") is None


def test_failed_session_validation_never_publishes_run(monkeypatch):
    def reject(*_args, **_kwargs):
        raise OSError("synthetic session write failure")
    monkeypatch.setattr("storage.session_store.ensure_session", reject)
    with pytest.raises(OSError):
        write_run_record(state(), "team")
    assert not workspace_record_file("team", "runs", "run_synthetic.json").exists()


def test_trace_without_run_record_is_removed_and_cannot_return():
    save_trace_record("team", "run_traceonly", {
        "session_id": "session_synthetic", "run_id": "run_traceonly", "trace_id": "trace_only",
    })
    assert delete_session_permanently("session_synthetic", "team", True)
    with pytest.raises(ValueError):
        save_trace_record("team", "run_traceonly", {"trace_id": "trace_late"})
    assert get_trace("run_traceonly", "team") is None


def test_delete_waits_for_inflight_trace_then_removes_it(monkeypatch):
    import storage.run_record_store as records
    ensure_session("session_synthetic", "team")
    add_run_to_session("session_synthetic", "run_synthetic", "team")
    entered, release = threading.Event(), threading.Event()
    original = records.atomic_save_json
    def delayed(*args):
        entered.set()
        assert release.wait(5)
        return original(*args)
    monkeypatch.setattr(records, "atomic_save_json", delayed)
    with ThreadPoolExecutor(max_workers=2) as pool:
        write = pool.submit(save_trace_record, "team", "run_synthetic", {"session_id": "session_synthetic"})
        try:
            assert entered.wait(5)
            deletion = pool.submit(delete_session_permanently, "session_synthetic", "team", True)
            assert not deletion.done()
        finally:
            release.set()
        write.result(timeout=5)
        assert deletion.result(timeout=5)
    assert get_trace("run_synthetic", "team") is None


def test_parallel_trace_appends_preserve_every_event():
    write_trace(TraceRecord(run_id="run_synthetic", trace_id="trace_synthetic"), "team")
    barrier = threading.Barrier(8)
    def append(i):
        barrier.wait(timeout=5)
        append_event("trace_synthetic", {"run_id": "run_synthetic", "event_id": str(i), "metadata": {"password": "synthetic-value"}}, "team")
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(append, range(8)))
    events = get_trace("run_synthetic", "team")["events"]
    assert {e["event_id"] for e in events} == {str(i) for i in range(8)}
    assert all(e["metadata"]["password"] != "synthetic-value" for e in events)


def test_append_reports_persistence_failure_without_losing_old_events(monkeypatch):
    write_trace(TraceRecord(run_id="run_synthetic", trace_id="trace_synthetic"), "team")
    def fail(*_args):
        raise OSError("disk unavailable")
    monkeypatch.setattr("storage.records.atomic_write_json", fail)
    with pytest.raises(OSError):
        append_event("trace_synthetic", {"run_id": "run_synthetic"}, "team")
    assert get_trace("run_synthetic", "team")["events"] == []


def test_trace_filter_precedes_limit_and_dict_hint_avoids_scan(monkeypatch):
    atomic_save_json("team", ("runs", "run_noise.json"), {"run_id": "run_noise", "updated_at": "9999"})
    atomic_save_json("team", ("runs", "run_noise.artifacts.json"), {"updated_at": "9999"})
    write_trace(TraceRecord(run_id="run_synthetic", trace_id="trace_synthetic"), "team")
    assert [t["trace_id"] for t in list_traces("team", limit=1)] == ["trace_synthetic"]
    def no_scan(*_args, **_kwargs):
        raise AssertionError("dict run_id must be used directly")
    monkeypatch.setattr("observability.store.list_json_records", no_scan)
    append_event("trace_synthetic", {"run_id": "run_synthetic", "event_id": "hint"}, "team")
    assert get_trace("run_synthetic", "team")["events"][0]["event_id"] == "hint"


def test_append_rejects_corrupt_existing_trace():
    path = workspace_record_file("team", "runs", "run_synthetic.trace.json")
    path.write_text("{broken", encoding="utf-8")
    with pytest.raises(ValueError):
        append_event("trace_synthetic", {"run_id": "run_synthetic"}, "team")
    assert path.read_text(encoding="utf-8") == "{broken"


def test_delete_removes_legacy_trace_only_with_session_identity():
    ensure_session("session_synthetic", "team")
    atomic_save_json("team", ("runs", "run_legacy.trace.json"), {
        "session_id": "session_synthetic", "run_id": "run_legacy", "trace_id": "trace_legacy",
    })
    assert delete_session_permanently("session_synthetic", "team", True)
    assert get_trace("run_legacy", "team") is None
    with pytest.raises(ValueError):
        save_trace_record("team", "run_legacy", {"trace_id": "trace_late"})
