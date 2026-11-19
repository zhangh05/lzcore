"""Convert between workspace spreadsheet snapshots and .xlsx/.csv files.

Covered: sheet names/order, values, formulas, number formats, font
(family/size/bold/italic/underline/strike/colour), fill colour, alignment,
wrap, borders, merged cells, column widths, row heights and frozen panes.
Charts, images, comments, conditional formats and data validation are not
converted.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import date, datetime, time
from typing import Any

from storage.spreadsheet_store import (
    CELL_BOOLEAN, CELL_NUMBER, CELL_STRING, DEFAULT_COLUMNS, DEFAULT_ROWS, MAX_COLUMNS, MAX_ROWS,
    SpreadsheetError, blank_sheet, column_letter, used_range,
)

MAX_IMPORT_BYTES = 30 * 1024 * 1024
PX_PER_CHAR = 7.0
PX_PER_POINT = 4.0 / 3.0

_H_TO_UNIVER = {"left": 1, "center": 2, "right": 3, "justify": 4, "distributed": 6, "centerContinuous": 2}
_H_FROM_UNIVER = {1: "left", 2: "center", 3: "right", 4: "justify", 5: "justify", 6: "distributed"}
_V_TO_UNIVER = {"top": 1, "center": 2, "bottom": 3}
_V_FROM_UNIVER = {1: "top", 2: "center", 3: "bottom"}
_BORDER_TO_UNIVER = {
    "thin": 1, "hair": 2, "dotted": 3, "dashed": 4, "dashDot": 5, "dashDotDot": 6, "double": 7,
    "medium": 8, "mediumDashed": 9, "mediumDashDot": 10, "mediumDashDotDot": 11, "slantDashDot": 12, "thick": 13,
}
_BORDER_FROM_UNIVER = {value: key for key, value in _BORDER_TO_UNIVER.items()}
_BORDER_SIDES = (("t", "top"), ("b", "bottom"), ("l", "left"), ("r", "right"))
_EXCEL_EPOCH = datetime(1899, 12, 30)


# ── colour helpers ─────────────────────────────────────────────────────────

def _rgb_from_openpyxl(color) -> str | None:
    if color is None or getattr(color, "type", None) != "rgb":
        return None
    value = str(color.rgb or "")
    if len(value) == 8:
        if value == "00000000":  # openpyxl's unset colour
            return None
        value = value[2:]  # drop the ARGB alpha byte
    if len(value) != 6 or not all(ch in "0123456789abcdefABCDEF" for ch in value):
        return None
    return f"#{value.upper()}"


def _argb(rgb: Any) -> str | None:
    value = str((rgb or {}).get("rgb") or "") if isinstance(rgb, dict) else ""
    value = value.lstrip("#")
    if len(value) == 3:
        value = "".join(ch * 2 for ch in value)
    if len(value) != 6:
        return None
    return f"FF{value.upper()}"


# ── import ─────────────────────────────────────────────────────────────────

def _style_from_cell(cell) -> dict[str, Any]:
    style: dict[str, Any] = {}
    font = cell.font
    if font is not None:
        if font.name and font.name != "Calibri":
            style["ff"] = font.name
        if font.sz and float(font.sz) != 11:
            style["fs"] = float(font.sz)
        if font.b:
            style["bl"] = 1
        if font.i:
            style["it"] = 1
        if font.u:
            style["ul"] = {"s": 1}
        if font.strike:
            style["st"] = {"s": 1}
        color = _rgb_from_openpyxl(font.color)
        if color and color != "#000000":
            style["cl"] = {"rgb": color}
    fill = cell.fill
    if fill is not None and getattr(fill, "fill_type", None) == "solid":
        color = _rgb_from_openpyxl(fill.fgColor)
        if color:
            style["bg"] = {"rgb": color}
    align = cell.alignment
    if align is not None:
        if align.horizontal in _H_TO_UNIVER:
            style["ht"] = _H_TO_UNIVER[align.horizontal]
        if align.vertical in _V_TO_UNIVER:
            style["vt"] = _V_TO_UNIVER[align.vertical]
        if align.wrap_text:
            style["tb"] = 3
    border = cell.border
    if border is not None:
        sides = {}
        for key, side_name in _BORDER_SIDES:
            side = getattr(border, side_name, None)
            kind = _BORDER_TO_UNIVER.get(getattr(side, "style", None) or "")
            if kind:
                sides[key] = {"s": kind, "cl": {"rgb": _rgb_from_openpyxl(side.color) or "#000000"}}
        if sides:
            style["bd"] = sides
    if cell.number_format and cell.number_format != "General":
        style["n"] = {"pattern": cell.number_format}
    return style


def _value_from_cell(cell) -> dict[str, Any] | None:
    value = cell.value
    if value is None or value == "":
        return None
    if isinstance(value, str) and value.startswith("=") and len(value) > 1:
        return {"f": value}
    if isinstance(value, bool):
        return {"v": 1 if value else 0, "t": CELL_BOOLEAN}
    if isinstance(value, (int, float)):
        return {"v": value, "t": CELL_NUMBER}
    if isinstance(value, datetime):
        return {"v": (value - _EXCEL_EPOCH).total_seconds() / 86400, "t": CELL_NUMBER}
    if isinstance(value, date):
        return {"v": (datetime(value.year, value.month, value.day) - _EXCEL_EPOCH).days, "t": CELL_NUMBER}
    if isinstance(value, time):
        return {"v": (value.hour * 3600 + value.minute * 60 + value.second) / 86400, "t": CELL_NUMBER}
    if hasattr(value, "text"):  # array formulas / rich text
        text = getattr(value, "text", None)
        if isinstance(text, str) and text.startswith("="):
            return {"f": text}
    return {"v": str(value), "t": CELL_STRING}


def workbook_from_xlsx(data: bytes, name: str) -> dict[str, Any]:
    from openpyxl import load_workbook
    from openpyxl.utils import column_index_from_string, range_boundaries

    if len(data) > MAX_IMPORT_BYTES:
        raise SpreadsheetError("file exceeds 30 MB")
    try:
        book = load_workbook(io.BytesIO(data), data_only=False, rich_text=False)
    except Exception as exc:
        raise SpreadsheetError(f"not a readable .xlsx file ({type(exc).__name__})") from exc
    styles: dict[str, dict[str, Any]] = {}
    style_ids: dict[str, str] = {}

    def style_id(style: dict[str, Any]) -> str | None:
        if not style:
            return None
        key = json.dumps(style, sort_keys=True)
        if key not in style_ids:
            style_ids[key] = f"x{len(style_ids)}"
            styles[style_ids[key]] = style
        return style_ids[key]

    workbook = {"id": "", "name": name, "locale": "zhCN", "styles": styles,
                "sheetOrder": [], "sheets": {}, "resources": []}
    for index, ws in enumerate(book.worksheets[:100]):
        sheet = blank_sheet(ws.title or f"Sheet{index + 1}")
        max_row = min(ws.max_row or 1, MAX_ROWS)
        max_col = min(ws.max_column or 1, MAX_COLUMNS)
        cells: dict[str, dict[str, Any]] = {}
        for row in ws.iter_rows(min_row=1, max_row=max_row, max_col=max_col):
            for cell in row:
                if cell.__class__.__name__ == "MergedCell":
                    continue
                payload = _value_from_cell(cell) or {}
                sid = style_id(_style_from_cell(cell)) if cell.has_style else None
                if sid:
                    payload["s"] = sid
                if payload:
                    cells.setdefault(str(cell.row - 1), {})[str(cell.column - 1)] = payload
        sheet["cellData"] = cells
        sheet["rowCount"] = max(DEFAULT_ROWS, max_row + 50)
        sheet["columnCount"] = max(DEFAULT_COLUMNS, max_col + 5)
        merges = []
        for merged in ws.merged_cells.ranges:
            min_col, min_row, max_col_m, max_row_m = range_boundaries(str(merged))
            merges.append({"startRow": min_row - 1, "endRow": max_row_m - 1,
                           "startColumn": min_col - 1, "endColumn": max_col_m - 1})
        sheet["mergeData"] = merges
        sheet["columnData"] = {
            str(column_index_from_string(letter) - 1): {"w": round(dim.width * PX_PER_CHAR + 5)}
            for letter, dim in ws.column_dimensions.items() if dim.width
        }
        sheet["rowData"] = {
            str(row - 1): {"h": round(dim.height * PX_PER_POINT)}
            for row, dim in ws.row_dimensions.items() if dim.height
        }
        if ws.freeze_panes:
            col_letters = "".join(ch for ch in ws.freeze_panes if ch.isalpha())
            row_digits = "".join(ch for ch in ws.freeze_panes if ch.isdigit())
            x = column_index_from_string(col_letters) - 1 if col_letters else 0
            y = int(row_digits) - 1 if row_digits else 0
            if x or y:
                sheet["freeze"] = {"xSplit": x, "ySplit": y, "startRow": y, "startColumn": x}
        workbook["sheets"][sheet["id"]] = sheet
        workbook["sheetOrder"].append(sheet["id"])
    if not workbook["sheetOrder"]:
        raise SpreadsheetError("the workbook has no sheets")
    return workbook


def _decode_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _csv_cell(text: str) -> dict[str, Any] | None:
    if text == "":
        return None
    if text.startswith("=") and len(text) > 1:
        return {"f": text}
    stripped = text.strip()
    try:
        number = float(stripped.replace(",", "")) if stripped and stripped[0] in "+-0123456789." else None
    except ValueError:
        number = None
    # Keep identifiers such as phone numbers or leading-zero codes as text.
    if number is not None and not (len(stripped) > 1 and stripped.startswith("0") and not stripped.startswith("0.")):
        return {"v": int(number) if number.is_integer() and "." not in stripped else number, "t": CELL_NUMBER}
    return {"v": text, "t": CELL_STRING}


def workbook_from_csv(data: bytes, name: str) -> dict[str, Any]:
    if len(data) > MAX_IMPORT_BYTES:
        raise SpreadsheetError("file exceeds 30 MB")
    text = _decode_text(data)
    try:
        dialect = csv.Sniffer().sniff(text[:8192], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    sheet = blank_sheet(name[:31] or "Sheet1")
    cells: dict[str, dict[str, Any]] = {}
    rows = cols = 0
    for r, row in enumerate(csv.reader(io.StringIO(text), dialect)):
        if r >= MAX_ROWS:
            break
        for c, value in enumerate(row[:MAX_COLUMNS]):
            cell = _csv_cell(value)
            if cell:
                cells.setdefault(str(r), {})[str(c)] = cell
        rows, cols = r + 1, max(cols, len(row))
    sheet["cellData"] = cells
    sheet["rowCount"] = max(DEFAULT_ROWS, rows + 50)
    sheet["columnCount"] = max(DEFAULT_COLUMNS, min(cols, MAX_COLUMNS) + 5)
    return {"id": "", "name": name, "locale": "zhCN", "styles": {}, "sheetOrder": [sheet["id"]],
            "sheets": {sheet["id"]: sheet}, "resources": []}


def workbook_from_upload(data: bytes, filename: str, name: str) -> dict[str, Any]:
    lower = filename.lower()
    if lower.endswith(".xlsx") or lower.endswith(".xlsm"):
        return workbook_from_xlsx(data, name)
    if lower.endswith(".csv") or lower.endswith(".tsv") or lower.endswith(".txt"):
        return workbook_from_csv(data, name)
    raise SpreadsheetError("only .xlsx and .csv files can be imported")


# ── export ─────────────────────────────────────────────────────────────────

def _resolve_style(workbook: dict[str, Any], value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        return (workbook.get("styles") or {}).get(value) or {}
    return value if isinstance(value, dict) else {}


def _apply_style(cell, style: dict[str, Any]) -> None:
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

    if not style:
        return
    font_args: dict[str, Any] = {}
    if style.get("ff"):
        font_args["name"] = str(style["ff"])
    if style.get("fs"):
        font_args["sz"] = float(style["fs"])
    if style.get("bl") == 1:
        font_args["b"] = True
    if style.get("it") == 1:
        font_args["i"] = True
    if isinstance(style.get("ul"), dict) and style["ul"].get("s") == 1:
        font_args["u"] = "single"
    if isinstance(style.get("st"), dict) and style["st"].get("s") == 1:
        font_args["strike"] = True
    color = _argb(style.get("cl"))
    if color:
        font_args["color"] = color
    if font_args:
        cell.font = Font(**font_args)
    fill = _argb(style.get("bg"))
    if fill:
        cell.fill = PatternFill(fill_type="solid", fgColor=fill)
    align_args: dict[str, Any] = {}
    if style.get("ht") in _H_FROM_UNIVER:
        align_args["horizontal"] = _H_FROM_UNIVER[style["ht"]]
    if style.get("vt") in _V_FROM_UNIVER:
        align_args["vertical"] = _V_FROM_UNIVER[style["vt"]]
    if style.get("tb") == 3:
        align_args["wrap_text"] = True
    if align_args:
        cell.alignment = Alignment(**align_args)
    borders = style.get("bd") if isinstance(style.get("bd"), dict) else {}
    sides = {}
    for key, side_name in _BORDER_SIDES:
        item = borders.get(key)
        if isinstance(item, dict) and item.get("s") in _BORDER_FROM_UNIVER:
            sides[side_name] = Side(style=_BORDER_FROM_UNIVER[item["s"]], color=_argb(item.get("cl")) or "FF000000")
    if sides:
        cell.border = Border(**sides)
    pattern = (style.get("n") or {}).get("pattern") if isinstance(style.get("n"), dict) else None
    if pattern:
        cell.number_format = str(pattern)


def _export_value(cell: dict[str, Any]) -> Any:
    if cell.get("f"):
        formula = str(cell["f"])
        return formula if formula.startswith("=") else f"={formula}"
    value = cell.get("v")
    if value is None and isinstance(cell.get("p"), dict):
        value = ((cell["p"].get("body") or {}).get("dataStream") or "").rstrip("\r\n") or None
    if cell.get("t") == CELL_BOOLEAN and value in (0, 1, True, False):
        return bool(value)
    if isinstance(value, str) and cell.get("t") == CELL_NUMBER:
        try:
            return float(value)
        except ValueError:
            return value
    return value


def workbook_to_xlsx(workbook: dict[str, Any]) -> bytes:
    from openpyxl import Workbook

    book = Workbook()
    book.remove(book.active)
    used_titles: set[str] = set()
    for index, sheet_id in enumerate(workbook.get("sheetOrder") or []):
        sheet = (workbook.get("sheets") or {}).get(sheet_id) or {}
        title = _excel_title(str(sheet.get("name") or f"Sheet{index + 1}"), used_titles)
        ws = book.create_sheet(title)
        for row_key, row in (sheet.get("cellData") or {}).items():
            for col_key, cell in (row or {}).items():
                if not isinstance(cell, dict):
                    continue
                target = ws.cell(row=int(row_key) + 1, column=int(col_key) + 1)
                value = _export_value(cell)
                if value is not None:
                    target.value = value
                _apply_style(target, _resolve_style(workbook, cell.get("s")))
        for merge in sheet.get("mergeData") or []:
            try:
                ws.merge_cells(start_row=merge["startRow"] + 1, end_row=merge["endRow"] + 1,
                               start_column=merge["startColumn"] + 1, end_column=merge["endColumn"] + 1)
            except (KeyError, TypeError, ValueError):
                continue
        for col_key, data in (sheet.get("columnData") or {}).items():
            if isinstance(data, dict) and data.get("w"):
                ws.column_dimensions[column_letter(int(col_key))].width = max(1.0, (float(data["w"]) - 5) / PX_PER_CHAR)
        for row_key, data in (sheet.get("rowData") or {}).items():
            if isinstance(data, dict) and data.get("h"):
                ws.row_dimensions[int(row_key) + 1].height = float(data["h"]) / PX_PER_POINT
        freeze = sheet.get("freeze") or {}
        x, y = int(freeze.get("xSplit") or 0), int(freeze.get("ySplit") or 0)
        if x > 0 or y > 0:
            ws.freeze_panes = f"{column_letter(x)}{y + 1}"
    if not book.worksheets:
        book.create_sheet("Sheet1")
    output = io.BytesIO()
    book.save(output)
    return output.getvalue()


def _excel_title(name: str, used: set[str]) -> str:
    cleaned = "".join("_" if ch in "[]:*?/\\" else ch for ch in name).strip("'")[:31] or "Sheet"
    candidate, counter = cleaned, 2
    while candidate.lower() in used:
        suffix = f" ({counter})"
        candidate = cleaned[: 31 - len(suffix)] + suffix
        counter += 1
    used.add(candidate.lower())
    return candidate


def sheet_to_csv(workbook: dict[str, Any], sheet_id: str = "") -> bytes:
    order = workbook.get("sheetOrder") or []
    sheets = workbook.get("sheets") or {}
    target = None
    for sid in order:
        item = sheets.get(sid) or {}
        if not sheet_id or sid == sheet_id or item.get("name") == sheet_id:
            target = item
            break
    if target is None:
        raise SpreadsheetError("sheet not found")
    used = used_range(target)
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\r\n")
    if used is not None:
        cells = target.get("cellData") or {}
        for r in range(used[0] + 1):
            row = cells.get(str(r)) or {}
            line = []
            for c in range(used[1] + 1):
                cell = row.get(str(c))
                value = _export_value(cell) if isinstance(cell, dict) and not cell.get("f") else (
                    cell.get("v") if isinstance(cell, dict) else None)
                line.append("" if value is None else ("TRUE" if value is True else "FALSE" if value is False else value))
            writer.writerow(line)
    # BOM keeps Chinese text readable when the CSV is opened in Excel.
    return ("﻿" + buffer.getvalue()).encode("utf-8")
