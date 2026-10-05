#!/usr/bin/env python3
"""Opt-in real-provider coding benchmark, through the production Agent gateway.

Results are observations, not an acceptance score. A separate evaluator must
check the generated application. Credentials use normal provider resolution
and are neither copied nor included in reports.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import socket
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", choices=("counter", "noc", "rts"), required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--workspace-id")
    parser.add_argument(
        "--session-id",
        help="Continue an existing benchmark session in --output's isolated storage",
    )
    parser.add_argument(
        "--prompt",
        type=Path,
        help="An explicit benchmark or acceptance-feedback prompt",
    )
    parser.add_argument(
        "--require-coding-team",
        action="store_true",
        help="Independently require successful exact-candidate QA and actual integration",
    )
    parser.add_argument("--deadline", type=int, default=1800)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535 or args.deadline < 1:
        parser.error("port must be 1024..65535 and deadline must be positive")
    if args.session_id and (not args.output or not args.workspace_id):
        parser.error("resuming requires explicit --output and --workspace-id")
    if not args.session_id:
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", args.port))
            except OSError:
                parser.error(
                    "fresh benchmark preview port is already occupied; choose another port"
                )
    base = (
        args.output or Path(tempfile.mkdtemp(prefix="lzcore-coding-bench-"))
    ).resolve()
    base.mkdir(parents=True, exist_ok=True)
    os.environ["LZCORE_WORKSPACE_ROOT"] = str(base / "storage")
    os.environ["LZCORE_MEMORY_DIR"] = str(base / "memory")
    os.environ["LZCORE_LLM_ENABLED"] = "true"
    from storage.ids import validate_workspace_id
    from storage.workspace_store import ensure_workspace
    from storage.session_store import create_session
    from storage.redaction import redact_value
    from storage.paths import workspace_root
    from agent.llm.config import resolve_provider_config
    from agent.app.facade import AgentApp
    from agent.runtime.stream_emitter import StreamEmitter
    from core.runtime_engine.models import MainAgentRuntimeControl
    from core.tools.integration import get_default_tool_runtime_client
    from core.tools.context import ToolRuntimeContext
    from core.tools.project_execution import isolated_project, PREVIEW_BIND_PORT

    ws = validate_workspace_id(
        args.workspace_id or f"bench_{args.case}_{uuid.uuid4().hex[:10]}"
    )
    ensure_workspace(ws)
    origin = f"http://127.0.0.1:{args.port}"
    # Server configuration grants precisely this disposable workspace's port.
    # This never enables private-network or arbitrary JS evaluation switches.
    os.environ["LZCORE_BROWSER_LOCAL_PREVIEWS"] = json.dumps({f"local/{ws}": [origin]})
    config = resolve_provider_config()
    prompt_path = (
        args.prompt or ROOT / "harness/fixtures/coding_bench" / f"{args.case}.md"
    )
    prompt = (
        prompt_path.read_text(encoding="utf-8")
        .replace("{{PROJECT_DIR}}", f"files/data/{args.case}")
        .replace("{{PREVIEW_ORIGIN}}", origin)
    )
    prompt += f"\n执行环境是受系统隔离的 Linux 容器，依赖经专用 registry 代理。预览须使用进程环境 HOST/PORT（0.0.0.0:{PREVIEW_BIND_PORT}），浏览器 origin 的端口只是平台转发入口，不能写进源码或用于容器监听。实现分支可写源码；QA 与团队协调者源码为只读，只能写声明的输出目录和 /tmp。日志/PID/临时检查放 /tmp；修改源码须重新委派准确候选 QA 与整合。不要修改隔离环境或启动宿主服务。\n"
    session_id = (
        args.session_id
        or create_session(ws, title=f"Coding benchmark: {args.case}")["session_id"]
    )
    report = base / "reports" / ws / uuid.uuid4().hex[:10]
    report.mkdir(parents=True)
    metadata = {
        key: config.get(key)
        for key in (
            "provider",
            "model",
            "provider_type",
            "timeout",
            "max_tokens",
            "config_source",
        )
    }
    metadata.update(
        case=args.case,
        session_id=session_id,
        workspace_id=ws,
        workspace=str(workspace_root(ws)),
        preview_origin=origin,
        deadline_seconds=args.deadline,
        prompt_sha256=hashlib.sha256(prompt.encode()).hexdigest(),
        source_commit=subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
        ).strip(),
        source_diff_sha256=hashlib.sha256(
            subprocess.check_output(["git", "diff", "HEAD"], cwd=ROOT)
        ).hexdigest(),
    )
    # Dirty experimental sources are part of reproducibility, too. Limit this
    # inventory to code/test roots; user output and configuration are excluded.
    untracked = subprocess.check_output(
        [
            "git",
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            "agent",
            "core",
            "storage",
            "harness",
            "scripts",
            "extensions",
            "frontend",
        ],
        cwd=ROOT,
    )
    metadata["untracked_source_sha256"] = {
        name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
        for name in untracked.decode().split("\0")
        if name and (ROOT / name).is_file()
    }
    (report / "configuration.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (report / "prompt.md").write_text(prompt, encoding="utf-8")
    from scripts.benchmark_preflight import provider_preflight

    readiness = provider_preflight(config)
    (report / "preflight.json").write_text(
        json.dumps(readiness, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    if readiness["status"] != "READY":
        blocked = {
            "schema": "coding.benchmark_verdict.v1",
            "status": "BLOCKED",
            "stage": "provider_preflight",
            "reason": readiness["reason"],
            "agent_started": False,
            "named_acceptance_passed": None,
            "execution_environment_started": False,
            "cleanup_required": False,
            "full_benchmark_acceptance": "NOT VERIFIED",
        }
        (report / "verdict.json").write_text(
            json.dumps(blocked, indent=2), encoding="utf-8"
        )
        print(json.dumps({"report": str(report), **blocked}), flush=True)
        return 2
    cancel = threading.Event()
    timer = threading.Timer(args.deadline, cancel.set)
    timer.daemon = True
    started = time.monotonic()
    lock = threading.Lock()

    def on_event(event):
        with lock, (report / "events.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(
                json.dumps(redact_value(event), ensure_ascii=False, default=str) + "\n"
            )
        if event.get("type") in {
            "execution_started",
            "turn_completed",
            "model_completed",
        }:
            print(
                json.dumps(
                    {
                        key: event[key]
                        for key in ("type", "action", "ok", "iteration")
                        if key in event
                    }
                ),
                flush=True,
            )

    print(
        json.dumps({"report": str(report), "workspace": ws, "session": session_id}),
        flush=True,
    )
    project = workspace_root(ws) / "files/data" / args.case
    environment_scope = isolated_project(ws, project, args.port,
        source_mode="coordinator" if args.require_coding_team else "implementation",
        generated_paths=["dist"] if args.require_coding_team else [])
    environment = None
    acceptance_report = None
    deadline_reached = False
    exit_code = 1
    agent_turn_ok, acceptance_exit_code, team_ok, cleanup_confirmed = (
        False,
        None,
        False,
        False,
    )
    try:
        environment = environment_scope.__enter__()
        metadata["execution_environment"] = environment.descriptor()
        (report / "configuration.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        StreamEmitter.set_realtime_callback(on_event)
        timer.start()
        result = AgentApp().submit_user_message(
            prompt,
            workspace_id=ws,
            session_id=session_id,
            metadata={"transport": "coding_benchmark"},
            runtime_control=MainAgentRuntimeControl(cancel_check=cancel.is_set),
        )
        agent_turn_ok = result.ok
        deadline_reached = cancel.is_set()
        payload = redact_value(result.to_dict())
        payload["benchmark_duration_seconds"] = round(time.monotonic() - started, 2)
        payload["deadline_reached"] = deadline_reached
        (report / "result.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, default=str),
            encoding="utf-8",
        )
        print(
            json.dumps(
                {
                    "report": str(report),
                    "agent_turn_ok": result.ok,
                    "independent_acceptance": "NOT VERIFIED",
                    "duration_seconds": payload["benchmark_duration_seconds"],
                }
            ),
            flush=True,
        )
        team_ok = True
        if args.require_coding_team:
            from scripts.benchmark_team_acceptance import verify_team

            try:
                team_evidence = verify_team(ws, session_id, f"files/data/{args.case}")
            except (AssertionError, ValueError, KeyError) as exc:
                team_ok = False
                team_evidence = {"status": "FAIL", "error": str(exc)}
            (report / "team_acceptance.json").write_text(
                json.dumps(team_evidence, indent=2), encoding="utf-8"
            )
            print(json.dumps({"team_acceptance": team_evidence["status"]}), flush=True)
        acceptance = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/evaluate_coding_benchmark.py"),
                "--case",
                args.case,
                "--project",
                str(project),
                "--origin",
                origin,
                "--report",
                str(report / "acceptance.json"),
                "--runtime-container",
                environment.name,
                "--runtime-image",
                environment.image_id,
                "--runtime-project",
                environment.mount_target,
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=600,
        )
        (report / "acceptance.log").write_text(
            acceptance.stdout + acceptance.stderr, encoding="utf-8"
        )
        print(
            json.dumps({"independent_acceptance_exit_code": acceptance.returncode}),
            flush=True,
        )
        acceptance_exit_code = acceptance.returncode
        try:
            acceptance_report = json.loads((report / "acceptance.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            # A process return code without its complete independent evidence
            # cannot authorize a benchmark PASS.
            acceptance_report = None
    finally:
        cancel.set()
        timer.cancel()
        from scripts.benchmark_cleanup import drain_delegations

        delegated_cleanup = drain_delegations(
            get_default_tool_runtime_client(), ws, session_id
        )
        (report / "delegation_cleanup.json").write_text(
            json.dumps(delegated_cleanup, indent=2), encoding="utf-8"
        )
        StreamEmitter.clear_realtime_callback()
        if environment is not None:
            environment_scope.__exit__(None, None, None)
            cleanup = environment.descriptor()
            (report / "execution_cleanup.json").write_text(
                json.dumps(cleanup, indent=2), encoding="utf-8"
            )
            cleanup_confirmed = (
                cleanup["cleanup_confirmed"] and delegated_cleanup["confirmed"]
            )
            if not cleanup_confirmed:
                exit_code = 1
                print(
                    json.dumps(
                        {
                            "execution_cleanup": "UNKNOWN",
                            "automatic_retry_allowed": False,
                        }
                    ),
                    flush=True,
                )
        # Release precisely this Agent browser session, through normal policy.
        get_default_tool_runtime_client().invoke(
            "browser.manage",
            {"action": "close"},
            context=ToolRuntimeContext(
                workspace_id=ws, session_id=session_id, requested_by="turn_runner"
            ),
        )
        from scripts.benchmark_verdict import benchmark_verdict

        verdict = benchmark_verdict(
            case=args.case,
            acceptance_report=acceptance_report,
            agent_turn_ok=agent_turn_ok,
            deadline_reached=deadline_reached,
            acceptance_exit_code=acceptance_exit_code,
            team_required=args.require_coding_team,
            team_ok=team_ok,
            cleanup_confirmed=cleanup_confirmed,
        )
        (report / "verdict.json").write_text(
            json.dumps(verdict, indent=2), encoding="utf-8"
        )
        print(json.dumps(verdict), flush=True)
        exit_code = 0 if verdict["status"] == "PASS" else 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
