"""Durable claims and monotonic terminal results, across independent processes."""

import json
import os
import subprocess
import sys

import pytest

from agent.runtime.durable import subagent
from storage.subagent_store import read_subagent


@pytest.mark.parametrize("terminal", ["succeeded", "failed", "cancelled"])
def test_stale_worker_cannot_resurrect_terminal(monkeypatch, tmp_path, terminal):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    created = subagent.create_subagent_task("parent", "control-ws", "session", "research_agent", "Evidence")
    stale = subagent._load_task("control-ws", created["subtask_id"])
    winner = subagent._load_task("control-ws", created["subtask_id"])
    winner.status, winner.summary, winner.finished_at = terminal, "First durable result", "finished"
    subagent._save_task(winner)
    stale.status, stale.summary, stale.finished_at = "running", "Obsolete worker", ""
    subagent._save_task(stale)
    assert (stale.status, stale.summary, stale.finished_at) == (terminal, "First durable result", "finished")
    assert read_subagent("control-ws", created["subtask_id"])["status"] == terminal
    assert not subagent.start_subagent_task(created["subtask_id"], "control-ws")["ok"]


def test_four_processes_claim_one_background_worker(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    created = subagent.create_subagent_task("parent", "control-ws", "session", "research_agent", "Evidence")
    marker = tmp_path / "started.jsonl"
    script = r'''
import json, sys, time
from pathlib import Path
from agent.runtime.durable import subagent
original_load = subagent._load_task
def slow_load(*args):
    result = original_load(*args)
    time.sleep(0.05)
    return result
subagent._load_task = slow_load
class Worker:
    def __init__(self, **kwargs): pass
    def is_alive(self): return True
    def start(self):
        with Path(sys.argv[2]).open("a") as stream:
            stream.write(json.dumps({"started": True}) + "\n")
subagent.threading.Thread = Worker
print(json.dumps(subagent.start_subagent_task(sys.argv[1], "control-ws")))
'''
    processes = [subprocess.Popen([sys.executable, "-c", script, created["subtask_id"], str(marker)],
                                 env=dict(os.environ), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                 for _ in range(4)]
    outputs = []
    for process in processes:
        stdout, stderr = process.communicate(timeout=20)
        assert process.returncode == 0, stderr
        outputs.append(json.loads(stdout))
    assert sum(result["ok"] for result in outputs) == 1
    assert len(marker.read_text().splitlines()) == 1
    assert all(result["status"] == "running" for result in outputs)
