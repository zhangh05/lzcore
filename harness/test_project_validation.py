"""Immutable validation snapshots support normal rebuilds without source writes."""
from contextlib import contextmanager
from types import SimpleNamespace
import shutil

import pytest

from core.tools.project_validation import execute_validation


@pytest.mark.parametrize("absolute", [False, True])
def test_dependency_snapshot_preserves_executable_links_and_rebases_absolute_targets(monkeypatch, tmp_path, absolute):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    from storage.paths import workspace_root
    project = workspace_root("owner") / "files/data/app"
    tool = project / "node_modules/typescript/bin/tsc"
    tool.parent.mkdir(parents=True)
    tool.write_text("require('../lib/tsc.js')")
    library = project / "node_modules/typescript/lib/tsc.js"
    library.parent.mkdir()
    library.write_text("compiler")
    link = project / "node_modules/.bin/tsc"
    link.parent.mkdir()
    link.symlink_to(tool if absolute else "../typescript/bin/tsc")
    (project / "source.ts").write_text("reviewed")
    owner = SimpleNamespace(workspace_id="owner", root=workspace_root("owner"), project=project,
                            started=True, closed=False, generated_paths=[], image_id="test", image="test",
                            mount_target="/workspace/files/data/app", isolation_level="strong_container")
    @contextmanager
    def isolated(_, stage, port, **kwargs):
        class Environment:
            cleanup_confirmed = True
            def execute(self, *args, **kw):
                copied = stage / "node_modules/.bin/tsc"
                assert copied.is_symlink()
                assert not copied.readlink().is_absolute()
                assert copied.resolve() == stage / "node_modules/typescript/bin/tsc"
                assert (copied.resolve().parent / "../lib/tsc.js").read_text() == "compiler"
                return {"ok": True, "exit_code": 0}
            def close(self): return True
            def descriptor(self): return {"cleanup_confirmed": True}
        yield Environment()
    monkeypatch.setattr("core.tools.project_execution.isolated_project", isolated)
    result = execute_validation(owner, "npm run build", str(project))
    assert result["ok"] and result["validation_snapshot"]["source_unchanged"]
    assert link.is_symlink() and link.resolve() == tool


def test_dependency_cache_link_cannot_read_outside_project(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    from storage.paths import workspace_root
    project = workspace_root("owner") / "files/data/app"
    cache = project / "node_modules"
    cache.mkdir(parents=True)
    canary = tmp_path / "outside"
    canary.write_text("private-canary")
    (cache / "escape").symlink_to(canary)
    (project / "source.js").write_text("reviewed")
    owner = SimpleNamespace(workspace_id="owner", root=workspace_root("owner"), project=project,
                            started=True, closed=False, generated_paths=[], image_id="test", image="test",
                            mount_target="/workspace/files/data/app", isolation_level="strong_container")
    result = execute_validation(owner, "npm test", str(project))
    assert not result["ok"] and not result["executed"]
    assert not result["automatic_retry_allowed"]


@pytest.mark.parametrize("change_source,unknown_cleanup", [(False, False), (True, False), (False, True)])
def test_rebuild_replaces_output_root_only_in_disposable_copy(monkeypatch, tmp_path, change_source, unknown_cleanup):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    from storage.paths import workspace_root
    project = workspace_root("owner") / "files/data/app"
    project.mkdir(parents=True)
    (project / "source.js").write_text("reviewed")
    (project / "dist").mkdir()
    (project / "dist/old.js").write_text("old")
    owner = SimpleNamespace(workspace_id="owner", root=workspace_root("owner"), project=project,
                            started=True, closed=False, generated_paths=["dist"],
                            image_id="sha256:test", image="test", mount_target="/workspace/files/data/app",
                            isolation_level="strong_container")
    @contextmanager
    def freeze(_):
        yield
    monkeypatch.setattr("core.tools.project_validation.quiescent_project", freeze)
    @contextmanager
    def isolated(_, stage, port, **kwargs):
        class Environment:
            cleanup_confirmed = not unknown_cleanup
            def execute(self, command, cwd, **kw):
                (stage / "dist").mkdir(exist_ok=True)
                shutil.rmtree(stage / "dist")
                (stage / "dist").mkdir()
                (stage / "dist/new.js").write_text("built")
                if change_source:
                    (stage / "source.js").write_text("tampered")
                return {"ok": True, "exit_code": 0}
            def close(self): return self.cleanup_confirmed
            def descriptor(self): return {"cleanup_confirmed": self.cleanup_confirmed}
        yield Environment()
    monkeypatch.setattr("core.tools.project_execution.isolated_project", isolated)
    result = execute_validation(owner, "npm run build", str(project))
    assert (project / "source.js").read_text() == "reviewed"
    assert result["ok"] == (not change_source and not unknown_cleanup)
    if result["ok"]:
        assert result["validation_snapshot"]["source_unchanged"]
        assert not (project / "dist/old.js").exists()
        assert (project / "dist/new.js").read_text() == "built"
    else:
        assert (project / "dist/old.js").read_text() == "old"
        assert not (project / "dist/new.js").exists()


def test_only_server_assigned_exact_command_enters_validation_snapshot(monkeypatch, tmp_path):
    from core.tools.project_execution import DockerProjectEnvironment
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LZCORE_CODING_DOCKER_COMMAND", '["docker"]')
    from storage.paths import workspace_root
    owner = DockerProjectEnvironment("owner", workspace_root("owner") / "files/data/app", 18080,
                                     source_mode="review", generated_paths=["dist"])
    owner.configure_validation(["npm run build"])
    monkeypatch.setattr("core.tools.project_validation.execute_validation", lambda *a, **kw: {"runner": "snapshot"})
    monkeypatch.setattr(owner, "_execute", lambda *a, **kw: {"runner": "readonly"})
    assert owner.execute("npm run build", str(owner.project))["runner"] == "snapshot"
    assert owner.execute("npm run build && touch source.js", str(owner.project))["runner"] == "readonly"
    assert owner.execute("rm -rf dist", str(owner.project))["runner"] == "readonly"
