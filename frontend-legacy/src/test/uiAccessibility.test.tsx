import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button, DataTable, ModalShell, SegmentedControl } from "../components/ui";

describe("shared UI accessibility contracts", () => {
  it("moves radio focus and selection with arrows while retaining one tab stop", () => {
    function Choices() {
      const [value, setValue] = useState("one");
      return <SegmentedControl ariaLabel="范围" value={value} onChange={setValue}
        options={[{ value: "one", label: "一" }, { value: "two", label: "二" }, { value: "three", label: "三" }]} />;
    }
    render(<Choices />);
    const radios = screen.getAllByRole("radio");
    radios[0].focus();
    fireEvent.keyDown(radios[0], { key: "ArrowLeft" });
    expect(radios[2]).toHaveFocus();
    expect(radios[2]).toHaveAttribute("aria-checked", "true");
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, -1, 0]);
    fireEvent.keyDown(radios[2], { key: "Home" });
    expect(radios[0]).toHaveFocus();
    fireEvent.keyDown(radios[0], { key: "ArrowDown" });
    expect(radios[1]).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(radios[1], { key: "End" });
    expect(radios[2]).toHaveFocus();
  });

  it("lets keyboard users activate an interactive data row", () => {
    type Row = { id: string; name: string };
    const onRowClick = vi.fn();
    render(
      <DataTable<Row>
        columns={[{ key: "name", header: "名称", render: (row) => row.name }]}
        rows={[{ id: "1", name: "设备 A" }]}
        keyExtractor={(row) => row.id}
        onRowClick={onRowClick}
      />,
    );

    const row = screen.getByRole("button", { name: "设备 A" });
    expect(row).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(onRowClick).toHaveBeenCalledTimes(2);
  });

  it("traps focus in a modal, closes with Escape, and restores focus", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <button type="button">打开设置</button>
        <ModalShell open={false} onClose={onClose} title="模型设置"><Button>保存</Button></ModalShell>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "打开设置" });
    trigger.focus();

    rerender(
      <>
        <button type="button">打开设置</button>
        <ModalShell open onClose={onClose} title="模型设置"><Button>保存</Button></ModalShell>
      </>,
    );
    expect(screen.getByRole("dialog", { name: "模型设置" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    rerender(
      <>
        <button type="button">打开设置</button>
        <ModalShell open={false} onClose={onClose} title="模型设置"><Button>保存</Button></ModalShell>
      </>,
    );
    expect(screen.getByRole("button", { name: "打开设置" })).toHaveFocus();
  });
});

describe("nested data row controls", () => {
  it("keeps button clicks and Space on an input independent of row activation", () => {
    const onRowClick = vi.fn();
    const onAction = vi.fn();
    render(<DataTable
      columns={[{ key: "actions", header: "操作", render: () => <><button onClick={onAction}>打开操作</button><input aria-label="选择设备" type="checkbox" /></> }]}
      rows={[{ id: "device" }]} keyExtractor={(row) => row.id} onRowClick={onRowClick}
    />);
    fireEvent.click(screen.getByRole("button", { name: "打开操作" }));
    fireEvent.keyDown(screen.getByRole("checkbox"), { key: " " });
    expect(onAction).toHaveBeenCalledOnce();
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
