from __future__ import annotations

import io


def _client(monkeypatch, tmp_path):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setenv("LZCORE_LOGIN_ENABLED", "false")
    from backend.main import create_app
    return create_app().test_client()


def _xlsx_bytes() -> bytes:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill

    book = Workbook()
    sheet = book.active
    sheet.title = "巡检"
    sheet.append(["设备", "区域", "温度"])
    sheet.append(["SW-01", "A", 35.5])
    sheet.append(["SW-02", "B", 40])
    sheet["C4"] = "=SUM(C2:C3)"
    sheet["A1"].font = Font(b=True, color="FFFF0000")
    sheet["A1"].fill = PatternFill("solid", fgColor="FFFFFF00")
    sheet["A1"].number_format = "@"
    sheet.merge_cells("A6:C6")
    sheet.column_dimensions["A"].width = 20
    sheet.freeze_panes = "A2"
    book.create_sheet("汇总")["A1"] = "总计"
    output = io.BytesIO()
    book.save(output)
    return output.getvalue()


def test_spreadsheet_lifecycle_with_revision_conflict(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path)
    created = client.post("/api/spreadsheets", json={"workspace_id": "default", "name": "  台账  补充 "})
    assert created.status_code == 201
    sheet = created.get_json()["spreadsheet"]
    assert sheet["name"] == "台账 补充" and sheet["revision"] == 1 and sheet["sheets"] == ["Sheet1"]

    listed = client.get("/api/spreadsheets", query_string={"workspace_id": "default"}).get_json()
    assert [item["spreadsheet_id"] for item in listed["spreadsheets"]] == [sheet["spreadsheet_id"]]
    assert "workbook" not in listed["spreadsheets"][0]

    workbook = client.get(f"/api/spreadsheets/{sheet['spreadsheet_id']}",
                          query_string={"workspace_id": "default"}).get_json()["spreadsheet"]["workbook"]
    first = workbook["sheetOrder"][0]
    workbook["sheets"][first]["cellData"] = {"0": {"0": {"v": "hello", "t": 1}}}
    saved = client.put(f"/api/spreadsheets/{sheet['spreadsheet_id']}",
                       json={"workspace_id": "default", "workbook": workbook, "base_revision": 1})
    assert saved.status_code == 200 and saved.get_json()["spreadsheet"]["revision"] == 2

    stale = client.put(f"/api/spreadsheets/{sheet['spreadsheet_id']}",
                       json={"workspace_id": "default", "workbook": workbook, "base_revision": 1})
    assert stale.status_code == 409
    assert stale.get_json() == {"ok": False, "error": "spreadsheet_revision_conflict", "current_revision": 2}

    renamed = client.patch(f"/api/spreadsheets/{sheet['spreadsheet_id']}", json={"workspace_id": "default", "name": "新名字"})
    assert renamed.get_json()["spreadsheet"]["name"] == "新名字"

    unconfirmed = client.delete(f"/api/spreadsheets/{sheet['spreadsheet_id']}", json={"workspace_id": "default"})
    assert unconfirmed.status_code == 400
    deleted = client.delete(f"/api/spreadsheets/{sheet['spreadsheet_id']}", json={"workspace_id": "default", "confirm": "delete"})
    assert deleted.status_code == 200
    missing = client.get(f"/api/spreadsheets/{sheet['spreadsheet_id']}", query_string={"workspace_id": "default"})
    assert missing.status_code == 404


def test_invalid_workbook_and_ids_are_rejected(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path)
    bad = client.post("/api/spreadsheets", json={"workspace_id": "default", "name": "x",
                                                 "workbook": {"sheets": {"a": {"id": "a"}}, "sheetOrder": ["b"]}})
    assert bad.status_code == 400
    assert client.post("/api/spreadsheets", json={"workspace_id": "default", "name": " "}).status_code == 400
    traversal = client.get("/api/spreadsheets/..%2Fsecrets", query_string={"workspace_id": "default"})
    assert traversal.status_code == 404


def test_xlsx_import_export_round_trip(monkeypatch, tmp_path):
    from openpyxl import load_workbook

    client = _client(monkeypatch, tmp_path)
    imported = client.post("/api/spreadsheets/import", data={
        "workspace_id": "default", "file": (io.BytesIO(_xlsx_bytes()), "巡检记录.xlsx"),
    }, content_type="multipart/form-data")
    assert imported.status_code == 201
    sheet = imported.get_json()["spreadsheet"]
    assert sheet["name"] == "巡检记录" and sheet["sheets"] == ["巡检", "汇总"]
    data = sheet["workbook"]["sheets"][sheet["workbook"]["sheetOrder"][0]]
    assert data["cellData"]["3"]["2"] == {"f": "=SUM(C2:C3)"}
    assert data["freeze"]["ySplit"] == 1

    exported = client.get(f"/api/spreadsheets/{sheet['spreadsheet_id']}/export",
                          query_string={"workspace_id": "default", "format": "xlsx"})
    assert exported.status_code == 200
    assert "filename*=UTF-8''" in exported.headers["Content-Disposition"]
    book = load_workbook(io.BytesIO(exported.data))
    assert book.sheetnames == ["巡检", "汇总"]
    ws = book["巡检"]
    assert ws["A1"].value == "设备" and ws["A1"].font.b and ws["A1"].fill.fgColor.rgb == "FFFFFF00"
    assert ws["A1"].number_format == "@"
    assert ws["B2"].value == "A" and ws["C2"].value == 35.5 and ws["C4"].value == "=SUM(C2:C3)"
    assert [str(item) for item in ws.merged_cells.ranges] == ["A6:C6"]
    assert round(ws.column_dimensions["A"].width) == 20 and ws.freeze_panes == "A2"

    csv_export = client.get(f"/api/spreadsheets/{sheet['spreadsheet_id']}/export",
                            query_string={"workspace_id": "default", "format": "csv", "sheet": "汇总"})
    assert csv_export.data.decode("utf-8") == "﻿总计\r\n"


def test_csv_import_keeps_codes_as_text_and_reads_gbk(monkeypatch, tmp_path):
    client = _client(monkeypatch, tmp_path)
    body = "名称,编号,数量\n甲,007,12\n乙,A1,3.5\n".encode("gbk")
    imported = client.post("/api/spreadsheets/import", data={
        "workspace_id": "default", "file": (io.BytesIO(body), "清单.csv"),
    }, content_type="multipart/form-data")
    assert imported.status_code == 201
    from storage.spreadsheet_store import read_range
    values = read_range(imported.get_json()["spreadsheet"]["workbook"])["values"]
    assert values == [["名称", "编号", "数量"], ["甲", "007", 12], ["乙", "A1", 3.5]]

    rejected = client.post("/api/spreadsheets/import", data={
        "workspace_id": "default", "file": (io.BytesIO(b"x"), "a.pdf"),
    }, content_type="multipart/form-data")
    assert rejected.status_code == 400
