from __future__ import annotations


def _client(tmp_path, monkeypatch):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    from core.tools.context import ToolRuntimeContext
    from core.tools.integration import get_default_tool_runtime_client
    return get_default_tool_runtime_client(), ToolRuntimeContext(workspace_id="sheet_ws", requested_by="turn_runner")


def test_spreadsheet_tool_round_trip_keeps_styles_and_rejects_stale_writes(tmp_path, monkeypatch):
    client, ctx = _client(tmp_path, monkeypatch)
    created = client.invoke("spreadsheet.manage", {
        "action": "create", "name": "巡检记录", "sheet": "七月",
        "values": [["设备", "温度", "正常"], ["SW-01", 35.5, True]],
    }, context=ctx)
    assert created.status == "succeeded", created.errors
    sheet_id = created.output["spreadsheet_id"]
    assert created.output["written_range"] == "A1:C2"

    # The user styles a cell in the editor; tool writes must keep that style.
    from storage.spreadsheet_store import get_spreadsheet, save_workbook
    record = get_spreadsheet("sheet_ws", sheet_id)
    workbook = record["workbook"]
    first = workbook["sheets"][workbook["sheetOrder"][0]]
    first["cellData"]["1"]["1"]["s"] = {"bl": 1}
    save_workbook("sheet_ws", sheet_id, workbook, base_revision=record["revision"])

    appended = client.invoke("spreadsheet.manage", {
        "action": "append_rows", "spreadsheet_id": sheet_id, "sheet": "七月",
        "values": [["SW-02", 41, False], ["合计", "=SUM(B2:B3)", None]],
    }, context=ctx)
    assert appended.output["written_range"] == "A3:C4"
    overwrite = client.invoke("spreadsheet.manage", {
        "action": "write", "spreadsheet_id": sheet_id, "start_cell": "B2", "values": [[36]],
        "base_revision": appended.output["revision"],
    }, context=ctx)
    assert overwrite.status == "succeeded"

    read = client.invoke("spreadsheet.manage", {"action": "read", "spreadsheet_id": sheet_id}, context=ctx)
    assert read.output["range"] == "A1:C4"
    assert read.output["values"] == [["设备", "温度", "正常"], ["SW-01", 36, True], ["SW-02", 41, False], ["合计", None, None]]
    assert read.output["formulas"] == {"B4": "=SUM(B2:B3)"}
    cell = get_spreadsheet("sheet_ws", sheet_id)["workbook"]
    assert cell["sheets"][cell["sheetOrder"][0]]["cellData"]["1"]["1"] == {"v": 36, "t": 2, "s": {"bl": 1}}

    stale = client.invoke("spreadsheet.manage", {
        "action": "write", "spreadsheet_id": sheet_id, "values": [["x"]], "base_revision": 1,
    }, context=ctx)
    assert stale.status == "failed"
    assert read.output["revision"] == get_spreadsheet("sheet_ws", sheet_id)["revision"]

    added = client.invoke("spreadsheet.manage", {"action": "add_sheet", "spreadsheet_id": sheet_id, "name": "汇总"}, context=ctx)
    assert added.output["added_sheet"] == "汇总"
    listed = client.invoke("spreadsheet.manage", {"action": "list"}, context=ctx)
    assert listed.output["count"] == 1 and listed.output["spreadsheets"][0]["sheets"] == ["七月", "汇总"]


def test_spreadsheet_tool_bounds_reads_and_rejects_bad_input(tmp_path, monkeypatch):
    client, ctx = _client(tmp_path, monkeypatch)
    created = client.invoke("spreadsheet.manage", {"action": "create", "name": "大表"}, context=ctx)
    sheet_id = created.output["spreadsheet_id"]
    rows = [[r * 10 + c for c in range(10)] for r in range(600)]
    client.invoke("spreadsheet.manage", {"action": "write", "spreadsheet_id": sheet_id, "values": rows}, context=ctx)
    read = client.invoke("spreadsheet.manage", {"action": "read", "spreadsheet_id": sheet_id}, context=ctx)
    assert read.output["truncated"] is True and len(read.output["values"]) == 500
    ranged = client.invoke("spreadsheet.manage", {"action": "read", "spreadsheet_id": sheet_id, "range": "C3:D4"}, context=ctx)
    assert ranged.output["values"] == [[22, 23], [32, 33]]

    for arguments in (
        {"action": "write", "spreadsheet_id": sheet_id, "values": "not rows"},
        {"action": "write", "spreadsheet_id": sheet_id, "values": [[1]], "start_cell": "A0"},
        {"action": "read", "spreadsheet_id": "../../etc"},
        {"action": "read", "spreadsheet_id": sheet_id, "sheet": "不存在"},
    ):
        result = client.invoke("spreadsheet.manage", arguments, context=ctx)
        assert result.status in {"failed", "blocked"}, arguments
