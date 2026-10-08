import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FilterSelect, OperationResults, SelectionBar, StatStrip } from "../components/ui";

describe("collection components", () => {
  it("renders the selection bar only while something is selected", () => {
    const onClear = vi.fn();
    const { rerender } = render(<SelectionBar count={0} onClear={onClear}><button type="button">处理</button></SelectionBar>);
    expect(screen.queryByRole("group", { name: "批量操作" })).toBeNull();
    rerender(<SelectionBar count={3} unit="条" note="将移入回收站" onClear={onClear}><button type="button">处理</button></SelectionBar>);
    expect(screen.getByRole("group", { name: "批量操作" })).toHaveTextContent("已选 3 条将移入回收站");
    fireEvent.click(screen.getByRole("button", { name: "清除选择" }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("lists every item outcome and summarises failures", () => {
    render(<OperationResults items={[{ name: "a.txt", result: "已导入" }, { name: "b.txt", error: "格式不支持" }]} onDismiss={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("1 项完成，1 项失败");
    expect(screen.getByText("b.txt：格式不支持")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "逐项处理结果" }).children).toHaveLength(2);
  });

  it("keeps the filter's accessible name on the select, containing the visible label", () => {
    render(<FilterSelect label="范围" aria-label="搜索范围" value="a" onChange={() => {}}><option value="a">全部</option></FilterSelect>);
    expect(screen.getByRole("combobox", { name: "搜索范围" })).toHaveValue("a");
    expect(screen.queryByLabelText("范围", { exact: true })).toBeNull();
  });

  it("pairs each stat label with its value", () => {
    render(<StatStrip label="数据概况" items={[{ label: "活跃文件", value: 5, hint: "独立 1" }, { label: "待处理", value: 2, tone: "warning" }]} />);
    const group = screen.getByRole("group", { name: "数据概况" });
    expect(group.querySelectorAll("dt")).toHaveLength(2);
    expect(group.querySelector(".ui-stat.is-warning dd")).toHaveTextContent("2");
  });
});
