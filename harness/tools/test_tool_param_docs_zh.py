"""Every tool parameter shown in the workflow form has Chinese wording.

The backend input_schema descriptions are written for the model and stay in
English; the UI reads names, hints and option labels from
frontend/src/kit/toolParamDocs.zh.json. This test keeps that file complete:
a new tool or parameter without Chinese wording fails here instead of showing
up untranslated in the form.
"""

import json
from pathlib import Path

DOCS = Path(__file__).resolve().parents[2] / "frontend" / "src" / "kit" / "toolParamDocs.zh.json"


def _catalog_tools():
    from core.tools.catalog_snapshot import build_catalog_snapshot

    return build_catalog_snapshot()["tools"]


def test_every_parameter_has_a_chinese_label_and_described_ones_a_hint():
    docs = json.loads(DOCS.read_text(encoding="utf-8"))
    labels, tools = docs["labels"], docs["tools"]
    missing_tool, missing_label, missing_hint, missing_option = [], [], [], []
    for tool in _catalog_tools():
        tool_id = tool["tool_id"]
        doc = tools.get(tool_id)
        if doc is None or not doc.get("label"):
            missing_tool.append(tool_id)
            doc = doc or {}
        params = (tool.get("input_schema") or {}).get("properties") or {}
        for name, schema in params.items():
            pdoc = (doc.get("params") or {}).get(name) or {}
            if not (pdoc.get("label") or labels.get(name)):
                missing_label.append(f"{tool_id}.{name}")
            if (schema.get("description") or "").strip() and not pdoc.get("hint"):
                missing_hint.append(f"{tool_id}.{name}")
            if name == "action" and isinstance(schema.get("enum"), list):
                opts = (doc.get("options") or {}).get("action") or {}
                missing_option += [f"{tool_id}.action={v}" for v in schema["enum"] if v not in opts]
    assert not missing_tool, f"工具缺中文名：{missing_tool}"
    assert not missing_label, f"参数缺中文名：{missing_label}"
    assert not missing_hint, f"参数有英文说明但缺中文说明：{missing_hint}"
    assert not missing_option, f"操作选项缺中文：{missing_option}"


def test_docs_file_has_no_english_hints():
    docs = json.loads(DOCS.read_text(encoding="utf-8"))
    for tool_id, doc in docs["tools"].items():
        for name, pdoc in (doc.get("params") or {}).items():
            hint = pdoc.get("hint", "")
            assert not hint or any("一" <= ch <= "鿿" for ch in hint), f"{tool_id}.{name} 的说明不是中文"
