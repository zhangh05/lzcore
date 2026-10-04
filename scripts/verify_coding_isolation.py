#!/usr/bin/env python3
"""Opt-in real-kernel isolation probes through the governed tool client.

Uses exclusively owned scratch storage; never creates a host execution
fallback. Docker image/client configuration is identical to the benchmark.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--base-port", type=int, default=18850)
    args = parser.parse_args()
    if args.output.exists() or not 1 <= args.rounds <= 10 or not 1024 <= args.base_port <= 65525:
        parser.error("output must be new; rounds 1..10; base-port 1024..65525")
    args.output.mkdir(parents=True)
    os.environ["LZCORE_WORKSPACE_ROOT"] = str(args.output / "storage")
    from core.tools.context import ToolRuntimeContext
    from core.tools.integration import get_default_tool_runtime_client
    from core.tools.project_execution import isolated_project
    from storage.paths import workspace_root
    client = get_default_tool_runtime_client()
    reports = []
    for index in range(args.rounds):
        ws = "kernel-" + uuid.uuid4().hex[:12]
        project = workspace_root(ws) / "files/data/project"
        project.mkdir(parents=True)
        canary = args.output.resolve() / f"outside-{index}.txt"
        canary.write_text("owned-test-only-canary", encoding="utf-8")
        (project / "host-link").symlink_to(canary)
        context = ToolRuntimeContext(workspace_id=ws, session_id="kernel-session", requested_by="subagent")
        checks = []
        def probe(name: str, arguments: dict, success: bool):
            result = client.invoke("exec.run", arguments, context=context)
            passed = (result.status == "succeeded") == success
            checks.append({"name": name, "passed": passed, "runtime_status": result.status})
        with isolated_project(ws, project, args.base_port + index) as environment:
            descriptor = environment.descriptor()
            probe("authorized_source_write", {"action": "shell", "command": "printf 'scoped' > files/data/project/owned.txt"}, True)
            probe("framework_evaluator_socket_not_mounted", {"action": "shell", "command":
                f"test ! -e {ROOT.as_posix()} && test ! -e /project/harness && test ! -S /var/run/docker.sock"}, True)
            probe("outside_project_canary_denied", {"action": "python", "code": f"result = open({str(canary)!r}).read()"}, False)
            probe("symlink_cannot_reach_host", {"action": "shell", "command": "cat files/data/project/host-link"}, False)
            probe("root_filesystem_readonly", {"action": "shell", "command": "touch /usr/local/host-escape"}, False)
            probe("cwd_traversal_denied", {"action": "shell", "working_dir": "../../", "command": "echo escaped"}, False)
            probe("registry_tls_dependency_allowed", {"action": "shell", "command": "npm view react version", "timeout": 30}, True)
            probe("unapproved_tls_origin_denied", {"action": "python", "code": "import urllib.request; result = urllib.request.urlopen('https://example.com', timeout=5).status", "timeout": 10}, False)
            probe("direct_network_cannot_bypass_proxy", {"action": "python", "code": "import socket; result = socket.create_connection(('1.1.1.1', 443), timeout=2).getpeername()", "timeout": 5}, False)
            # Detached children and their parent are stopped as one kernel
            # resource, not merely by killing a local Docker client process.
            probe("timeout_stops_descendants", {"action": "shell", "command": "sleep 120 & wait", "timeout": 1}, False)
            checks.append({"name": "timeout_environment_stopped", "passed": environment.closed and environment.cleanup_confirmed})
            probe("late_child_never_falls_back_to_host", {"action": "shell", "command": "touch files/data/project/late-host-write"}, False)
        checks.append({"name": "late_write_absent", "passed": not (project / "late-host-write").exists()})
        checks.append({"name": "kernel_cleanup_confirmed", "passed": environment.cleanup_confirmed})
        reports.append({"round": index + 1, "environment": descriptor, "checks": checks})
        print(json.dumps({"round": index + 1, "passed": all(item["passed"] for item in checks)}), flush=True)
    (args.output / "report.json").write_text(json.dumps(reports, indent=2), encoding="utf-8")
    return 0 if all(item["passed"] for report in reports for item in report["checks"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
