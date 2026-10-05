"""Independent acceptance rejects dishonest observations and unsafe execution."""

from __future__ import annotations

import subprocess

import pytest

from scripts.benchmark_noc_acceptance import run_noc_acceptance
from scripts.benchmark_runtime import BenchmarkRuntime


def test_noc_oracle_rejects_regressing_and_nonfinite_counters():
    for invalid in (-1, float("nan"), float("inf"), True):
        stepped = False
        results = {}

        def array(path, key):
            if path != "/api/interfaces":
                raise ValueError("unsupported")
            row = dict(
                id="i",
                deviceId="d",
                rxBytes=5,
                txBytes=5,
                rxPackets=5,
                txPackets=5,
                crc=5,
                noBuffers=5,
                rxBps=5,
                txBps=5,
                rxPps=5,
                txPps=5,
                speed=100,
            )
            if stepped:
                row["rxBytes"] = invalid
            return [row]

        def step_api(path, data=None, **kwargs):
            nonlocal stepped
            if path == "/api/test/step":
                stepped = True
                return {}
            raise ValueError("unsupported")

        def check(name, action):
            try:
                action()
                results[name] = True
            except (AssertionError, ValueError, KeyError):
                results[name] = False

        run_noc_acceptance(step_api, array, check, 17)
        assert not results["independent_interface_counters_and_rates"]


def test_engine_executes_only_in_worker_and_host_never_imports_generated_source(
    monkeypatch, tmp_path
):
    import scripts.benchmark_runtime as module

    monkeypatch.setattr(
        module, "_client_configuration", lambda: (["docker"], {"PATH": "/usr/bin"})
    )
    monkeypatch.setattr(module, "docker_project_mount", lambda p: "/owned/project")
    monkeypatch.setattr(module.shutil, "which", lambda name: "/trusted/node")
    calls = []

    def run(argv, **kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(module.subprocess, "run", run)
    runtime = BenchmarkRuntime(
        "lzcore-project-" + "1" * 32,
        "sha256:" + "a" * 64,
        tmp_path,
        "/workspace/files/data/app",
    )
    runtime.independent_program("/* trusted canary */", "engine.ts", "smoke", 17)
    host = calls[0]
    import json

    worker = json.loads(host[-1])
    assert host[0] == "/trusted/node" and "/* trusted canary */" in host[2]
    assert "/* trusted canary */" not in worker[worker.index("-e") + 1]
    assert "--network=none" in worker and "--read-only" in worker
    assert any(str(arg).endswith("target=/project,readonly") for arg in worker)
    assert not any(
        "require('/project" in arg or "import('/project" in arg for arg in host[:-1]
    )
    assert calls[-1][:3] == ["docker", "rm", "--force"]
    with pytest.raises(ValueError):
        runtime.independent_program("", "../framework.py", "invalid", 17)


def test_generated_checks_share_immutable_snapshot_execution(monkeypatch, tmp_path):
    from storage.paths import workspace_root
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LZCORE_CODING_DOCKER_COMMAND", '["docker"]')
    project = workspace_root("bench") / "files/data/app"
    calls = []
    def execute(owner, command, cwd, **kwargs):
        calls.append((owner, command, cwd))
        return {"ok": True, "exit_code": 0, "stdout": "verified"}
    monkeypatch.setattr("core.tools.project_validation.execute_validation", execute)
    runtime = BenchmarkRuntime("lzcore-project-" + "1" * 32, "sha256:" + "a" * 64,
                               project.resolve(), "/workspace/files/data/app")
    assert runtime.generated_command(["npm", "run", "build"]).returncode == 0
    owner, command, cwd = calls[0]
    assert command == "npm run build" and owner.generated_paths == ["dist"]
    assert owner.project == project.resolve() and cwd == str(project.resolve())
    runtime.target = "/workspace/files/data/other"
    with pytest.raises(ValueError, match="project_scope"):
        runtime.generated_command(["npm", "test"])


@pytest.mark.parametrize(
    "changes",
    [
        {"agent_turn_ok": False},
        {"acceptance_exit_code": 1},
        {"acceptance_exit_code": None},
        {"acceptance_exit_code": False},
        {"team_ok": False},
        {"cleanup_confirmed": False},
        {"deadline_reached": True},
    ],
)
def test_turn_success_never_masks_failed_acceptance_or_unknown_cleanup(changes):
    from scripts.benchmark_verdict import benchmark_verdict

    arguments = dict(
        case="counter",
        acceptance_report={"case": "counter", "rounds": 3, "checks": [
            {"name": name, "status": "PASS"} for name in (
                "generated_test_suite", "production_build", "independent_browser_interactions")
        ]},
        agent_turn_ok=True,
        deadline_reached=False,
        acceptance_exit_code=0,
        team_required=True,
        team_ok=True,
        cleanup_confirmed=True,
    )
    assert benchmark_verdict(**arguments)["status"] == "PASS"
    arguments.update(changes)
    assert benchmark_verdict(**arguments)["status"] == "FAIL"
