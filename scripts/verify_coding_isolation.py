#!/usr/bin/env python3
"""Opt-in real-kernel isolation probes through the governed tool client.

Uses exclusively owned scratch storage; never creates a host execution
fallback. Docker image/client configuration is identical to the benchmark.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
import uuid
from pathlib import Path

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
    from core.tools.project_execution import isolated_project, reconcile_environment
    from storage.paths import workspace_root
    from storage.project_changes import quiescent_project
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
        def probe(name: str, arguments: dict, success: bool, *, context=context, checks=checks):
            result = client.invoke("exec.run", arguments, context=context)
            passed = (result.status == "succeeded") == success
            checks.append({"name": name, "passed": passed, "runtime_status": result.status})
        with isolated_project(ws, project, args.base_port + index) as environment:
            descriptor = environment.descriptor()
            try:
                reconcile_environment(descriptor)
                still_live_rejected = False
            except ValueError as exc:
                still_live_rejected = str(exc) == "coding_execution_resources_unresolved"
            checks.append({"name": "readback_does_not_resolve_live_container", "passed": still_live_rejected})
            probe("authorized_default_project_source_write", {"action": "shell", "command": "printf 'scoped' > owned.txt"}, True)
            checks.append({"name": "default_write_in_project", "passed": (project / "owned.txt").exists() and (project / "owned.txt").read_text() == "scoped"})
            probe("explicit_workspace_project_directory", {"action": "shell", "working_dir": "files/data/project", "command": "test -f owned.txt && pwd"}, True)
            probe("python_default_matches_shell_project", {"action": "python", "code": "from pathlib import Path; assert Path('owned.txt').read_text() == 'scoped'; result = str(Path.cwd())"}, True)
            probe("framework_evaluator_socket_not_mounted", {"action": "shell", "command":
                f"test ! -e {ROOT.as_posix()} && test ! -e /project/harness && test ! -S /var/run/docker.sock"}, True)
            probe("outside_project_canary_denied", {"action": "python", "code": f"result = open({str(canary)!r}).read()"}, False)
            probe("symlink_cannot_reach_host", {"action": "shell", "command": "cat host-link"}, False)
            probe("root_filesystem_readonly", {"action": "shell", "command": "touch /usr/local/host-escape"}, False)
            probe("cwd_traversal_denied", {"action": "shell", "working_dir": "../../", "command": "echo escaped"}, False)
            probe("registry_tls_dependency_allowed", {"action": "shell", "command": "npm view react version", "timeout": 30}, True)
            if index == 0:
                from scripts.benchmark_native_addon_probe import verify_native_addon_gc, verify_temporary_native_addon

                checks.extend(verify_native_addon_gc(client, context, "files/data/project"))
                checks.append(verify_temporary_native_addon(client, context, "implementation"))
                probe("native_dependency_compiles_using_image_headers", {"action": "shell", "command":
                    "npm_config_build_from_source=true npm install better-sqlite3@13.0.3", "timeout": 180}, True)
                probe("compiled_sqlite_runs_real_query", {"action": "shell", "command":
                    "node -e \"const Database=require('better-sqlite3');const db=new Database(':memory:');"
                    "db.exec('CREATE TABLE records (value INTEGER)');db.prepare('INSERT INTO records VALUES (?)').run(42);"
                    "if(db.prepare('SELECT value FROM records').get().value!==42)process.exit(1);db.close();\"",
                    "timeout": 30}, True)
                probe("dependency_executable_installed", {"action": "shell", "command":
                    "npm install typescript@5.9.3", "timeout": 180}, True)
            probe("unapproved_tls_origin_denied", {"action": "python", "code": "import urllib.request; result = urllib.request.urlopen('https://example.com', timeout=5).status", "timeout": 10}, False)
            probe("direct_network_cannot_bypass_proxy", {"action": "python", "code": "import socket; result = socket.create_connection(('1.1.1.1', 443), timeout=2).getpeername()", "timeout": 5}, False)
            # The escape probe must not become a valid reviewed build source.
            (project / "host-link").unlink()
            with quiescent_project(ws):
                environment.coordinate(["dist"])
            descriptor = environment.descriptor()
            rebuild = "node -e \"const fs=require('fs');fs.rmSync('dist',{recursive:true,force:true});fs.mkdirSync('dist');fs.writeFileSync('dist/rebuilt.txt','rebuilt');\""
            poison = "node -e \"require('fs').writeFileSync('owned.txt','tampered');\""
            compiler_probe = "node_modules/.bin/tsc --version"
            environment.configure_validation([rebuild, poison, compiler_probe])
            if index == 0:
                from scripts.benchmark_native_addon_probe import TEMP_NATIVE_COMMAND

                checks.append(verify_temporary_native_addon(client, context, "readonly"))
                environment.configure_validation([rebuild, poison, compiler_probe, TEMP_NATIVE_COMMAND])
                checks.append(verify_temporary_native_addon(client, context, "validation_snapshot"))
                probe("dependency_bin_link_preserved_in_validation_snapshot", {"action":"shell", "command":compiler_probe, "timeout":30}, True)
            probe("standard_rebuild_deletes_output_root_in_snapshot", {"action":"shell", "command":rebuild, "timeout":30}, True)
            checks.append({"name":"validated_output_promoted", "passed": (project / "dist/rebuilt.txt").is_file() and (project / "dist/rebuilt.txt").read_text() == "rebuilt"})
            from scripts.benchmark_runtime import BenchmarkRuntime
            independent = BenchmarkRuntime(environment.name, environment.image_id, project.resolve(), environment.mount_target)
            independent_build = independent.generated_command(["node", "-e", "const fs=require('fs');fs.rmSync('dist',{recursive:true,force:true});fs.mkdirSync('dist');fs.writeFileSync('dist/evaluator.txt','checked');"], timeout=30)
            checks.append({"name":"independent_acceptance_uses_shared_build_snapshot", "passed": independent_build.returncode == 0 and (project / "dist/evaluator.txt").is_file()})
            probe("validation_source_change_rejected", {"action":"shell", "command":poison, "timeout":30}, False)
            checks.append({"name":"validation_keeps_reviewed_source", "passed": (project / "owned.txt").read_text() == "scoped"})
            probe("coordinator_source_write_denied_by_kernel", {"action": "shell", "command": "printf 'unreviewed' > owned.txt"}, False)
            probe("coordinator_source_delete_denied_by_kernel", {"action": "shell", "command": "rm owned.txt"}, False)
            probe("coordinator_source_write_denied_by_api", {"action": "shell", "command": "test \"$(cat owned.txt)\" = scoped"}, True)
            protected = client.invoke("workspace.file", {"action":"edit", "filepath":"files/data/project/owned.txt", "old_string":"scoped", "new_string":"unreviewed"}, context=context)
            checks.append({"name":"governed_source_edit_denied", "passed": protected.status == "failed" and (project / "owned.txt").read_text() == "scoped"})
            probe("declared_build_output_writable", {"action":"shell", "command":"printf 'built' > dist/output.txt"}, True)
            probe("temporary_runtime_output_writable", {"action":"shell", "command":"printf 'runtime' > /tmp/owned.log"}, True)
            probe("preview_bind_contract_stable", {"action":"python", "code":"import os; assert os.environ['PORT'] == '8080' and os.environ['HOST'] == '0.0.0.0'; result = True"}, True)
            probe("preview_service_in_readonly_project", {"action":"shell", "command":"python3 -m http.server \"$PORT\" --bind \"$HOST\" </dev/null >/tmp/owned-preview.log 2>&1 &"}, True)
            forwarded = False
            until = time.monotonic() + 10
            while time.monotonic() < until:
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{args.base_port + index}", timeout=1) as response:
                        forwarded = response.status == 200
                    break
                except OSError:
                    time.sleep(0.2)
            checks.append({"name":"external_port_maps_stable_internal_preview", "passed": forwarded})
            # Detached children and their parent are stopped as one kernel
            # resource, not merely by killing a local Docker client process.
            probe("timeout_stops_descendants", {"action": "shell", "command": "sleep 120 & wait", "timeout": 1}, False)
            checks.append({"name": "timeout_environment_stopped", "passed": environment.closed and environment.cleanup_confirmed})
            probe("late_child_never_falls_back_to_host", {"action": "shell", "command": "touch late-host-write"}, False)
        checks.append({"name": "late_write_absent", "passed": not (project / "late-host-write").exists()})
        checks.append({"name": "kernel_cleanup_confirmed", "passed": environment.cleanup_confirmed})
        # Simulate loss of the cleanup acknowledgement, preserving the actual
        # original daemon/resource identity. Recovery only reads Docker state.
        unconfirmed = {**environment.descriptor(), "cleanup_confirmed": False}
        recovered = reconcile_environment(unconfirmed)
        checks.append({"name": "lost_cleanup_ack_readback_confirms_original_resources_absent",
                       "passed": recovered["cleanup_confirmed"] and recovered["observed_via"] == "docker_readback"
                       and recovered["runtime_resources"] == unconfirmed["runtime_resources"]
                       and recovered["daemon_id"] == unconfirmed["daemon_id"]})
        reports.append({"round": index + 1, "environment": descriptor, "checks": checks})
        print(json.dumps({"round": index + 1, "passed": all(item["passed"] for item in checks)}), flush=True)
    (args.output / "report.json").write_text(json.dumps(reports, indent=2), encoding="utf-8")
    return 0 if all(item["passed"] for report in reports for item in report["checks"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
