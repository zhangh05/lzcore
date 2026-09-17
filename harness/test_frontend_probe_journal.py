"""Probe recovery must never apply one drawing's journal to another."""
import importlib.util
from pathlib import Path

import pytest


@pytest.fixture
def journal(tmp_path, monkeypatch):
    source = Path(__file__).resolve().parents[1] / "frontend/scripts/probe_journal.py"
    spec = importlib.util.spec_from_file_location("probe_journal", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "JOURNAL_DIR", str(tmp_path))
    return module.ProbeJournal("test")


@pytest.mark.parametrize("requested,returned", [("other", "other"), ("original", "other")])
def test_mismatched_drawing_is_not_restored(journal, requested, returned):
    journal.record({"nodes": [{"node_id": "same-id", "x": 10, "y": 20}]}, "original")
    writes = []
    with pytest.raises(AssertionError):
        journal.repair(lambda: {"topology_id": returned, "nodes": [{"node_id": "same-id", "x": 99, "y": 99}]}, writes.append, requested)
    assert writes == []
    assert Path(journal.path).exists()


def test_matching_drawing_restores_positions_only(journal):
    journal.record({"nodes": [{"node_id": "a", "x": 10, "y": 20}]}, "original")
    writes = []
    current = {"topology_id": "original", "nodes": [{"node_id": "a", "x": 30, "y": 40, "display_name": "current name"}, {"node_id": "new", "x": 1, "y": 2}]}
    assert journal.repair(lambda: current, writes.append, "original")
    assert writes[0]["nodes"] == [{"node_id": "a", "x": 10, "y": 20, "display_name": "current name"}, {"node_id": "new", "x": 1, "y": 2}]
    assert not Path(journal.path).exists()
