"""Focused behavior contracts for the data.manage tool engine."""

from core.tools.general_tools.data_engine import (
    MAX_OUTPUT_ROWS,
    data_distinct,
    data_filter,
    data_join,
    data_parse,
    data_pivot,
    data_render,
    data_sort,
)


def test_parse_detects_common_delimiters_and_escapes_markdown():
    result = data_parse(text="name;note\nPE1;a|b\nPE2;ok")
    assert result["ok"] is True
    assert result["row_count"] == 2
    assert "a\\|b" in result["markdown_preview"]


def test_parse_returns_bounded_rows_for_real_cross_tool_composition():
    rows = [{"value": index} for index in range(MAX_OUTPUT_ROWS + 3)]
    result = data_parse(rows=rows)

    assert result["ok"] is True
    assert result["row_count"] == MAX_OUTPUT_ROWS + 3
    assert result["rows"] == rows[:MAX_OUTPUT_ROWS]
    assert result["truncated"] is True


def test_invalid_columns_and_operators_are_reported_to_the_llm():
    rows = [{"device": "PE1", "loss": 0}]
    assert data_distinct(rows=rows, column="missing")["ok"] is False
    assert data_filter(rows=rows, conditions=[{"column": "device", "op": "regex", "value": ".*"}])["ok"] is False
    assert data_sort(rows=rows, by="missing")["ok"] is False


def test_sort_handles_numeric_and_text_values_without_type_errors():
    result = data_sort(rows=[{"value": "10"}, {"value": "unknown"}, {"value": 2}], by="value")
    assert result["ok"] is True
    assert [row["value"] for row in result["rows"]] == [2, "10", "unknown"]


def test_pivot_count_does_not_require_a_numeric_value_column():
    result = data_pivot(
        rows=[{"site": "east", "state": "up"}, {"site": "east", "state": "down"}, {"site": "east", "state": "up"}],
        index="site",
        columns="state",
        aggfunc="count",
    )
    assert result["ok"] is True
    assert result["pivot"]["east"] == {"down": 1, "up": 2}


def test_pivot_count_action_contract_does_not_require_values():
    from core.tools.action_requirements import ACTION_REQUIRED_ALL

    assert ACTION_REQUIRED_ALL[("data.manage", "pivot")] == ("index", "columns")


def test_pivot_supports_every_aggregate_published_by_its_schema():
    rows = [
        {"site": "east", "state": "up", "latency": 8},
        {"site": "east", "state": "up", "latency": 3},
    ]
    assert data_pivot(
        rows=rows, index="site", columns="state", values="latency", aggfunc="min",
    )["pivot"]["east"]["up"] == 3.0
    assert data_pivot(
        rows=rows, index="site", columns="state", values="latency", aggfunc="max",
    )["pivot"]["east"]["up"] == 8.0


def test_join_validates_keys_and_counts_matched_left_rows():
    missing = data_join(rows=[{"id": 1}], right_rows=[{"key": 1}], on="id")
    assert missing["ok"] is False

    result = data_join(
        rows=[{"id": 1}, {"id": 2}],
        right_rows=[{"id": 1, "name": "a"}, {"id": 1, "name": "b"}],
        on="id",
        how="left",
    )
    assert result["ok"] is True
    assert result["merged_rows"] == 3
    assert result["matched_rows"] == 1


def test_user_controlled_output_is_bounded():
    rows = [{"n": index} for index in range(MAX_OUTPUT_ROWS + 50)]
    result = data_render(rows=rows, output="json", max_rows=999_999)
    assert result["returned"] == MAX_OUTPUT_ROWS
    assert result["truncated"] is True


def test_every_input_format_rejects_overflow_and_malformed_rows_without_silent_loss():
    from core.tools.general_tools.data_engine import MAX_INPUT_ROWS
    too_many = [{"n": i} for i in range(MAX_INPUT_ROWS + 1)]
    import json
    for kwargs in ({"rows": too_many}, {"text": json.dumps(too_many)},
                   {"text": "n\n" + "\n".join(str(i) for i in range(MAX_INPUT_ROWS + 1))}):
        result = data_parse(**kwargs)
        assert result["ok"] is False and "too many rows" in result["error"]
    for source in ('[{"n":1}, malformed]', '[{"n":1}, 2]', 'n,v\n1,2,3', '| n | v |\n|---|---|\n|1|2|3|'):
        assert data_parse(text=source)["ok"] is False
    assert data_parse(rows=[[1, 2], [3]])["ok"] is False


def test_full_source_analysis_and_many_to_many_join_keep_exact_coverage(tmp_path, monkeypatch):
    monkeypatch.setenv("LZCORE_WORKSPACE_ROOT", str(tmp_path))
    from core.tools.integration import get_default_tool_runtime_client
    from core.tools.context import ToolRuntimeContext
    root = tmp_path / "data_ws/files/data"
    root.mkdir(parents=True)
    (root / "source.csv").write_text("n\n" + "\n".join(str(i) for i in range(501)), encoding="utf-8")
    ctx = ToolRuntimeContext(workspace_id="data_ws", requested_by="turn_runner")
    client = get_default_tool_runtime_client()
    parsed = client.invoke("data.manage", {"action": "parse", "source_filepath": "files/data/source.csv"}, context=ctx)
    stats = client.invoke("data.manage", {"action": "stats", "source_filepath": "files/data/source.csv"}, context=ctx)
    assert parsed.output["truncated"] is True and parsed.output["row_count"] == 501
    assert stats.output["stats"]["n"]["count"] == 501 and stats.output["stats"]["n"]["mean"] == 250
    assert stats.output["sources"][0]["sha256"] == parsed.output["sources"][0]["sha256"]
    ambiguous = client.invoke("data.manage", {"action": "stats", "source_filepath": "files/data/source.csv", "rows": [{"n": 999}]}, context=ctx)
    assert ambiguous.status == "failed"
    joined = data_join(rows=[{"id": 1}] * 10000, right_rows=[{"id": 1}] * 10000, on="id")
    assert joined["merged_rows"] == 100000000 and len(joined["rows"]) == MAX_OUTPUT_ROWS
    assert joined["truncated"] is True
    # A diagonal source must not expand into a full 10,000 x 10,000 result.
    pivoted = data_pivot(rows=[{"i": str(i), "c": str(i)} for i in range(10000)],
                         index="i", columns="c", aggfunc="count")
    assert pivoted["total_rows"] == pivoted["total_columns"] == 10000
    assert pivoted["returned"] == 50 and pivoted["returned_columns"] == MAX_OUTPUT_ROWS
    assert sum(len(row) for row in pivoted["pivot"].values()) == 50 * MAX_OUTPUT_ROWS
    assert pivoted["truncated"] is True


def test_numeric_statistics_distinguish_nulls_and_use_interpolated_quantiles():
    from core.tools.general_tools.data_engine import data_stats, data_aggregate
    rows = [{"n": 1}, {"n": 3}, {"n": None}, {"n": "NaN"}, {"n": True}]
    parsed = data_parse(rows=rows)
    assert parsed["null_counts"]["n"] == 1
    result = data_stats(rows=rows)
    assert result["stats"]["n"]["count"] == 2 and result["stats"]["n"]["excluded_count"] == 3
    assert [result["stats"]["n"][key] for key in ("p25", "p50", "p75")] == [1.5, 2, 2.5]
    counted = data_aggregate(rows=[{"n": None}, {"n": 0}], metrics=[{"column": "n", "func": "count"}])
    assert counted["aggregated"][0]["count(n)"] == 1
    sparse = [{"a": 1}, {"b": 3}]
    assert data_parse(rows=sparse)["columns"] == ["a", "b"]
    assert data_parse(rows=sparse)["null_counts"] == {"a": 1, "b": 1}
    assert data_stats(rows=sparse)["stats"]["b"]["mean"] == 3
    assert data_distinct(rows=sparse, column="b")["ok"] is True
    assert data_sort(rows=sparse, by="b")["ok"] is True
