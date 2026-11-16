#!/usr/bin/env python3
"""Build agent/llm/model_catalog_data.json from the models.dev catalog.

models.dev (https://models.dev, MIT licensed) is the open model database used by
OpenCode and others: per model input modalities, reasoning options, tool calling,
temperature support, context/output limits and prices.  We keep a compact copy of
the first-party and commonly used providers so capability lookup works offline.

Usage:
    python3 scripts/build_model_catalog.py                # fetch https://models.dev/api.json
    python3 scripts/build_model_catalog.py path/api.json  # use a downloaded copy
"""
from __future__ import annotations

import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "agent" / "llm" / "model_catalog_data.json"

# Lookup priority: first-party vendors before gateways that resell the same ids.
PROVIDERS = (
    "openai", "anthropic", "google", "deepseek", "minimax-cn", "minimax", "minimax-cn-coding-plan",
    "alibaba-cn", "alibaba", "moonshotai-cn", "moonshotai", "zhipuai", "zhipuai-coding-plan",
    "volcengine", "volcengine-coding-plan", "byteplus", "bailing", "xai", "mistral", "meta",
    "stepfun", "xiaomi", "tencent-tokenhub", "siliconflow-cn", "siliconflow", "ollama-cloud",
)


def _reasoning_options(raw) -> list:
    out = []
    for opt in raw or []:
        if not isinstance(opt, dict):
            continue
        kind = opt.get("type")
        if kind == "toggle":
            out.append({"type": "toggle"})
        elif kind == "effort" and isinstance(opt.get("values"), list):
            out.append({"type": "effort", "values": [str(v) for v in opt["values"]]})
        elif kind == "budget_tokens":
            out.append({k: opt[k] for k in ("type", "min", "max") if k in opt})
    return out


def _model(m: dict) -> dict:
    inputs = (m.get("modalities") or {}).get("input") or []
    limit = m.get("limit") or {}
    cost = m.get("cost") or {}
    rec = {
        "vision": "image" in inputs,
        "pdf": "pdf" in inputs,
        "reasoning": bool(m.get("reasoning")),
        "tools": bool(m.get("tool_call")),
        "temperature": m.get("temperature", True) is not False,
        "context": int(limit.get("context") or 0),
        "output": int(limit.get("output") or 0),
    }
    if m.get("name"):
        rec["name"] = str(m["name"])
    ro = _reasoning_options(m.get("reasoning_options"))
    if ro:
        rec["reasoning_options"] = ro
    if isinstance(cost.get("input"), (int, float)) or isinstance(cost.get("output"), (int, float)):
        rec["cost"] = [float(cost.get("input") or 0), float(cost.get("output") or 0)]
    return rec


def build(source: dict) -> dict:
    providers = {}
    for pid in PROVIDERS:
        p = source.get(pid)
        if not isinstance(p, dict):
            continue
        models = {mid: _model(m) for mid, m in sorted((p.get("models") or {}).items()) if isinstance(m, dict)}
        providers[pid] = {"name": p.get("name") or pid, "api": p.get("api") or "", "models": models}
    return {
        "source": "https://models.dev/api.json",
        "license": "MIT (models.dev)",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "providers": providers,
    }


def main() -> None:
    if len(sys.argv) > 1:
        source = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    else:
        req = urllib.request.Request("https://models.dev/api.json", headers={"User-Agent": "lzcore-catalog-builder"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            source = json.load(resp)
    data = build(source)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n", encoding="utf-8")
    total = sum(len(p["models"]) for p in data["providers"].values())
    print(f"wrote {OUT} ({len(data['providers'])} providers, {total} models, {OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
