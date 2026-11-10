import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TopologyWhiteboard } from "../../../extensions/network_operations/frontend/components/TopologyWhiteboard";

describe("TopologyWhiteboard", () => {
  it("renders null when active is false", () => {
    const { container } = render(
      <TopologyWhiteboard active={false} onClose={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders toolbar and canvas when active is true", () => {
    render(<TopologyWhiteboard active={true} onClose={vi.fn()} />);

    expect(screen.getByLabelText("画板工具栏")).toBeDefined();
    expect(screen.getByTitle(/自由画笔/)).toBeDefined();
    expect(screen.getByTitle(/荧光高亮笔/)).toBeDefined();
    expect(screen.getByTitle(/指向箭头/)).toBeDefined();
    expect(screen.getByTitle(/框选标注/)).toBeDefined();
    expect(screen.getByTitle(/便签批注/)).toBeDefined();
  });

  it("switches tools when clicking tool buttons", () => {
    render(<TopologyWhiteboard active={true} onClose={vi.fn()} />);

    const highlighterBtn = screen.getByTitle(/荧光高亮笔/);
    fireEvent.click(highlighterBtn);
    expect(highlighterBtn.className).toContain("is-active");

    const arrowBtn = screen.getByTitle(/指向箭头/);
    fireEvent.click(arrowBtn);
    expect(arrowBtn.className).toContain("is-active");
    expect(highlighterBtn.className).not.toContain("is-active");
  });

  it("allows switching colors and stroke sizes", () => {
    render(<TopologyWhiteboard active={true} onClose={vi.fn()} />);

    const orangeBtn = screen.getByTitle(/橙色/);
    fireEvent.click(orangeBtn);
    expect(orangeBtn.className).toContain("is-active");

    const thickSizeBtn = screen.getByTitle(/笔触粗细: 粗/);
    fireEvent.click(thickSizeBtn);
    expect(thickSizeBtn.className).toContain("is-active");
  });

  it("calls onClose when clicking close button", () => {
    const handleClose = vi.fn();
    render(<TopologyWhiteboard active={true} onClose={handleClose} />);

    const closeBtn = screen.getByTitle("关闭画板批注");
    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalledOnce();
  });

  it("places sticky notes when note tool is active and clicked", () => {
    const { container } = render(<TopologyWhiteboard active={true} onClose={vi.fn()} />);

    // Switch to note tool
    const noteToolBtn = screen.getByTitle(/便签批注/);
    fireEvent.click(noteToolBtn);

    const overlay = container.querySelector(".topology-whiteboard-overlay");
    expect(overlay).not.toBeNull();

    // Click to place a note
    fireEvent.click(overlay!);

    expect(screen.getByPlaceholderText("输入批注内容...")).toBeDefined();
  });
});
