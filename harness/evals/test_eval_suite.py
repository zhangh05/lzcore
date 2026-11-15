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
CHECK_KEYS = {"answer", "answer_not", "files", "files_mode", "tools_any", "no_tools", "allow_english",
              "exec", "answer_max_chars"}


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
                outputs = {spec["glob"].split("/")[-1] for spec in (task.get("checks") or {}).get("files", [])}
                created = base in outputs or task["id"] in {"file-copy", "code-script"}
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


def test_language_drift_flags_english_reply_to_chinese_prompt(tmp_path):
    task = {"turns": [{"say": "帮我总结 budget.xlsx"}], "checks": {}}
    english = "I've searched thoroughly, and the file isn't in this workspace. It does not exist here."
    assert eval_run.grade(task, english, [], tmp_path) == ["中文提问却用英文回复"]
    chinese = "没有找到 `files/data/budget_2027.xlsx`，工作区里也没有任何 .xlsx 文件，请确认文件名。"
    assert eval_run.grade(task, chinese, [], tmp_path) == []


def test_file_checks_ignore_thousands_separators(tmp_path):
    (tmp_path / "files" / "data").mkdir(parents=True)
    (tmp_path / "files" / "data" / "r.md").write_text("总销售额 ¥1,497.00", encoding="utf-8")
    task = {"checks": {"files": [{"glob": "**/*.md", "contains": ["1497"]}]}}
    assert eval_run.grade(task, "", [], tmp_path) == []


def _fixture_ws(tmp_path):
    import shutil
    shutil.copytree(ROOT / "evals" / "fixtures", tmp_path / "files" / "data")
    return tmp_path


def test_exec_check_fails_on_shipped_bug_and_passes_after_fix(tmp_path):
    ws = _fixture_ws(tmp_path)
    task = next(t for t in TASKS if t["id"] == "hard-fix-bug")
    assert any("退出码" in f for f in eval_run.grade(task, "", [], ws))
    calc = ws / "files" / "data" / "calc.py"
    calc.write_text(calc.read_text(encoding="utf-8")
                    .replace("return s[len(s) // 2]",
                             "m = len(s) // 2\n    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2")
                    .replace("/ new * 100", "/ old * 100"), encoding="utf-8")
    assert eval_run.grade(task, "", [], ws) == []


def test_directory_globs_do_not_fall_back_to_same_named_files(tmp_path):
    ws = _fixture_ws(tmp_path)
    spec = {"glob": "*restore/*infra.txt", "contains": ["服务器扩容"]}
    assert not eval_run._match_file(ws, spec)[0]
    (ws / "files" / "data" / "restore").mkdir()
    (ws / "files" / "data" / "restore" / "infra.txt").write_text("服务器扩容", encoding="utf-8")
    assert eval_run._match_file(ws, spec)[0]


def test_answer_length_limit():
    task = {"checks": {"answer_max_chars": 10}}
    assert eval_run.grade(task, "短", [], Path("/nonexistent")) == []
    assert eval_run.grade(task, "这是一句明显超过十个字的回复内容", [], Path("/nonexistent"))


def test_hard_fixture_answers_match_task_expectations():
    """困难任务的标准答案由夹具推出，改夹具时这里会提醒同步 tasks.yaml。"""
    import csv
    from collections import Counter, defaultdict
    data = ROOT / "evals" / "fixtures"
    seen, total = set(), 0.0
    for row in csv.DictReader((data / "orders_messy.csv").open(encoding="utf-8")):
        if row["order_id"] in seen:
            continue
        seen.add(row["order_id"])
        amount = re.sub(r"[¥￥元,\s]", "", row["amount"])
        if row["status"] == "已完成" and amount:
            total += float(amount)
    assert (total, len(seen)) == (8325.5, 10)
    dept = {r["id"]: (r["dept"], r["name"]) for r in csv.DictReader((data / "employees.csv").open(encoding="utf-8"))}
    by_dept, by_emp = defaultdict(float), defaultdict(float)
    for r in csv.DictReader((data / "timesheet.csv").open(encoding="utf-8")):
        if r["date"].startswith("2026-11"):
            by_dept[dept[r["emp_id"]][0]] += float(r["hours"])
            by_emp[dept[r["emp_id"]][1]] += float(r["hours"])
    assert max(by_dept.items(), key=lambda kv: kv[1]) == ("市场", 181.0)
    assert max(by_emp.items(), key=lambda kv: kv[1])[0] == "高远"
    ips, paths = Counter(), Counter()
    for line in (data / "access.log").read_text(encoding="utf-8").splitlines():
        status = int(line.split('"')[2].split()[0])
        if status >= 500:
            ips[line.split()[0]] += 1
            paths[line.split('"')[1].split()[1]] += 1
    assert sum(ips.values()) == 65
    assert ips.most_common(2) == [("10.0.0.3", 22), ("10.0.0.42", 14)]
    assert paths.most_common(1) == [("/static/app.js", 18)]
