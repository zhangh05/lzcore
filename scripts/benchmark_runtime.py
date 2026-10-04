"""Trusted benchmark adapter: generated programs never execute on the host."""

from __future__ import annotations

import json
import os
import re
import shutil
import shlex
from types import SimpleNamespace
import subprocess
import uuid
from pathlib import Path, PurePosixPath

from core.tools.project_execution import _client_configuration, docker_project_mount
from scripts.benchmark_engine_rpc import ENGINE_WORKER, HOST_BRIDGE


class BenchmarkRuntime:
    def __init__(self, container: str, image_id: str, project: Path, target: str):
        if (
            not re.fullmatch(r"lzcore-project-[0-9a-f]{32}", container)
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id)
            or not target.startswith("/workspace/files/data/")
            or ".." in PurePosixPath(target).parts
        ):
            raise ValueError("invalid_benchmark_runtime")
        self.cli, self.env = _client_configuration()
        self.container, self.image_id, self.project, self.target = (
            container,
            image_id,
            project,
            target,
        )

    def generated_command(self, argv: list[str], timeout=180):
        # The evaluator uses the same immutable snapshot contract as runtime
        # validation. It never rebuilds in the read-only coordinator mount.
        from core.tools.project_validation import execute_validation
        from storage.paths import workspace_root
        workspace_id = self.project.parents[2].name
        root = workspace_root(workspace_id).resolve()
        if self.project.parents[2] != root or self.target != "/workspace/" + self.project.relative_to(root).as_posix():
            raise ValueError("invalid_benchmark_project_scope")
        owner = SimpleNamespace(
            workspace_id=workspace_id, root=root, project=self.project,
            mount_target=self.target, image_id=self.image_id, image=self.image_id,
            started=True, closed=False, generated_paths=["dist"],
            isolation_level="strong_container",
        )
        result = execute_validation(owner, shlex.join(argv), str(self.project), timeout=timeout)
        return subprocess.CompletedProcess(argv, 0 if result.get("ok") and result.get("exit_code") == 0 else 1,
                                           result.get("stdout", ""), result.get("stderr") or result.get("error", ""))

    def independent_program(
        self, program: str, entry: str, scenario: str, seed: int, timeout=40
    ):
        """Host assertions inspect an isolated engine through bounded JSON RPC.

        Generated source/compiler only execute in the disposable QA container.
        The host verifier never imports generated modules or their dependencies.
        """
        entry_path = PurePosixPath(entry)
        if entry_path.is_absolute() or ".." in entry_path.parts:
            raise ValueError("invalid_engine_entry")
        node = shutil.which("node")
        if not node:
            raise RuntimeError("trusted_node_runtime_unavailable")
        name = "lzcore-evaluator-" + uuid.uuid4().hex
        uid = getattr(os, "getuid", lambda: 65532)() or 65532
        gid = getattr(os, "getgid", lambda: 65532)() or 65532
        worker = [
            *self.cli,
            "run",
            "-i",
            "--name",
            name,
            "--pull=never",
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit=128",
            "--memory=512m",
            "--cpus=2",
            "--tmpfs=/tmp:rw,nosuid,nodev,size=128m",
            f"--user={uid}:{gid}",
            "--mount",
            f"type=bind,source={docker_project_mount(self.project)},target=/project,readonly",
            "--workdir=/project",
            self.image_id,
            "node",
            "-e",
            ENGINE_WORKER,
            "/project/" + str(entry_path),
        ]
        try:
            return subprocess.run(
                [
                    node,
                    "-e",
                    HOST_BRIDGE + "\n" + program,
                    "evaluator",
                    str(self.project),
                    "/project/" + str(entry_path),
                    scenario,
                    str(seed),
                    json.dumps(worker),
                ],
                env=self.env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout,
            )
        finally:
            cleanup = subprocess.run(
                [*self.cli, "rm", "--force", name],
                env=self.env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
            )
            if cleanup.returncode and "No such container" not in cleanup.stderr:
                raise RuntimeError("independent_evaluator_cleanup_unconfirmed")
