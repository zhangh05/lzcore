"""spreadsheet.manage: read and edit workspace spreadsheets (the 表格 module)."""

from __future__ import annotations

from core.tools.general_tools.shared import _caller_workspace, _error_inv, _ok
from core.tools.schemas import ToolInvocation

ACTIONS = ("list", "read", "create", "write", "append_rows", "add_sheet")


def _actor(inv: ToolInvocation) -> str:
    return f"agent:{inv.session_id}" if inv.session_id else "agent"


def handle_spreadsheet(inv: ToolInvocation) -> dict:
    from storage import spreadsheet_store as store

    args = inv.arguments or {}
    action = str(args.get("action") or "").strip().lower()
    try:
        workspace_id = _caller_workspace(inv)
        if action == "list":
            items = store.list_spreadsheets(workspace_id)
            return _ok(inv, "", {"spreadsheets": items, "count": len(items)})
        if action == "create":
            workbook = store.blank_workbook(store._name(args.get("name")))
            sheet_name = str(args.get("sheet") or "").strip()
            if sheet_name:
                first = workbook["sheets"][workbook["sheetOrder"][0]]
                first["name"] = sheet_name[: store.MAX_NAME_LENGTH]
            written = ""
            if args.get("values") is not None:
                written = store.write_values(workbook, args.get("values"), start_cell=str(args.get("start_cell") or "A1"))
            sheet = store.create_spreadsheet(workspace_id, str(args.get("name") or ""), workbook, actor=_actor(inv))
            return _ok(inv, "", {"spreadsheet_id": sheet["spreadsheet_id"], "name": sheet["name"],
                                 "revision": sheet["revision"], "sheets": sheet["sheets"], "written_range": written})
        spreadsheet_id = str(args.get("spreadsheet_id") or "")
        if action == "read":
            sheet = store.get_spreadsheet(workspace_id, spreadsheet_id)
            data = store.read_range(sheet["workbook"], str(args.get("sheet") or ""), str(args.get("range") or ""))
            return _ok(inv, "", {"spreadsheet_id": spreadsheet_id, "name": sheet["name"],
                                 "revision": sheet["revision"], "sheets": sheet["sheets"], **data})
        if action in {"write", "append_rows", "add_sheet"}:
            base = args.get("base_revision")
            sheet_arg = str(args.get("sheet") or "")

            def mutate(record):
                workbook = record["workbook"]
                if action == "add_sheet":
                    return store.add_sheet(workbook, str(args.get("name") or sheet_arg))["name"]
                if action == "append_rows":
                    return store.append_rows(workbook, args.get("values"), sheet=sheet_arg)
                return store.write_values(workbook, args.get("values"), sheet=sheet_arg,
                                          start_cell=str(args.get("start_cell") or "A1"))

            sheet, result = store.update_spreadsheet(
                workspace_id, spreadsheet_id, mutate,
                base_revision=int(base) if base is not None else None, actor=_actor(inv),
            )
            output = {"spreadsheet_id": spreadsheet_id, "revision": sheet["revision"], "sheets": sheet["sheets"]}
            output["added_sheet" if action == "add_sheet" else "written_range"] = result
            return _ok(inv, "", output)
    except store.SpreadsheetConflict as exc:
        return _error_inv(inv, f"spreadsheet changed since base_revision; current revision is {exc.current_revision}. Read it again before writing.",
                          error_code="spreadsheet_revision_conflict", details={"current_revision": exc.current_revision})
    except (store.SpreadsheetError, ValueError, TypeError) as exc:
        return _error_inv(inv, str(exc)[:300])
    return _error_inv(inv, f"unsupported action for spreadsheet.manage: {action or '<missing>'}; expected {'|'.join(ACTIONS)}")
