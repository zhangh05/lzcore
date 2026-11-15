from core.tools.general_tools.data_engine import data_aggregate

CSV = """date,region,qty,price
2026-01-03,华东,10,12.5
2026-01-12,华南,15,12.5
2026-01-20,华南,2,99
2026-02-06,华东,8,12.5
"""


def test_sum_of_column_product():
    r = data_aggregate(text=CSV, metrics=[{"column": "qty*price", "func": "sum"}])
    assert r["ok"] is True, r
    assert r["aggregated"][0]["sum(qty*price)"] == 10 * 12.5 + 15 * 12.5 + 2 * 99 + 8 * 12.5


def test_group_by_month_and_region_with_expression():
    r = data_aggregate(text=CSV, group_by=["month(date)"], metrics=[{"column": "qty * price", "func": "sum"}])
    assert r["ok"] is True, r
    by_month = {row["month(date)"]: row["sum(qty * price)"] for row in r["aggregated"]}
    assert by_month == {"2026-01": 125 + 187.5 + 198, "2026-02": 100}


def test_unknown_or_unsafe_expressions_are_rejected():
    assert data_aggregate(text=CSV, metrics=[{"column": "qty*cost", "func": "sum"}])["ok"] is False
    assert data_aggregate(text=CSV, metrics=[{"column": "__import__('os')", "func": "sum"}])["ok"] is False
    assert data_aggregate(text=CSV, group_by=["week(date)"])["ok"] is False
