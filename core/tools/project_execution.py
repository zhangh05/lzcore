"""Server-owned execution environments, separate from model command payloads.

An isolated project gets an internal network, a dependency-only egress broker,
a non-root read-only container and a single generated-project mount. Closed
bindings stay closed: a late child call must never fall back to host execution.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

from core.tools.package_egress import PROXY_PROGRAM
from storage.paths import workspace_root

_BINDINGS: dict[str, "DockerProjectEnvironment"] = {}
_LOCK = threading.RLock()


def environment_for(workspace_id: str):
    with _LOCK:
        return _BINDINGS.get(str(workspace_root(workspace_id).resolve()))


def _client_configuration():
    raw = os.environ.get("LZCORE_CODING_DOCKER_COMMAND", "")
    cli = json.loads(raw) if raw else [shutil.which("docker") or ""]
    if (
        not isinstance(cli, list)
        or not cli
        or any(not isinstance(item, str) or not item for item in cli)
    ):
        raise ValueError("isolated_execution_docker_unavailable")
    safe_keys = (
        "PATH",
        "HOME",
        "DOCKER_HOST",
        "DOCKER_TLS_VERIFY",
        "DOCKER_CERT_PATH",
        "LIMA_HOME",
    )
    return cli, {key: os.environ[key] for key in safe_keys if os.environ.get(key)}


def docker_project_mount(project: Path) -> str:
    """Map one authorized project for a daemon on a different filesystem.

    Mapping roots are server configuration, never model arguments. A remote
    daemon/VM must expose this dedicated scratch root and no framework mount.
    """
    host = os.environ.get("LZCORE_CODING_DOCKER_HOST_ROOT", "")
    guest = os.environ.get("LZCORE_CODING_DOCKER_GUEST_ROOT", "")
    if bool(host) != bool(guest):
        raise ValueError("incomplete_coding_daemon_mount_mapping")
    if host:
        destination = PurePosixPath(guest)
        if not destination.is_absolute() or ".." in destination.parts or "," in guest:
            raise ValueError("invalid_coding_daemon_mount_mapping")
        return str(
            destination / project.resolve().relative_to(Path(host).resolve()).as_posix()
        )
    return str(project.resolve())


class DockerProjectEnvironment:
    isolation_level = "strong_container"

    def __init__(
        self, workspace_id: str, project: Path, port: int, *, image: str | None = None
    ):
        self.workspace_id = workspace_id
        self.root = workspace_root(workspace_id).resolve()
        self.project = project.resolve()
        relative = self.project.relative_to(self.root)
        if (
            relative.parts[:2] != ("files", "data")
            or len(relative.parts) < 3
            or project.is_symlink()
        ):
            raise ValueError("isolated_execution_requires_generated_project")
        self.project.mkdir(parents=True, exist_ok=True)
        self.mount_source = docker_project_mount(self.project)
        self.mount_target = "/workspace/" + relative.as_posix()
        if not 1024 <= port <= 65535:
            raise ValueError("invalid_isolated_preview_port")
        self.port = port
        self.image = image or os.environ.get(
            "LZCORE_CODING_EXECUTION_IMAGE", "lzcore-coding-runtime:local"
        )
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./:@-]*", self.image):
            raise ValueError("invalid_coding_execution_image")
        self.cli, self.client_env = _client_configuration()
        self.name = "lzcore-project-" + uuid.uuid4().hex
        self.network = self.name + "-network"
        self.broker = self.name + "-packages"
        self.closed = False
        self.started = False
        self.image_id = ""
        self.cleanup_confirmed = False
        self.cleanup_errors: list[str] = []

    def _docker(self, *arguments, timeout=90, check=True):
        result = subprocess.run(
            [*self.cli, *arguments],
            env=self.client_env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
        if check and result.returncode:
            raise RuntimeError(
                "isolated_execution_setup_failed: "
                + (result.stderr or result.stdout)[-1500:]
            )
        return result

    def start(self):
        if self.started or self.closed:
            raise ValueError("isolated_execution_invalid_lifecycle")
        try:
            self.image_id = self._docker(
                "image", "inspect", "--format", "{{.Id}}", self.image
            ).stdout.strip()
            if not re.fullmatch(r"sha256:[0-9a-f]{64}", self.image_id):
                raise ValueError("invalid_coding_image_digest")
            self._docker("network", "create", "--internal", self.network)
            shared = [
                "--init",
                "--read-only",
                "--cap-drop=ALL",
                "--security-opt=no-new-privileges",
                "--pids-limit=256",
                "--tmpfs=/tmp:rw,nosuid,nodev,size=512m",
            ]
            self._docker(
                "run",
                "--detach",
                "--pull=never",
                "--name",
                self.broker,
                *shared,
                "--memory=128m",
                "--cpus=0.5",
                "--user=65532:65532",
                "--publish",
                f"127.0.0.1:{self.port}:{self.port}",
                "--env",
                f"PROJECT_HOST={self.name}",
                "--env",
                f"PROJECT_PORT={self.port}",
                self.image_id,
                "python3",
                "-u",
                "-c",
                PROXY_PROGRAM,
            )
            self._docker(
                "network",
                "connect",
                "--alias=package-egress",
                self.network,
                self.broker,
            )
            self._docker(
                "run",
                "--detach",
                "--pull=never",
                "--name",
                self.name,
                *shared,
                "--memory=1536m",
                "--cpus=2",
                f"--user={(getattr(os, 'getuid', lambda: 65532)() or 65532)}:{(getattr(os, 'getgid', lambda: 65532)() or 65532)}",
                "--network",
                self.network,
                "--mount",
                f"type=bind,source={self.mount_source},target={self.mount_target}",
                f"--workdir={self.mount_target}",
                "--env=HOME=/tmp/home",
                "--env=HTTPS_PROXY=http://package-egress:3128",
                "--env=HTTP_PROXY=http://package-egress:3128",
                "--env=NO_PROXY=localhost,127.0.0.1,::1",
                self.image_id,
                "sh",
                "-c",
                "mkdir -p /tmp/home && exec sleep infinity",
            )
            self.started = True
            return self
        except Exception:
            self.close()
            raise

    def descriptor(self):
        return {
            "isolation_level": self.isolation_level,
            "os": "Linux",
            "cwd": self.mount_target,
            "project": self.mount_target,
            "image_id": self.image_id,
            "network": "internal_with_dependency_only_tls_egress",
            "preview_port": self.port,
            "closed": self.closed,
            "cleanup_confirmed": self.cleanup_confirmed,
            "cleanup_errors": self.cleanup_errors,
        }

    def execute(
        self, command: str, cwd: str, *, env=None, timeout=None, cancel_check=None
    ):
        return self._execute(
            ["/bin/bash", "-c", command],
            cwd,
            env=env,
            timeout=timeout,
            cancel_check=cancel_check,
        )

    def _execute(
        self, argv: list[str], cwd: str, *, env=None, timeout=None, cancel_check=None
    ):
        if self.closed or not self.started:
            return {
                "ok": False,
                "executed": False,
                "error_code": "ISOLATED_ENVIRONMENT_CLOSED",
                "error": "isolated project environment is closed; host fallback is forbidden",
            }
        relative = Path(cwd).resolve().relative_to(self.root)
        # The host adapter's default workspace cwd denotes the bound project
        # in a strict environment. Shell and Python share this writable root;
        # an explicit workspace-relative project subdirectory stays explicit.
        target = "/workspace/" + relative.as_posix() if relative.parts else self.mount_target
        if not (
            target == self.mount_target or target.startswith(self.mount_target + "/")
        ):
            return {
                "ok": False,
                "executed": False,
                "error": "directory is not in the isolated project",
            }
        args = [*self.cli, "exec", "--workdir", target]
        for key, value in (env or {}).items():
            if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(key)) or "\x00" in str(
                value
            ):
                return {
                    "ok": False,
                    "executed": False,
                    "error": "invalid subprocess environment",
                }
            args += ["--env", f"{key}={value}"]
        from core.tools.general_tools.shared import _run_shell

        result = _run_shell(
            "isolated command",
            cwd=str(self.root),
            env=self.client_env,
            timeout=timeout,
            cancel_check=cancel_check,
            argv_override=[*args, self.name, *argv],
        )
        if result.get("cancelled") or result.get("process_tree_killed"):
            stopped = self.close()
            result.update(
                executed=True,
                automatic_retry_allowed=False,
                execution_may_continue=not stopped,
                isolated_environment_stopped=stopped,
            )
            if not stopped:
                result["execution_outcome"] = "unknown"
        result.update(
            isolation_level=self.isolation_level,
            runner="project_container",
            image_id=self.image_id,
            working_dir=target.removeprefix("/workspace/"),
            container_cwd=target,
        )
        return result

    def execute_python(
        self, code: str, *, input_data=None, timeout=10, cancel_check=None
    ):
        from core.tools.python_program import build_program, decode_program_output

        program = build_program(code, input_data)
        result = self._execute(
            ["python3", "-c", program],
            str(self.project),
            timeout=timeout,
            cancel_check=cancel_check,
        )
        return decode_program_output(result)

    def close(self):
        # Retry failed cleanup, but never reopen execution or fall back to host.
        if self.cleanup_confirmed:
            return True
        self.closed = True
        errors = []
        for name in (self.name, self.broker):
            try:
                removed = self._docker("rm", "--force", name, timeout=10, check=False)
                # An explicit absent-container response also confirms stopping.
                if removed.returncode and "No such container" not in removed.stderr:
                    errors.append(f"container cleanup failed: {name}")
            except (OSError, subprocess.SubprocessError, RuntimeError):
                errors.append(f"container cleanup unavailable: {name}")
        try:
            removed = self._docker(
                "network", "rm", self.network, timeout=10, check=False
            )
            if removed.returncode and "not found" not in removed.stderr:
                errors.append("project network cleanup failed")
        except (OSError, subprocess.SubprocessError, RuntimeError):
            errors.append("project network cleanup unavailable")
        self.cleanup_errors = errors
        self.cleanup_confirmed = not errors
        return self.cleanup_confirmed


@contextmanager
def isolated_project(workspace_id: str, project: Path, port: int, **options):
    key = str(workspace_root(workspace_id).resolve())
    with _LOCK:
        if key in _BINDINGS:
            raise ValueError("isolated_workspace_binding_already_exists")
        environment = DockerProjectEnvironment(workspace_id, project, port, **options)
        _BINDINGS[key] = environment
    try:
        environment.start()
        yield environment
    finally:
        # Keep the closed binding so delayed operations cannot execute on host.
        environment.close()
