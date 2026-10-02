# prompts/renderer.py
"""Strict renderer for the small template language used by prompt files."""

import json
import re
from pathlib import Path
from dataclasses import dataclass, field
from core.context.prompt_text import escape_prompt_data


@dataclass
class RenderedPrompt:
    prompt_id: str = ""
    task: str = ""
    version: str = "v1"
    text: str = ""
    context_chars: int = 0
    citation_ids: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    metadata: dict = field(default_factory=dict)

    def as_dict(self): return self.__dict__.copy()


def render_prompt(task: str, safe_context: dict = None, user_input: str = "",
                  citations: list = None, extra: dict = None) -> RenderedPrompt:
    """Render a registered prompt with complete, explicitly referenced context."""
    from prompts.loader import get_prompt_by_task

    spec = get_prompt_by_task(task)
    citations = list(citations or [])
    merged_context = dict(safe_context or {})
    merged_context.update(dict(extra or {}))
    ctx, policy_warnings = _apply_context_policy(
        merged_context, citations, spec
    )
    vars_ctx = dict(ctx)
    vars_ctx["user_input"] = user_input
    vars_ctx["citations"] = citations

    # Load template file
    template_text = ""
    if spec.template_path:
        tp = Path(spec.template_path)
        ROOT = Path(__file__).resolve().parent.parent
        tpath = ROOT / tp if not tp.is_absolute() else tp
        if tpath.is_file():
            template_text = tpath.read_text(encoding="utf-8")

    if not template_text:
        raise FileNotFoundError(
            f"prompt template not found for {spec.prompt_id}: {spec.template_path}"
        )

    vars_ctx["task"] = task
    text = _render_template(template_text, vars_ctx)

    return RenderedPrompt(
        prompt_id=spec.prompt_id, task=task, version=spec.version,
        text=text, context_chars=len(_safe_json(ctx)),
        citation_ids=[c.get("citation_id", "") for c in citations],
        warnings=policy_warnings,
        metadata={
            "context_policy_applied": True,
            "max_context_chars": int(spec.input_policy.get("max_context_chars", 8000)),
        },
    )


def _render_template(text: str, values: dict) -> str:
    """Parse authored syntax once; substituted data is never parsed as code."""
    tokens = re.split(r"(\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\})", text)

    def parse(index=0, stops=()):
        nodes = []
        while index < len(tokens):
            token = tokens[index]
            index += 1
            if token.startswith("{{"):
                if not token.endswith("}}"):
                    raise ValueError("unclosed prompt expression")
                expression = token[2:-2].strip()
                if not re.fullmatch(r"[a-zA-Z_][\w.]*(?:\s*\|\s*(?:summary_only|upper))?", expression):
                    raise ValueError("unsupported prompt variable expression")
                nodes.append(("variable", expression))
            elif token.startswith("{%"):
                directive = token[2:-2].strip()
                if directive in stops:
                    return nodes, index, directive
                condition = re.fullmatch(r"if\s+([a-zA-Z_][\w.]*)", directive)
                loop = re.fullmatch(r"for\s+([a-zA-Z_]\w*)\s+in\s+([a-zA-Z_][\w.]*)", directive)
                if condition:
                    yes, index, end = parse(index, ("else", "endif"))
                    no = []
                    if end == "else":
                        no, index, end = parse(index, ("endif",))
                    nodes.append(("if", condition[1], yes, no))
                elif loop:
                    body, index, end = parse(index, ("endfor",))
                    nodes.append(("for", loop[1], loop[2], body))
                else:
                    raise ValueError("unsupported prompt directive")
            else:
                if "{{" in token or "{%" in token:
                    raise ValueError("unclosed prompt expression")
                nodes.append(("text", token))
        if stops:
            raise ValueError("unclosed prompt block")
        return nodes, index, ""

    def render(nodes, context):
        parts = []
        for node in nodes:
            if node[0] == "text":
                parts.append(node[1])
            elif node[0] == "variable":
                path, _, filter_name = node[1].partition("|")
                value = _resolve_path(context, path.strip())
                rendered = _summary_only(value) if filter_name.strip() == "summary_only" else _stringify(value)
                if filter_name.strip() == "upper":
                    rendered = rendered.upper()
                parts.append(escape_prompt_data(rendered))
            elif node[0] == "if":
                parts.append(render(node[2] if _resolve_path(context, node[1]) else node[3], context))
            else:
                items = _resolve_path(context, node[2])
                if isinstance(items, (list, tuple)):
                    parts.extend(render(node[3], {**context, node[1]: item}) for item in items)
        return "".join(parts)

    nodes, _, _ = parse()
    return render(nodes, values)


def _resolve_path(values: dict, path: str):
    cur = values
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            cur = getattr(cur, part, None)
        if cur is None:
            return None
    return cur


def _summary_only(value) -> str:
    if not value:
        return ""
    if isinstance(value, dict):
        safe = {
            str(k): v for k, v in value.items()
            if str(k).lower() not in {"secret", "password", "token", "api_key", "key", "credential"}
        }
        for key in ("summary", "status", "title", "message"):
            if safe.get(key):
                return str(safe.get(key))
        return _safe_json(safe)
    return str(value)


def _apply_context_policy(ctx: dict, citations: list, spec) -> tuple[dict, list[str]]:
    """Preserve every rendered context item and citation.

    Registry budgets remain provider-capacity telemetry only; they do not
    authorize deleting context before the model can reason over it.
    """
    return dict(ctx), []


def _stringify(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, ensure_ascii=False, default=str)
    return str(value).replace("\x00", "")


def _safe_json(obj) -> str:
    try:
        return json.dumps(obj, ensure_ascii=False, default=str)
    except Exception:
        return str(obj)
