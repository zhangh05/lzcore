#!/usr/bin/env python3
"""Opt-in kernel proof that generated engines cannot replace host assertions."""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output must be new owned scratch storage")
    args.output.mkdir(parents=True)
    os.environ["LZCORE_WORKSPACE_ROOT"] = str(args.output / "storage")
    from core.tools.project_execution import isolated_project
    from scripts.benchmark_runtime import BenchmarkRuntime
    from storage.paths import workspace_root

    workspace = "evaluator-" + uuid.uuid4().hex[:12]
    project = workspace_root(workspace) / "files/data/project"
    project.mkdir(parents=True)
    (project / "package.json").write_text('{"private":true,"type":"module"}')
    # This fixture deliberately tampers with the isolated process's assert.
    # It cannot see the verifier or change its own acceptance criteria.
    (project / "engine.cjs").write_text("""
const assert = require('node:assert/strict');
assert.equal = () => {}; assert.ok = () => {};
exports.createGame = options => {
 let tick=0;
 return {step:n=>{tick+=n},snapshot:()=>({tick,seed:options.seed,fog:new Uint8Array([1,0,1])}),
 getState:()=>({hasVerifier:process.execArgv.some(a=>a.includes('trusted_verifier_canary'))}),
 command:()=>{},debugScenario:()=>{},save:()=>({tick}),load:state=>{tick=state.tick}};
};
""")
    (project / "engine.cjs").chmod(0o600)
    (project / "helper.ts").write_text('export enum Mode { Running }; export const advance = (tick:number,n:number):number => tick+n;')
    (project / "engine.ts").write_text("""
import { advance, Mode } from './helper';
export const createGame = (options: {seed:number}) => {
 let tick:number=0;
 return {step:(n:number)=>{tick=advance(tick,n)},
 snapshot:()=>({tick,seed:options.seed,fog:new Uint8Array([1,0,1])}),
 getState:()=>({hasVerifier:process.execArgv.some(a=>a.includes('trusted_verifier_canary')),mode:Mode.Running}),
 command:()=>{},debugScenario:()=>{},save:()=>({tick}),load:(state:{tick:number})=>{tick=state.tick}};
};
""")
    reports = []
    with isolated_project(workspace, project, 18859) as environment:
        runtime = BenchmarkRuntime(
            environment.name, environment.image_id, project, environment.mount_target
        )
        for seed in (17, 59, 103):
            prefix = "const assert=require('node:assert/strict'); /* trusted_verifier_canary */\n"
            normal = (
                prefix
                + f"(async()=>{{const g=await __engineBridge.createGame({{seed:{seed}}});await g.step(3);const s=await g.snapshot();assert.equal(s.tick,3);assert.deepEqual(s.fog,[1,0,1]);assert.equal((await g.getState()).hasVerifier,false);console.log(JSON.stringify(s));}})().catch(e=>{{console.error(e.message);process.exitCode=1}}).finally(()=>__engineBridge.close());"
            )
            positive = runtime.independent_program(
                normal, "engine.cjs", "positive", seed
            )
            negative = runtime.independent_program(
                normal.replace("assert.equal(s.tick,3)", "assert.equal(s.tick,999)"),
                "engine.cjs",
                "adversarial",
                seed,
            )
            typescript = runtime.independent_program(normal, "engine.ts", "typescript", seed)
            reports.append(
                {
                    "seed": seed,
                    "positive_pass": positive.returncode == 0,
                    "typescript_without_project_compiler_pass": typescript.returncode == 0,
                    "positive_error": positive.stderr[-500:]
                    if positive.returncode
                    else "",
                    "assertion_tamper_rejected": negative.returncode != 0,
                    "verifier_not_exposed": positive.returncode == 0,
                }
            )
    reports.append({"cleanup_confirmed": environment.cleanup_confirmed})
    (args.output / "report.json").write_text(json.dumps(reports, indent=2))
    print(json.dumps(reports))
    return (
        0
        if all(
            r.get("positive_pass", True)
            and r.get("typescript_without_project_compiler_pass", True)
            and r.get("assertion_tamper_rejected", True)
            and r.get("cleanup_confirmed", True)
            for r in reports
        )
        else 1
    )


if __name__ == "__main__":
    raise SystemExit(main())
