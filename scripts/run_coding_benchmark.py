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
    parser.add_argument("--session-id", help="Continue an existing benchmark session in --output's isolated storage")
    parser.add_argument("--prompt", type=Path, help="An explicit benchmark or acceptance-feedback prompt")
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
                parser.error("fresh benchmark preview port is already occupied; choose another port")
    base = (args.output or Path(tempfile.mkdtemp(prefix="lzcore-coding-bench-"))).resolve()
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

    ws = validate_workspace_id(args.workspace_id or f"bench_{args.case}_{uuid.uuid4().hex[:10]}")
    ensure_workspace(ws)
    origin = f"http://127.0.0.1:{args.port}"
    # Server configuration grants precisely this disposable workspace's port.
    # This never enables private-network or arbitrary JS evaluation switches.
    os.environ["LZCORE_BROWSER_LOCAL_PREVIEWS"] = json.dumps({f"local/{ws}": [origin]})
    config = resolve_provider_config()
    if not config.get("enabled") or not config.get("key_loaded"):
        raise RuntimeError("A real enabled provider with loaded credentials is required")
    prompt_path = args.prompt or ROOT / "harness/fixtures/coding_bench" / f"{args.case}.md"
    prompt = prompt_path.read_text().replace("{{PROJECT_DIR}}", f"files/data/{args.case}").replace("{{PREVIEW_ORIGIN}}", origin)
    session_id = args.session_id or create_session(ws, title=f"Coding benchmark: {args.case}")["session_id"]
    report = base / "reports" / ws / uuid.uuid4().hex[:10]
    report.mkdir(parents=True)
    metadata = {key: config.get(key) for key in ("provider", "model", "provider_type", "timeout", "max_tokens", "config_source")}
    metadata.update(case=args.case, session_id=session_id, workspace_id=ws, workspace=str(workspace_root(ws)),
                    preview_origin=origin, deadline_seconds=args.deadline,
                    prompt_sha256=hashlib.sha256(prompt.encode()).hexdigest(),
                    source_commit=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
                    source_diff_sha256=hashlib.sha256(subprocess.check_output(["git", "diff", "HEAD"], cwd=ROOT)).hexdigest())
    # Dirty experimental sources are part of reproducibility, too. Limit this
    # inventory to code/test roots; user output and configuration are excluded.
    untracked = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "-z", "--",
                                        "agent", "core", "storage", "harness", "scripts"], cwd=ROOT)
    metadata["untracked_source_sha256"] = {
        name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
        for name in untracked.decode().split("\0") if name and (ROOT / name).is_file()
    }
    (report / "configuration.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
    (report / "prompt.md").write_text(prompt)
    cancel = threading.Event()
    timer = threading.Timer(args.deadline, cancel.set)
    timer.daemon = True
    started = time.monotonic()
    lock = threading.Lock()

    def on_event(event):
        with lock, (report / "events.jsonl").open("a") as stream:
            stream.write(json.dumps(redact_value(event), ensure_ascii=False, default=str) + "\n")
        if event.get("type") in {"execution_started", "turn_completed", "model_completed"}:
            print(json.dumps({key: event[key] for key in ("type", "action", "ok", "iteration") if key in event}), flush=True)

    print(json.dumps({"report": str(report), "workspace": ws, "session": session_id}), flush=True)
    StreamEmitter.set_realtime_callback(on_event)
    timer.start()
    try:
        result = AgentApp().submit_user_message(prompt, workspace_id=ws, session_id=session_id,
            metadata={"transport": "coding_benchmark"},
            runtime_control=MainAgentRuntimeControl(cancel_check=cancel.is_set))
        payload = redact_value(result.to_dict())
        payload["benchmark_duration_seconds"] = round(time.monotonic() - started, 2)
        payload["deadline_reached"] = cancel.is_set()
        (report / "result.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
        print(json.dumps({"report": str(report), "runtime_ok": result.ok,
                          "independent_acceptance": "NOT VERIFIED", "duration_seconds": payload["benchmark_duration_seconds"]}), flush=True)
        return 0 if result.ok else 1
    finally:
        timer.cancel()
        StreamEmitter.clear_realtime_callback()
        # Release precisely this Agent browser session, through normal policy.
        get_default_tool_runtime_client().invoke("browser.manage", {"action": "close"},
            context=ToolRuntimeContext(workspace_id=ws, session_id=session_id, requested_by="turn_runner"))


if __name__ == "__main__":
    raise SystemExit(main())
