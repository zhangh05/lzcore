"""Workspace spreadsheets: free-form workbooks edited in the browser and by tools.

A spreadsheet is stored as one JSON record holding the browser editor's
workbook snapshot (Univer ``IWorkbookData``) plus metadata.  The backend treats
the snapshot as mostly opaque; it only understands the parts tools need:
sheet order/names, ``cellData`` values/formulas and the grid size.

Every successful write increments ``revision``.  Callers that hold an older
copy pass ``base_revision`` and receive ``SpreadsheetConflict`` instead of
silently overwriting newer edits (for example, an agent write while the
spreadsheet is open in the editor).
"""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path
from typing import Any

from storage.atomic_io import atomic_write_json
from storage.locking import FileLock
from storage.records import workspace_record_dir, workspace_record_file
from storage.time_utils import now_iso

MAX_WORKBOOK_BYTES = 16 * 1024 * 1024
MAX_SHEETS = 100
MAX_ROWS = 100_000
MAX_COLUMNS = 1_000
MAX_NAME_LENGTH = 120
DEFAULT_ROWS = 1_000
DEFAULT_COLUMNS = 26
MAX_READ_CELLS = 5_000
MAX_WRITE_CELLS = 20_000

# Univer CellValueType
CELL_STRING, CELL_NUMBER, CELL_BOOLEAN = 1, 2, 3


class SpreadsheetError(ValueError):
    pass


class SpreadsheetNotFound(SpreadsheetError):
    pass


class SpreadsheetConflict(SpreadsheetError):
    def __init__(self, current_revision: int):
        super().__init__("spreadsheet_revision_conflict")
        self.current_revision = current_revision


# ── identifiers and paths ──────────────────────────────────────────────────

def _id(value: str) -> str:
    result = str(value or "").strip()
    if not re.fullmatch(r"sheet_[a-f0-9]{12}", result):
        raise SpreadsheetNotFound("spreadsheet not found")
    return result


def _path(workspace_id: str, spreadsheet_id: str) -> Path:
    return workspace_record_file(workspace_id, "spreadsheets", f"{_id(spreadsheet_id)}.json")


def _lock(path: Path) -> FileLock:
    return FileLock(path.with_suffix(".lock"))


def _name(value: Any, fallback: str = "") -> str:
    name = " ".join(str(value or "").split())[:MAX_NAME_LENGTH]
    if not name and not fallback:
        raise SpreadsheetError("spreadsheet name is required")
    return name or fallback


# ── A1 notation ────────────────────────────────────────────────────────────

def column_letter(index: int) -> str:
    letters = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(65 + rem) + letters
    return letters


def column_index(letters: str) -> int:
    value = 0
    for char in letters.upper():
        value = value * 26 + (ord(char) - 64)
    return value - 1


_CELL = re.compile(r"^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$")


def parse_cell(ref: str) -> tuple[int, int]:
    match = _CELL.match(str(ref or "").strip())
    if not match:
        raise SpreadsheetError(f"invalid cell reference: {ref!r}")
    return int(match.group(2)) - 1, column_index(match.group(1))


def parse_range(ref: str) -> tuple[int, int, int, int]:
    parts = str(ref or "").strip().split(":")
    if len(parts) == 1:
        row, col = parse_cell(parts[0])
        return row, col, row, col
    if len(parts) != 2:
        raise SpreadsheetError(f"invalid range: {ref!r}")
    r1, c1 = parse_cell(parts[0])
    r2, c2 = parse_cell(parts[1])
    return min(r1, r2), min(c1, c2), max(r1, r2), max(c1, c2)


# ── workbook snapshot helpers ──────────────────────────────────────────────

def _new_sheet_id() -> str:
    return f"s{uuid.uuid4().hex[:10]}"


def blank_sheet(name: str, sheet_id: str | None = None) -> dict[str, Any]:
    return {
        "id": sheet_id or _new_sheet_id(), "name": name,
        "rowCount": DEFAULT_ROWS, "columnCount": DEFAULT_COLUMNS,
        "cellData": {}, "mergeData": [], "rowData": {}, "columnData": {},
    }


def blank_workbook(name: str, sheet_names: list[str] | None = None) -> dict[str, Any]:
    sheets = [blank_sheet(item) for item in (sheet_names or ["Sheet1"])]
    return {
        "id": f"wb{uuid.uuid4().hex[:10]}", "name": name, "locale": "zhCN",
        "styles": {}, "sheetOrder": [sheet["id"] for sheet in sheets],
        "sheets": {sheet["id"]: sheet for sheet in sheets}, "resources": [],
    }


def validate_workbook(workbook: Any) -> dict[str, Any]:
    if not isinstance(workbook, dict):
        raise SpreadsheetError("workbook must be an object")
    sheets = workbook.get("sheets")
    order = workbook.get("sheetOrder")
    if not isinstance(sheets, dict) or not isinstance(order, list) or not order:
        raise SpreadsheetError("workbook requires sheets and sheetOrder")
    if len(order) > MAX_SHEETS or len(sheets) > MAX_SHEETS:
        raise SpreadsheetError(f"workbook may contain at most {MAX_SHEETS} sheets")
    if set(order) != set(sheets):
        raise SpreadsheetError("sheetOrder must list every sheet exactly once")
    if len(set(order)) != len(order):
        raise SpreadsheetError("sheetOrder must list every sheet exactly once")
    for sheet_id, sheet in sheets.items():
        if not isinstance(sheet, dict) or sheet.get("id") != sheet_id:
            raise SpreadsheetError("sheet id mismatch")
        if not isinstance(sheet.get("cellData", {}), dict):
            raise SpreadsheetError("cellData must be an object")
        if int(sheet.get("rowCount") or 0) > MAX_ROWS or int(sheet.get("columnCount") or 0) > MAX_COLUMNS:
            raise SpreadsheetError(f"sheet exceeds {MAX_ROWS} rows or {MAX_COLUMNS} columns")
    size = len(json.dumps(workbook, ensure_ascii=False).encode("utf-8"))
    if size > MAX_WORKBOOK_BYTES:
        raise SpreadsheetError("workbook exceeds 16 MB")
    return workbook


def _sheet(workbook: dict[str, Any], sheet: str = "") -> dict[str, Any]:
    order = workbook["sheetOrder"]
    if not sheet:
        return workbook["sheets"][order[0]]
    for sheet_id in order:
        item = workbook["sheets"][sheet_id]
        if item.get("name") == sheet or sheet_id == sheet:
            return item
    raise SpreadsheetError(f"sheet not found: {sheet}")


def used_range(sheet: dict[str, Any]) -> tuple[int, int] | None:
    """Return (last_row, last_col) of non-empty cells, or None for an empty sheet."""
    last_row = last_col = -1
    for row_key, row in (sheet.get("cellData") or {}).items():
        for col_key, cell in (row or {}).items():
            if _cell_value(cell) is None and not (isinstance(cell, dict) and cell.get("f")):
                continue
            last_row = max(last_row, int(row_key))
            last_col = max(last_col, int(col_key))
    return None if last_row < 0 else (last_row, last_col)


def _cell_value(cell: Any) -> Any:
    if not isinstance(cell, dict):
        return None
    value = cell.get("v")
    if value is None and isinstance(cell.get("p"), dict):
        # Rich text cells keep their plain text in the document body.
        body = (cell["p"].get("body") or {}).get("dataStream") or ""
        value = body.rstrip("\r\n") or None
    if value == "":
        return None
    if cell.get("t") == CELL_BOOLEAN and value in (0, 1):
        return bool(value)
    return value


def cell_from_value(value: Any, previous: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Build a cell from a tool value; strings starting with '=' are formulas."""
    style = (previous or {}).get("s")
    if value is None or value == "":
        return {"s": style} if style is not None else None
    if isinstance(value, bool):
        cell: dict[str, Any] = {"v": value, "t": CELL_BOOLEAN}
    elif isinstance(value, (int, float)):
        cell = {"v": value, "t": CELL_NUMBER}
    elif isinstance(value, str) and value.startswith("=") and len(value) > 1:
        cell = {"f": value}
    else:
        cell = {"v": str(value), "t": CELL_STRING}
    if style is not None:
        cell["s"] = style
    return cell


def read_range(workbook: dict[str, Any], sheet: str = "", cell_range: str = "") -> dict[str, Any]:
    target = _sheet(workbook, sheet)
    if cell_range:
        r1, c1, r2, c2 = parse_range(cell_range)
    else:
        used = used_range(target)
        if used is None:
            return {"sheet": target.get("name"), "range": "", "values": [], "formulas": {}, "truncated": False}
        r1, c1, (r2, c2) = 0, 0, used
    truncated = False
    width = c2 - c1 + 1
    if (r2 - r1 + 1) * width > MAX_READ_CELLS:
        r2 = r1 + max(1, MAX_READ_CELLS // width) - 1
        truncated = True
    cells = target.get("cellData") or {}
    values: list[list[Any]] = []
    formulas: dict[str, str] = {}
    for r in range(r1, r2 + 1):
        row = cells.get(str(r)) or cells.get(r) or {}
        line = []
        for c in range(c1, c2 + 1):
            cell = row.get(str(c)) or row.get(c)
            line.append(_cell_value(cell))
            if isinstance(cell, dict) and cell.get("f"):
                formulas[f"{column_letter(c)}{r + 1}"] = str(cell["f"])
        values.append(line)
    return {
        "sheet": target.get("name"),
        "range": f"{column_letter(c1)}{r1 + 1}:{column_letter(c2)}{r2 + 1}",
        "values": values, "formulas": formulas, "truncated": truncated,
    }


def write_values(workbook: dict[str, Any], values: Any, sheet: str = "", start_cell: str = "A1") -> str:
    if not isinstance(values, list) or not values or not all(isinstance(row, list) for row in values):
        raise SpreadsheetError("values must be a non-empty 2D array")
    if sum(len(row) for row in values) > MAX_WRITE_CELLS:
        raise SpreadsheetError(f"at most {MAX_WRITE_CELLS} cells per write")
    target = _sheet(workbook, sheet)
    r0, c0 = parse_cell(start_cell or "A1")
    width = max(len(row) for row in values)
    if r0 + len(values) > MAX_ROWS or c0 + width > MAX_COLUMNS:
        raise SpreadsheetError(f"write exceeds {MAX_ROWS} rows or {MAX_COLUMNS} columns")
    cells = target.setdefault("cellData", {})
    for dr, row in enumerate(values):
        row_key = str(r0 + dr)
        row_cells = cells.setdefault(row_key, {})
        for dc, value in enumerate(row):
            col_key = str(c0 + dc)
            cell = cell_from_value(value, row_cells.get(col_key))
            if cell is None:
                row_cells.pop(col_key, None)
            else:
                row_cells[col_key] = cell
        if not row_cells:
            cells.pop(row_key, None)
    target["rowCount"] = max(int(target.get("rowCount") or 0), r0 + len(values))
    target["columnCount"] = max(int(target.get("columnCount") or 0), c0 + width)
    end = f"{column_letter(c0 + width - 1)}{r0 + len(values)}"
    return f"{column_letter(c0)}{r0 + 1}:{end}"


def append_rows(workbook: dict[str, Any], values: Any, sheet: str = "") -> str:
    target = _sheet(workbook, sheet)
    used = used_range(target)
    start_row = 0 if used is None else used[0] + 1
    return write_values(workbook, values, sheet=target["id"], start_cell=f"A{start_row + 1}")


def add_sheet(workbook: dict[str, Any], name: str) -> dict[str, Any]:
    name = _name(name)
    if any(workbook["sheets"][sid].get("name") == name for sid in workbook["sheetOrder"]):
        raise SpreadsheetError(f"sheet already exists: {name}")
    if len(workbook["sheetOrder"]) >= MAX_SHEETS:
        raise SpreadsheetError(f"workbook may contain at most {MAX_SHEETS} sheets")
    sheet = blank_sheet(name)
    workbook["sheets"][sheet["id"]] = sheet
    workbook["sheetOrder"].append(sheet["id"])
    return sheet


# ── persistence ────────────────────────────────────────────────────────────

def _summary(record: dict[str, Any]) -> dict[str, Any]:
    workbook = record.get("workbook") or {}
    order = workbook.get("sheetOrder") or []
    sheets = workbook.get("sheets") or {}
    return {
        "spreadsheet_id": record["spreadsheet_id"], "name": record.get("name", ""),
        "revision": int(record.get("revision") or 0),
        "created_at": record.get("created_at", ""), "updated_at": record.get("updated_at", ""),
        "updated_by": record.get("updated_by", ""),
        "sheets": [str((sheets.get(sid) or {}).get("name") or sid) for sid in order],
    }


def _read(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def list_spreadsheets(workspace_id: str) -> list[dict[str, Any]]:
    directory = workspace_record_dir(workspace_id, "spreadsheets")
    items = []
    for path in directory.glob("sheet_*.json"):
        try:
            record = _read(path)
        except (OSError, ValueError):
            continue
        if record:
            items.append(_summary(record))
    items.sort(key=lambda item: item["updated_at"], reverse=True)
    return items


def get_spreadsheet(workspace_id: str, spreadsheet_id: str) -> dict[str, Any]:
    record = _read(_path(workspace_id, spreadsheet_id))
    if record is None:
        raise SpreadsheetNotFound("spreadsheet not found")
    return {**_summary(record), "workbook": record["workbook"]}


def create_spreadsheet(workspace_id: str, name: str, workbook: dict[str, Any] | None = None,
                       *, actor: str = "") -> dict[str, Any]:
    name = _name(name)
    workbook = validate_workbook(workbook) if workbook is not None else blank_workbook(name)
    workbook["name"] = name
    spreadsheet_id = f"sheet_{uuid.uuid4().hex[:12]}"
    path = _path(workspace_id, spreadsheet_id)
    stamp = now_iso()
    record = {
        "spreadsheet_id": spreadsheet_id, "name": name, "revision": 1,
        "created_at": stamp, "updated_at": stamp, "updated_by": actor, "workbook": workbook,
    }
    with _lock(path):
        atomic_write_json(path, record, indent=None)
    return {**_summary(record), "workbook": workbook}


def update_spreadsheet(workspace_id: str, spreadsheet_id: str, mutate, *, base_revision: int | None = None,
                       actor: str = "") -> tuple[dict[str, Any], Any]:
    """Apply ``mutate(record) -> result`` under the record lock and persist it."""
    path = _path(workspace_id, spreadsheet_id)
    with _lock(path):
        record = _read(path)
        if record is None:
            raise SpreadsheetNotFound("spreadsheet not found")
        current = int(record.get("revision") or 0)
        if base_revision is not None and int(base_revision) != current:
            raise SpreadsheetConflict(current)
        result = mutate(record)
        record["workbook"] = validate_workbook(record["workbook"])
        record["workbook"]["name"] = record["name"]
        record["revision"] = current + 1
        record["updated_at"] = now_iso()
        record["updated_by"] = actor
        atomic_write_json(path, record, indent=None)
    return {**_summary(record), "workbook": record["workbook"]}, result


def save_workbook(workspace_id: str, spreadsheet_id: str, workbook: dict[str, Any], *,
                  base_revision: int | None, actor: str = "") -> dict[str, Any]:
    validate_workbook(workbook)

    def replace(record):
        record["workbook"] = workbook

    return update_spreadsheet(workspace_id, spreadsheet_id, replace, base_revision=base_revision, actor=actor)[0]


def rename_spreadsheet(workspace_id: str, spreadsheet_id: str, name: str, *, actor: str = "") -> dict[str, Any]:
    name = _name(name)

    def rename(record):
        record["name"] = name

    return update_spreadsheet(workspace_id, spreadsheet_id, rename, actor=actor)[0]


def delete_spreadsheet(workspace_id: str, spreadsheet_id: str) -> bool:
    path = _path(workspace_id, spreadsheet_id)
    with _lock(path):
        if not path.is_file():
            raise SpreadsheetNotFound("spreadsheet not found")
        path.unlink()
    path.with_suffix(".lock").unlink(missing_ok=True)
    return True
