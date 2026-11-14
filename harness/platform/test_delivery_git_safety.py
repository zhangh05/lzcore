"""Git delivery fails closed; real Git only touches isolated local repositories."""

import os
import subprocess
from types import SimpleNamespace

import pytest

from agent.runtime.durable import delivery
from storage import paths
from storage.principal import storage_principal


@pytest.fixture(autouse=True)
def isolated_git(monkeypatch, tmp_path):
    # Ignore host Git configuration, credentials, hooks, templates and repo overrides.
    for name in list(os.environ):
        if name.startswith("GIT_"):
            monkeypatch.delenv(name)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    monkeypatch.setenv("GIT_CONFIG_COUNT", "0")
    monkeypatch.setenv("GIT_ALLOW_PROTOCOL", "file")
    monkeypatch.setenv("GIT_TERMINAL_PROMPT", "0")
    monkeypatch.setenv("GIT_AUTHOR_NAME", "Synthetic Test")
    monkeypatch.setenv("GIT_AUTHOR_EMAIL", "test@example.invalid")
    monkeypatch.setenv("GIT_COMMITTER_NAME", "Synthetic Test")
    monkeypatch.setenv("GIT_COMMITTER_EMAIL", "test@example.invalid")
    real_workspace_root = paths.workspace_root
    monkeypatch.setattr(paths, "get_workspace_root", lambda: tmp_path / "data")
    monkeypatch.setattr(paths, "workspace_root", lambda ws: real_workspace_root(ws))
    events = []
    monkeypatch.setattr("storage.events.publish", lambda *args: events.append(args))
    return events


def git(repo, *args):
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True,
        timeout=10, check=True,
    ).stdout.strip()


def init_repo(repo, bare=False):
    repo.mkdir(parents=True)
    git(repo, "init", "--template=", *(["--bare"] if bare else ["-b", "main"]))
    return repo


@pytest.fixture
def repo():
    return init_repo(paths.workspace_root("synthetic"))


def invoke(operation, ws="synthetic"):
    if operation == "status":
        return delivery.git_status_check(ws)
    if operation == "commit":
        return delivery.git_commit(ws, "synthetic change", confirm=True)
    return delivery.git_push(ws, confirm=True)


@pytest.mark.parametrize("operation", ["status", "commit", "push"])
def test_missing_workspace_never_falls_back_to_cwd(monkeypatch, tmp_path, operation, isolated_git):
    cwd_repo = init_repo(tmp_path / "cwd")
    monkeypatch.chdir(cwd_repo)
    (cwd_repo / "untouched.txt").write_text("leave untracked", encoding="utf-8")
    def unexpected_run(*args, **kwargs):
        pytest.fail("missing workspace must not run Git in any directory")
    monkeypatch.setattr(subprocess, "run", unexpected_run)
    result = invoke(operation)
    assert result["ok"] is False
    assert result["error"]
    assert not paths.workspace_root("synthetic").exists()
    assert not (cwd_repo / ".git" / "index").exists()
    assert not isolated_git


@pytest.mark.parametrize("operation", ["status", "commit", "push"])
@pytest.mark.parametrize("ws", ["", "../escape", "/absolute", "invalid name", None])
def test_invalid_workspace_never_runs_git(monkeypatch, operation, ws):
    def unexpected_run(*args, **kwargs):
        pytest.fail("invalid workspace must not invoke Git")
    monkeypatch.setattr(subprocess, "run", unexpected_run)
    result = invoke(operation, ws)
    assert result["ok"] is False
    assert result["error"]


@pytest.mark.parametrize("operation", ["status", "commit", "push"])
@pytest.mark.parametrize("parent_is_repo", [False, True])
def test_workspace_must_be_repository_top_level(monkeypatch, tmp_path, operation, parent_is_repo, isolated_git):
    parent = tmp_path / "parent"
    if parent_is_repo:
        init_repo(parent)
    child = parent / "child"
    child.mkdir(parents=True)
    monkeypatch.setattr(paths, "workspace_root", lambda _: child)
    calls = []
    real_run = subprocess.run
    def run(args, **kwargs):
        calls.append((args, kwargs["cwd"]))
        return real_run(args, **kwargs)
    monkeypatch.setattr(subprocess, "run", run)
    result = invoke(operation)
    assert result["ok"] is False
    assert result["error"]
    assert calls == [(["git", "rev-parse", "--show-toplevel"], str(child.resolve()))]
    assert not (parent / ".git" / "index").exists()
    assert not isolated_git


def test_repo_resolution_uses_principal_isolation(monkeypatch, repo):
    monkeypatch.setattr("storage.principal.principal_storage_key", lambda _: "usr_" + "a" * 32)
    with storage_principal("synthetic-user"):
        # The unscoped repository must never be used for an authenticated user.
        assert delivery.git_commit("synthetic", "change", confirm=True)["ok"] is False
        scoped = init_repo(paths.workspace_root("synthetic"))
        assert delivery._resolve_repo_dir("synthetic") == str(scoped.resolve())
        assert scoped != repo


def test_add_failure_never_commits(monkeypatch, repo, isolated_git):
    calls = []
    real_run = subprocess.run
    def run(args, **kwargs):
        calls.append(args)
        if args[1] == "rev-parse":
            return real_run(args, **kwargs)
        assert args == ["git", "add", "-A", "--"]
        return SimpleNamespace(returncode=1, stdout="", stderr="synthetic add failure")
    monkeypatch.setattr(subprocess, "run", run)
    result = delivery.git_commit("synthetic", "--amend", confirm=True)
    assert result["ok"] is False
    assert "synthetic add failure" in result["error"]
    assert [args[1] for args in calls] == ["rev-parse", "add"]
    assert not isolated_git


@pytest.mark.parametrize("remote", [
    "--mirror", "--force", "--receive-pack=x", "a b",
    "https://demo:synthetic-password@example.invalid/repo", "", "a" * 101, "origin\n",
])
def test_unsafe_remote_never_runs_git(monkeypatch, remote, isolated_git):
    def unexpected_run(*args, **kwargs):
        pytest.fail("invalid remote must be rejected before invoking Git")
    monkeypatch.setattr(subprocess, "run", unexpected_run)
    result = delivery.git_push("synthetic", remote=remote, confirm=True)
    assert result["ok"] is False
    assert result["error"]
    assert not isolated_git


def test_unconfigured_remote_cannot_push(monkeypatch, repo, isolated_git):
    real_run = subprocess.run
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        assert args[1] != "push"
        return real_run(args, **kwargs)
    monkeypatch.setattr(subprocess, "run", run)
    result = delivery.git_push("synthetic", remote="missing", confirm=True)
    assert result["ok"] is False
    assert result["error"]
    assert calls[-1] == ["git", "remote"]
    assert not isolated_git


@pytest.mark.parametrize("stage,code,output", [
    ("remote", 1, "origin\n"),
    ("branch", 1, "main\n"),
    ("branch", 0, "HEAD\n"),
    ("branch", 0, "--force\n"),
    ("branch", 0, ""),
])
def test_push_lookup_failure_or_invalid_branch_never_pushes(monkeypatch, repo, stage, code, output, isolated_git):
    def run(args, **kwargs):
        assert args[1] != "push"
        if args[-1] == "--show-toplevel":
            return SimpleNamespace(returncode=0, stdout=str(repo), stderr="")
        current = "remote" if args[1] == "remote" else "branch"
        return SimpleNamespace(returncode=code if current == stage else 0,
                               stdout=output if current == stage else "origin\n", stderr="")
    monkeypatch.setattr(subprocess, "run", run)
    result = delivery.git_push("synthetic", confirm=True)
    assert result["ok"] is False
    assert result["error"]
    assert not isolated_git


def test_local_bare_push_and_detached_head_rejection(monkeypatch, tmp_path, repo, isolated_git):
    (repo / "tracked.txt").write_text("initial", encoding="utf-8")
    assert delivery.git_commit("synthetic", "--amend", confirm=True)["ok"] is True
    assert git(repo, "log", "-1", "--format=%s") == "--amend"
    # add -A continues to include modifications, deletions and untracked paths.
    (repo / "tracked.txt").unlink()
    (repo / "new.txt").write_text("replacement", encoding="utf-8")
    assert delivery.git_commit("synthetic", "replacement", confirm=True)["ok"] is True
    assert git(repo, "ls-tree", "--name-only", "HEAD") == "new.txt"
    status = delivery.git_status_check("synthetic")
    assert status["ok"] is True and status["dirty"] is False
    bare = init_repo(tmp_path / "remote.git", bare=True)
    git(repo, "remote", "add", "origin", str(bare))
    calls = []
    real_run = subprocess.run
    def run(args, **kwargs):
        calls.append(args)
        if args[1] == "push":
            assert args == ["git", "push", "--", "origin", "refs/heads/main:refs/heads/main"]
            assert kwargs["env"]["GIT_TERMINAL_PROMPT"] == "0"
        return real_run(args, **kwargs)
    monkeypatch.setattr(subprocess, "run", run)
    monkeypatch.setenv("GIT_TERMINAL_PROMPT", "1")
    result = delivery.git_push("synthetic", confirm=True)
    assert result["ok"] is True
    assert git(bare, "rev-parse", "refs/heads/main") == git(repo, "rev-parse", "HEAD")
    git(repo, "checkout", "--detach", "HEAD")
    calls.clear()
    isolated_git.clear()
    result = delivery.git_push("synthetic", confirm=True)
    assert result["ok"] is False
    assert result["error"]
    assert all(args[1] != "push" for args in calls)
    assert not isolated_git
