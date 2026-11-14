import json
from types import SimpleNamespace

import pytest

from agent.runtime.durable import delivery


@pytest.mark.parametrize("stage", ["resolve", "add", "commit", "remote", "branch", "push", "status"])
@pytest.mark.parametrize("outcome", ["success", "failure", "exception"])
def test_git_outputs_and_events_redact_credentials(monkeypatch, tmp_path, stage, outcome):
    password = "synthetic-git-password"
    url = f"https://demo:{password}@example.invalid/repo"
    token = "ghp_syntheticGitToken123456"
    unsafe = f"{url} {token}"
    calls, events = [], []
    commands = {
        "resolve": ["git", "rev-parse", "--show-toplevel"],
        "add": ["git", "add", "-A", "--", "change.txt"],
        "commit": ["git", "commit", "--only", "-m", unsafe, "--", "change.txt"],
        "remote": ["git", "remote"],
        "branch": ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        "push": ["git", "push", "--", "origin", "refs/heads/main:refs/heads/main"],
        "status": ["git", "status", "--porcelain"],
    }
    def run(args, **kwargs):
        calls.append(args)
        if args == commands[stage]:
            if outcome == "exception":
                raise RuntimeError(unsafe)
            if outcome == "failure":
                return SimpleNamespace(returncode=1, stdout=unsafe, stderr=unsafe)
        if args == commands["resolve"]:
            return SimpleNamespace(returncode=0, stdout=str(tmp_path), stderr="")
        if args == commands["remote"]:
            return SimpleNamespace(returncode=0, stdout="origin\n", stderr="")
        if args[1] == "rev-parse":
            return SimpleNamespace(returncode=0, stdout="main", stderr="")
        return SimpleNamespace(returncode=0, stdout=unsafe, stderr=unsafe)
    monkeypatch.setattr("storage.paths.workspace_root", lambda _: tmp_path)
    monkeypatch.setattr("subprocess.run", run)
    monkeypatch.setattr("storage.events.publish", lambda *args: events.append(args))
    if stage in {"add", "commit"}:
        result = delivery.git_commit("synthetic", unsafe, confirm=True, paths=["change.txt"])
    elif stage in {"remote", "branch", "push"}:
        result = delivery.git_push("synthetic", remote="origin", confirm=True)
    else:
        result = delivery.git_status_check("synthetic")
    for secret in (password, token):
        assert secret not in json.dumps(result)
        assert secret not in str(events)
    assert commands[stage] in calls
    assert result["ok"] is (outcome == "success")
    if outcome != "success":
        assert result["error"]
        assert not events
    else:
        assert len(events) == 1


def test_remote_url_rejected_without_exposing_credentials(monkeypatch):
    url = "https://demo:synthetic-password@example.invalid/repo"
    events = []
    def unexpected_run(*args, **kwargs):
        pytest.fail("invalid remote must not invoke git")
    monkeypatch.setattr("subprocess.run", unexpected_run)
    monkeypatch.setattr("storage.events.publish", lambda *args: events.append(args))
    result = delivery.git_push("synthetic", remote=url, confirm=True)
    assert result["ok"] is False
    assert "synthetic-password" not in json.dumps(result)
    assert not events
