import json
from types import SimpleNamespace

import pytest

from agent.runtime.durable import delivery


@pytest.mark.parametrize("operation", ["commit", "push", "status"])
@pytest.mark.parametrize("outcome", ["success", "failure", "exception"])
def test_git_outputs_and_events_redact_credentials(monkeypatch, tmp_path, operation, outcome):
    password = "synthetic-git-password"
    url = f"https://demo:{password}@example.invalid/repo"
    token = "ghp_syntheticGitToken123456"
    unsafe = f"{url} {token}"
    calls, events = [], []
    def run(args, **kwargs):
        calls.append(args)
        if outcome == "exception":
            raise RuntimeError(unsafe)
        if args[1] == "rev-parse":
            return SimpleNamespace(returncode=0, stdout="main", stderr="")
        return SimpleNamespace(returncode=1 if outcome == "failure" else 0,
                               stdout=unsafe, stderr=unsafe)
    monkeypatch.setattr(delivery, "_resolve_repo_dir", lambda _: str(tmp_path))
    monkeypatch.setattr("subprocess.run", run)
    monkeypatch.setattr("storage.events.publish", lambda *args: events.append(args))
    if operation == "commit":
        result = delivery.git_commit("synthetic", unsafe, confirm=True)
    elif operation == "push":
        result = delivery.git_push("synthetic", remote=url, confirm=True)
    else:
        result = delivery.git_status_check("synthetic")
    for secret in (password, token):
        assert secret not in json.dumps(result)
        assert secret not in str(events)
    if outcome != "exception" and operation == "push":
        assert ["git", "push", url, "main"] in calls
    if outcome != "exception" and operation == "commit":
        assert ["git", "commit", "-m", unsafe] in calls
