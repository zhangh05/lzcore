"""XLSX parser — extracts visible worksheet values as bounded Markdown tables."""

from __future__ import annotations

import io
from typing import Optional

from agent.modules.knowledge.schemas import NormalizedDocument


def parse(
    raw: bytes,
    *,
    title: str = "",
    author: str = "",
    source_type: str = "project_doc",
    scope: str = "workspace",
    language: str = "zh",
    metadata: Optional[dict] = None,
) -> NormalizedDocument:
    try:
        from openpyxl import load_workbook  # type: ignore
    except ImportError as exc:
        return _empty(title, author, source_type, scope, language, metadata, f"xlsx_parser_unavailable: {exc!r}")
    try:
        workbook = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    except Exception as exc:
        return _empty(title, author, source_type, scope, language, metadata, f"xlsx_open_failed: {exc!r}")

    try:
        lines: list[str] = []
        cells = chars = 0
        for sheet in workbook.worksheets:
            if (sheet.max_row or 0) > 10000 or (sheet.max_column or 0) > 256:
                raise ValueError("xlsx_sheet_dimensions_exceeded")
            lines.append(f"## {sheet.title}")
            rows = []
            for row_index, row in enumerate(sheet.iter_rows(values_only=True), 1):
                cells += len(row)
                if row_index > 10000 or len(row) > 256 or cells > 100000:
                    raise ValueError("xlsx_cell_budget_exceeded")
                values = ["" if value is None else str(value).replace("|", "\\|").replace("\n", " ") for value in row]
                chars += sum(len(value) for value in values)
                if chars > 2 * 1024 * 1024:
                    raise ValueError("xlsx_text_budget_exceeded")
                if any(values):
                    rows.append(values)
            if not rows:
                lines.append("（空工作表）")
                continue
            width = max(len(row) for row in rows)
            rows = [row + [""] * (width - len(row)) for row in rows]
            header = rows[0]
            lines.append("| " + " | ".join(header) + " |")
            lines.append("| " + " | ".join("---" for _ in header) + " |")
            lines.extend("| " + " | ".join(row) + " |" for row in rows[1:])
            lines.append("")
    finally:
        workbook.close()
    return NormalizedDocument(
        title=title,
        author=author,
        source_type=source_type,
        scope=scope,
        language=language,
        format="xlsx",
        normalized_markdown="\n".join(lines).strip(),
        metadata={**(metadata or {}), "format_hint": "xlsx"},
        warnings=[],
    )


def _empty(title, author, source_type, scope, language, metadata, warning):
    return NormalizedDocument(
        title=title, author=author, source_type=source_type, scope=scope,
        language=language, format="xlsx", normalized_markdown="",
        metadata=metadata or {}, warnings=[warning],
    )
