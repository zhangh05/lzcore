"""Workspace spreadsheet APIs: list, create, import, edit, rename, delete, export."""
import io
from urllib.parse import quote

from flask import Response, jsonify, request


def _workspace_id(value) -> str:
    from storage.ids import validate_workspace_id
    try:
        return validate_workspace_id(str(value or ""))
    except ValueError:
        return ""


def _actor() -> str:
    from backend.core.auth import authenticated_request_context
    context = authenticated_request_context() or {}
    return str(context.get("username") or "user")


def _error(exc):
    from storage.spreadsheet_store import SpreadsheetConflict, SpreadsheetNotFound
    if isinstance(exc, SpreadsheetNotFound):
        return jsonify({"ok": False, "error": "spreadsheet_not_found"}), 404
    if isinstance(exc, SpreadsheetConflict):
        return jsonify({"ok": False, "error": "spreadsheet_revision_conflict",
                        "current_revision": exc.current_revision}), 409
    return jsonify({"ok": False, "error": str(exc)}), 400


def register_spreadsheet_routes(app) -> None:
    @app.route("/api/spreadsheets", methods=["GET", "POST"])
    def spreadsheets_collection():
        from storage.spreadsheet_store import SpreadsheetError, create_spreadsheet, list_spreadsheets
        data = request.get_json(silent=True) or {}
        workspace_id = _workspace_id(request.args.get("workspace_id") or data.get("workspace_id"))
        if not workspace_id:
            return jsonify({"ok": False, "error": "workspace_id is required"}), 400
        if request.method == "GET":
            return jsonify({"ok": True, "spreadsheets": list_spreadsheets(workspace_id)})
        try:
            sheet = create_spreadsheet(workspace_id, data.get("name"), data.get("workbook"), actor=_actor())
        except SpreadsheetError as exc:
            return _error(exc)
        return jsonify({"ok": True, "spreadsheet": sheet}), 201

    @app.route("/api/spreadsheets/import", methods=["POST"])
    def spreadsheets_import():
        from storage.spreadsheet_store import SpreadsheetError, create_spreadsheet
        from storage.spreadsheet_xlsx import MAX_IMPORT_BYTES, workbook_from_upload
        workspace_id = _workspace_id(request.form.get("workspace_id"))
        if not workspace_id:
            return jsonify({"ok": False, "error": "workspace_id is required"}), 400
        upload = request.files.get("file")
        if upload is None or not upload.filename:
            return jsonify({"ok": False, "error": "file is required"}), 400
        data = upload.read(MAX_IMPORT_BYTES + 1)
        filename = upload.filename
        stem = filename.rsplit(".", 1)[0] if "." in filename else filename
        name = str(request.form.get("name") or stem or "导入的表格")
        try:
            workbook = workbook_from_upload(data, filename, name)
            sheet = create_spreadsheet(workspace_id, name, workbook, actor=_actor())
        except SpreadsheetError as exc:
            return _error(exc)
        return jsonify({"ok": True, "spreadsheet": sheet}), 201

    @app.route("/api/spreadsheets/<spreadsheet_id>", methods=["GET", "PUT", "PATCH", "DELETE"])
    def spreadsheet_detail(spreadsheet_id):
        from storage.spreadsheet_store import (
            SpreadsheetError, delete_spreadsheet, get_spreadsheet, rename_spreadsheet, save_workbook,
        )
        data = request.get_json(silent=True) or {}
        workspace_id = _workspace_id(request.args.get("workspace_id") or data.get("workspace_id"))
        if not workspace_id:
            return jsonify({"ok": False, "error": "workspace_id is required"}), 400
        try:
            if request.method == "GET":
                sheet = get_spreadsheet(workspace_id, spreadsheet_id)
                if request.args.get("summary") in {"1", "true"}:
                    sheet = _without_workbook(sheet)
                return jsonify({"ok": True, "spreadsheet": sheet})
            if request.method == "DELETE":
                if data.get("confirm") != "delete":
                    return jsonify({"ok": False, "error": "spreadsheet_delete_confirmation_required"}), 400
                return jsonify({"ok": True, "deleted": delete_spreadsheet(workspace_id, spreadsheet_id)})
            if request.method == "PATCH":
                sheet = rename_spreadsheet(workspace_id, spreadsheet_id, data.get("name"), actor=_actor())
                return jsonify({"ok": True, "spreadsheet": _without_workbook(sheet)})
            if "base_revision" not in data:
                return jsonify({"ok": False, "error": "base_revision is required"}), 400
            sheet = save_workbook(workspace_id, spreadsheet_id, data.get("workbook"),
                                  base_revision=int(data["base_revision"]), actor=_actor())
            return jsonify({"ok": True, "spreadsheet": _without_workbook(sheet)})
        except (SpreadsheetError, TypeError) as exc:
            return _error(exc if isinstance(exc, SpreadsheetError) else SpreadsheetError("invalid request"))

    @app.route("/api/spreadsheets/<spreadsheet_id>/export")
    def spreadsheet_export(spreadsheet_id):
        from storage.spreadsheet_store import SpreadsheetError, get_spreadsheet
        from storage.spreadsheet_xlsx import sheet_to_csv, workbook_to_xlsx
        workspace_id = _workspace_id(request.args.get("workspace_id"))
        if not workspace_id:
            return jsonify({"ok": False, "error": "workspace_id is required"}), 400
        fmt = str(request.args.get("format") or "xlsx").lower()
        try:
            sheet = get_spreadsheet(workspace_id, spreadsheet_id)
            if fmt == "csv":
                body = sheet_to_csv(sheet["workbook"], str(request.args.get("sheet") or ""))
                mime, ext = "text/csv; charset=utf-8", "csv"
            elif fmt == "xlsx":
                body = workbook_to_xlsx(sheet["workbook"])
                mime, ext = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"
            else:
                return jsonify({"ok": False, "error": "format must be xlsx or csv"}), 400
        except SpreadsheetError as exc:
            return _error(exc)
        filename = f"{sheet['name'] or 'spreadsheet'}.{ext}"
        response = Response(io.BytesIO(body).getvalue(), mimetype=mime)
        response.headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(filename)}"
        response.headers["Cache-Control"] = "no-store"
        return response


def _without_workbook(sheet: dict) -> dict:
    return {key: value for key, value in sheet.items() if key != "workbook"}
