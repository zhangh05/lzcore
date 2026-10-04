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
