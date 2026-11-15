"""联智中枢 agent 任务评测。

对正在运行的本机服务发真实对话，用真实模型跑 tasks.yaml 里的任务，按确定性规则判定，
输出 results.jsonl 和 report.md。每个任务用独立的临时工作区，结束后删除（--keep 保留）。

    .venv/bin/python3 evals/run.py --provider minimax
    .venv/bin/python3 evals/run.py --provider minimax --only data-total,file-edit
    .venv/bin/python3 evals/run.py --provider minimax --category 数据 --skip-network

不读取任何密钥：模型和密钥由服务端按 provider 解析。
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
import uuid
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = HERE.parent


# ── HTTP ────────────────────────────────────────────────

def _request(method: str, url: str, body: dict | None = None, timeout: float = 30) -> tuple[int, dict]:
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b"{}")
        except ValueError:
            return exc.code, {}


class Service:
    def __init__(self, base: str, root: Path, turn_timeout: float):
        self.base = base.rstrip("/")
        self.root = root
        self.turn_timeout = turn_timeout

    def create_workspace(self, ws_id: str) -> None:
        status, body = _request("POST", f"{self.base}/api/workspaces", {"workspace_id": ws_id, "name": f"评测 {ws_id}"})
        if status >= 400 or not body.get("ok"):
            raise RuntimeError(f"创建工作区失败 {ws_id}: {status} {body}")

    def delete_workspace(self, ws_id: str) -> None:
        _request("DELETE", f"{self.base}/api/workspaces/{ws_id}?confirm=true")

    def workspace_dir(self, ws_id: str) -> Path:
        return self.root / "workspaces" / ws_id

    def send(self, ws_id: str, message: str, provider: str, session_id: str | None) -> dict:
        body: dict = {
            "workspace_id": ws_id,
            "message": message,
            "stream": False,
            "metadata": {"model_selection": {"provider": provider}, "client_request_id": uuid.uuid4().hex},
        }
        if session_id:
            body["session_id"] = session_id
        for attempt in range(6):
            status, data = _request("POST", f"{self.base}/api/agent/message", body, timeout=self.turn_timeout)
            if status == 429:  # 服务端限流：10 次/分钟
                time.sleep(12 * (attempt + 1))
                continue
            data["_http_status"] = status
            return data
        return {"_http_status": 429, "ok": False, "errors": ["rate_limited"]}


# ── 判定 ────────────────────────────────────────────────

def _norm(text: str) -> str:
    return re.sub(r"(?<=\d),(?=\d{3}\b)", "", text or "")


def _files(ws_dir: Path) -> list[Path]:
    base = ws_dir / "files"
    return [p for p in base.rglob("*") if p.is_file()] if base.exists() else []


def _match_file(ws_dir: Path, spec: dict) -> tuple[bool, str]:
    base = ws_dir / "files"
    candidates = [p for p in _files(ws_dir) if fnmatch.fnmatch(p.relative_to(base).as_posix(), spec["glob"])
                  or fnmatch.fnmatch(p.name, spec["glob"].split("/")[-1])]
    if not candidates:
        return False, f"没有找到 {spec['glob']}"
    for path in candidates:
        try:
            text = _norm(path.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            continue
        if all(re.search(r, text, re.I) for r in spec.get("contains", [])) and \
                not any(re.search(r, text, re.I) for r in spec.get("not_contains", [])):
            return True, ""
    return False, f"{spec['glob']} 内容不符合（找到 {len(candidates)} 个候选）"


_CJK = re.compile(r"[\u4e00-\u9fff]")
_LATIN = re.compile(r"[A-Za-z]")


def _language_drift(prompt: str, answer: str) -> bool:
    """中文提问却用英文回复。去掉代码、路径和链接后，中文字数远少于英文字母数。"""
    if not _CJK.search(prompt):
        return False
    prose = re.sub(r"```.*?```|`[^`]*`|https?://\S+|[\w./-]+\.[A-Za-z]{2,4}\b", " ", answer, flags=re.S)
    cjk, latin = len(_CJK.findall(prose)), len(_LATIN.findall(prose))
    return latin > 40 and cjk * 4 < latin


def grade(task: dict, answer: str, tool_ids: list[str], ws_dir: Path) -> list[str]:
    checks = task.get("checks") or {}
    text = _norm(answer)
    fails: list[str] = []
    prompt = (task.get("turns") or [{}])[-1].get("say", "")
    if not checks.get("allow_english") and _language_drift(prompt, answer):
        fails.append("中文提问却用英文回复")
    for pattern in checks.get("answer", []):
        if not re.search(pattern, text, re.I):
            fails.append(f"回复缺少 /{pattern}/")
    for pattern in checks.get("answer_not", []):
        if re.search(pattern, text, re.I):
            fails.append(f"回复不应出现 /{pattern}/")
    specs = checks.get("files", [])
    if specs:
        results = [_match_file(ws_dir, s) for s in specs]
        if checks.get("files_mode") == "any":
            if not any(ok for ok, _ in results):
                fails.append("没有符合要求的输出文件：" + "；".join(m for _, m in results))
        else:
            fails.extend(m for ok, m in results if not ok)
    if checks.get("tools_any") and not set(checks["tools_any"]) & set(tool_ids):
        fails.append(f"没有用到 {checks['tools_any']}")
    if checks.get("no_tools") and tool_ids:
        fails.append(f"不该调用工具，却调用了 {sorted(set(tool_ids))}")
    return fails


# ── 运行 ────────────────────────────────────────────────

def _usage(ws_dir: Path) -> dict:
    out = {"llm_calls": 0, "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0}
    path = ws_dir / "usage" / "token_usage.jsonl"
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        out["llm_calls"] += 1
        out["input_tokens"] += int(row.get("input_tokens") or 0)
        out["output_tokens"] += int(row.get("output_tokens") or 0)
        out["cache_read_tokens"] += int(row.get("cache_read_input_tokens") or 0)
    return out


def _turn_record(resp: dict, seconds: float) -> dict:
    meta = resp.get("metadata") or {}
    calls = resp.get("tool_calls") or []
    return {
        "http": resp.get("_http_status"),
        "ok": resp.get("ok"),
        "seconds": round(seconds, 1),
        "answer": resp.get("final_response") or "",
        "errors": resp.get("errors") or [],
        "model": meta.get("model"),
        "outcome": meta.get("execution_outcome"),
        "steps": meta.get("steps"),
        "tools": [{"id": c.get("tool_id"), "ok": c.get("ok"), "summary": (c.get("summary") or "")[:160],
                   "errors": [str(e)[:200] for e in (c.get("errors") or [])]} for c in calls],
        "repairs": {
            "retry_attempts": (meta.get("retry_summary") or {}).get("retry_attempts", 0),
            "validation_corrections": (meta.get("validation_correction_summary") or {}).get("attempts", 0) or 0,
            "tool_recovery": len(meta.get("tool_recovery_events") or []),
            "provider_recovery": len(meta.get("provider_recovery_events") or []),
            "recovery_goals": len(meta.get("recovery_goal_events") or []),
            "synthesis_recovery": bool(meta.get("synthesis_recovery")),
        },
        "context_compacted": bool(meta.get("context_compacted")),
    }


def run_task(svc: Service, task: dict, provider: str, stamp: str) -> dict:
    ws_id = f"ev{stamp}-{task['id']}"[:64]
    svc.create_workspace(ws_id)
    ws_dir = svc.workspace_dir(ws_id)
    shutil.copytree(HERE / "fixtures", ws_dir / "files" / "data", dirs_exist_ok=True)
    turns: list[dict] = []
    session_id = None
    started = time.time()
    for turn in task["turns"]:
        if turn.get("session") == "new":
            session_id = None
        t0 = time.time()
        resp = svc.send(ws_id, turn["say"], provider, session_id)
        rec = _turn_record(resp, time.time() - t0)
        turns.append(rec)
        session_id = resp.get("session_id") or session_id
    answer = turns[-1]["answer"] if turns else ""
    tool_ids = [t["id"] for rec in turns for t in rec["tools"]]
    fails = grade(task, answer, tool_ids, ws_dir)
    if any(rec["http"] and rec["http"] >= 400 for rec in turns):
        fails.insert(0, "请求失败：" + "；".join(f"HTTP {r['http']} {r['errors']}" for r in turns if r["http"] >= 400))
    usage = _usage(ws_dir)
    return {
        "id": task["id"],
        "category": task.get("category", ""),
        "provider": provider,
        "passed": not fails,
        "fails": fails,
        "seconds": round(time.time() - started, 1),
        "tool_calls": sum(len(r["tools"]) for r in turns),
        "tool_errors": sum(1 for r in turns for t in r["tools"] if not t["ok"]),
        "usage": usage,
        "turns": turns,
        "workspace": ws_id,
    }


def cleanup(svc: Service, stamp: str) -> None:
    """统一在最后删除临时工作区。

    回合结束后，会话反思等后台任务还会异步写入工作区，逐个任务立即删除会被它们重新建出目录。
    所以等一会儿再删，删完再清扫一次本地残留（只清本次运行的 ev<stamp>- 前缀）。
    """
    time.sleep(20)
    prefix = f"ev{stamp}-"
    root = svc.root / "workspaces"
    for path in sorted(root.glob(prefix + "*")):
        svc.delete_workspace(path.name)
    time.sleep(5)
    for path in root.glob(prefix + "*"):
        if path.is_dir() and path.name.startswith(prefix):
            shutil.rmtree(path, ignore_errors=True)


# ── 报告 ────────────────────────────────────────────────

def _pct(a: int, b: int) -> str:
    return f"{(100 * a / b):.0f}%" if b else "—"


def write_report(results: list[dict], out: Path, provider: str) -> str:
    n = len(results)
    passed = sum(r["passed"] for r in results)
    tok_in = sum(r["usage"]["input_tokens"] for r in results)
    tok_out = sum(r["usage"]["output_tokens"] for r in results)
    cache = sum(r["usage"]["cache_read_tokens"] for r in results)
    llm_calls = sum(r["usage"]["llm_calls"] for r in results)
    tools = sum(r["tool_calls"] for r in results)
    tool_err = sum(r["tool_errors"] for r in results)
    repairs: dict[str, int] = defaultdict(int)
    for r in results:
        for t in r["turns"]:
            for k, v in t["repairs"].items():
                repairs[k] += int(v)
    tool_use: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for r in results:
        for t in r["turns"]:
            for c in t["tools"]:
                tool_use[c["id"]][0] += 1
                tool_use[c["id"]][1] += 0 if c["ok"] else 1
    model = next((t["model"] for r in results for t in r["turns"] if t.get("model")), provider)

    lines = [
        f"# 评测报告：{model}（{provider}）",
        "",
        f"生成时间 {datetime.now():%Y-%m-%d %H:%M}，共 {n} 个任务。",
        "",
        "## 总览",
        "",
        "| 指标 | 数值 |",
        "| --- | --- |",
        f"| 通过率 | **{passed}/{n}（{_pct(passed, n)}）** |",
        f"| 平均耗时 | {sum(r['seconds'] for r in results) / max(n, 1):.1f} 秒/任务 |",
        f"| 模型调用 | {llm_calls} 次，平均 {llm_calls / max(n, 1):.1f} 次/任务 |",
        f"| 输入 token | {tok_in:,}（缓存命中 {cache:,}，{_pct(cache, tok_in)}），平均每次调用 {tok_in // max(llm_calls, 1):,} |",
        f"| 输出 token | {tok_out:,} |",
        f"| 工具调用 | {tools} 次，失败 {tool_err} 次（{_pct(tool_err, tools)}） |",
        f"| 运行时修复介入 | 重试 {repairs['retry_attempts']}、参数校正 {repairs['validation_corrections']}、工具恢复 {repairs['tool_recovery']}、"
        f"模型恢复 {repairs['provider_recovery']}、目标恢复 {repairs['recovery_goals']}、合成兜底 {repairs['synthesis_recovery']} |",
        "",
        "## 分类",
        "",
        "| 类别 | 通过 | 平均工具调用 | 平均耗时 |",
        "| --- | --- | --- | --- |",
    ]
    by_cat: dict[str, list[dict]] = defaultdict(list)
    for r in results:
        by_cat[r["category"]].append(r)
    for cat, rows in by_cat.items():
        ok = sum(r["passed"] for r in rows)
        lines.append(f"| {cat} | {ok}/{len(rows)} | {sum(r['tool_calls'] for r in rows) / len(rows):.1f} | "
                     f"{sum(r['seconds'] for r in rows) / len(rows):.0f} 秒 |")
    lines += ["", "## 工具使用", "", "| 工具 | 调用 | 失败 |", "| --- | --- | --- |"]
    for tid, (cnt, err) in sorted(tool_use.items(), key=lambda kv: -kv[1][0]):
        lines.append(f"| `{tid}` | {cnt} | {err} |")
    lines += ["", "## 逐项结果", "", "| 任务 | 结果 | 工具调用 | 耗时 | 说明 |", "| --- | --- | --- | --- | --- |"]
    for r in results:
        mark = "通过" if r["passed"] else "**失败**"
        note = "；".join(r["fails"])[:160].replace("|", "\\|")
        lines.append(f"| {r['id']} | {mark} | {r['tool_calls']} | {r['seconds']:.0f} 秒 | {note} |")
    failed = [r for r in results if not r["passed"]]
    if failed:
        lines += ["", "## 失败详情", ""]
        for r in failed:
            lines += [f"### {r['id']}", ""]
            for f in r["fails"]:
                lines.append(f"- {f}")
            for i, t in enumerate(r["turns"], 1):
                chain = " → ".join(f"{c['id']}{'' if c['ok'] else '✗'}" for c in t["tools"]) or "（未调用工具）"
                lines.append(f"- 第 {i} 轮工具：{chain}")
                for c in t["tools"]:
                    if c["errors"]:
                        lines.append(f"  - `{c['id']}` 报错：{c['errors'][0][:160]}")
            ans = (r["turns"][-1]["answer"] if r["turns"] else "").strip().replace("\n", " ")
            lines += [f"- 最后回复：{ans[:300]}", ""]
    text = "\n".join(lines) + "\n"
    (out / "report.md").write_text(text, encoding="utf-8")
    return text


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--provider", required=True, help="模型服务 id，例如 minimax、custom、ollama")
    ap.add_argument("--base", default="http://127.0.0.1:8011")
    ap.add_argument("--root", default=str(DEFAULT_ROOT), help="服务的仓库根目录（用来定位 workspaces/）")
    ap.add_argument("--only", default="", help="逗号分隔的任务 id")
    ap.add_argument("--category", default="", help="逗号分隔的类别")
    ap.add_argument("--skip-network", action="store_true")
    ap.add_argument("--keep", action="store_true", help="保留临时工作区，方便排查")
    ap.add_argument("--timeout", type=float, default=600, help="单轮对话超时秒数")
    ap.add_argument("--out", default="", help="结果目录，默认 evals/results/<时间>-<provider>")
    args = ap.parse_args()

    tasks = yaml.safe_load((HERE / "tasks.yaml").read_text(encoding="utf-8"))["tasks"]
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        tasks = [t for t in tasks if t["id"] in wanted]
    if args.category:
        cats = {s.strip() for s in args.category.split(",") if s.strip()}
        tasks = [t for t in tasks if t.get("category") in cats]
    if args.skip_network:
        tasks = [t for t in tasks if "network" not in (t.get("tags") or [])]
    if not tasks:
        print("没有要跑的任务", file=sys.stderr)
        return 2

    stamp = datetime.now().strftime("%m%d%H%M")
    out = Path(args.out) if args.out else HERE / "results" / f"{datetime.now():%Y%m%d-%H%M}-{args.provider}"
    out.mkdir(parents=True, exist_ok=True)
    svc = Service(args.base, Path(args.root).resolve(), args.timeout)
    results: list[dict] = []
    with (out / "results.jsonl").open("w", encoding="utf-8") as fh:
        for i, task in enumerate(tasks, 1):
            try:
                res = run_task(svc, task, args.provider, stamp)
            except Exception as exc:  # 单个任务出错不影响其余任务
                res = {"id": task["id"], "category": task.get("category", ""), "provider": args.provider,
                       "passed": False, "fails": [f"运行出错：{type(exc).__name__}: {exc}"], "seconds": 0,
                       "tool_calls": 0, "tool_errors": 0, "usage": _usage(Path("/nonexistent")), "turns": []}
            results.append(res)
            fh.write(json.dumps(res, ensure_ascii=False) + "\n")
            fh.flush()
            mark = "PASS" if res["passed"] else "FAIL"
            print(f"[{i}/{len(tasks)}] {mark} {task['id']} ({res['seconds']:.0f}s, {res['tool_calls']} tools)"
                  + ("" if res["passed"] else f"  {'; '.join(res['fails'])[:200]}"), flush=True)
    if not args.keep:
        cleanup(svc, stamp)
    write_report(results, out, args.provider)
    passed = sum(r["passed"] for r in results)
    print(f"\n通过 {passed}/{len(results)}，报告：{out / 'report.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
