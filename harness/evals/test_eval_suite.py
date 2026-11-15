"""评测集本身的静态校验：任务定义合法、判定逻辑正确。不调用模型。"""
import importlib.util
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("eval_run", ROOT / "evals" / "run.py")
eval_run = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(eval_run)

TASKS = yaml.safe_load((ROOT / "evals" / "tasks.yaml").read_text(encoding="utf-8"))["tasks"]
CHECK_KEYS = {"answer", "answer_not", "files", "files_mode", "tools_any", "no_tools"}


def test_task_ids_are_unique_and_valid_workspace_suffixes():
    ids = [t["id"] for t in TASKS]
    assert len(ids) == len(set(ids))
    for tid in ids:
        assert re.fullmatch(r"[a-z0-9-]{1,50}", tid), tid


def test_every_task_has_turns_checks_and_compilable_patterns():
    for task in TASKS:
        assert task["turns"] and all(t["say"].strip() for t in task["turns"]), task["id"]
        checks = task.get("checks") or {}
        assert checks, task["id"]
        assert set(checks) <= CHECK_KEYS, (task["id"], set(checks) - CHECK_KEYS)
        for pattern in checks.get("answer", []) + checks.get("answer_not", []):
            re.compile(pattern)
        for spec in checks.get("files", []):
            for pattern in spec.get("contains", []) + spec.get("not_contains", []):
                re.compile(pattern)


def test_referenced_fixture_files_exist():
    fixtures = {p.name for p in (ROOT / "evals" / "fixtures").rglob("*") if p.is_file()}
    for task in TASKS:
        if "network" in (task.get("tags") or []):
            continue
        for turn in task["turns"]:
            for name in re.findall(r"[\w./-]+\.(?:csv|ini|json|md|txt|log)\b", turn["say"]):
                base = name.split("/")[-1]
                created = task["id"] in {"file-create", "file-copy", "data-export", "code-script", "multi-monthly-report"}
                assert base in fixtures or created or task["id"].startswith("honest"), (task["id"], name)


def test_grade_answer_files_and_tools(tmp_path):
    (tmp_path / "files" / "data").mkdir(parents=True)
    (tmp_path / "files" / "data" / "out.csv").write_text("region,revenue\n华东,534\n", encoding="utf-8")
    task = {"checks": {"answer": ["1497"], "answer_not": ["2025"],
                       "files": [{"glob": "**/out.csv", "contains": ["华东\\s*,\\s*534"]}]}}
    assert eval_run.grade(task, "总额 1,497 元", ["workspace.file"], tmp_path) == []
    fails = eval_run.grade(task, "2025 年没有", [], tmp_path)
    assert any("1497" in f for f in fails) and any("2025" in f for f in fails)
    assert eval_run.grade({"checks": {"no_tools": True}}, "391", ["exec.run"], tmp_path)
    missing = eval_run.grade({"checks": {"files": [{"glob": "**/x.md"}]}}, "", [], tmp_path)
    assert missing and "没有找到" in missing[0]
