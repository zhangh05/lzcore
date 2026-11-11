import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../app/ErrorBoundary";

function Boom({ fail }: { fail: boolean }): JSX.Element {
  if (fail) throw new Error("渲染炸了");
  return <p>正常内容</p>;
}

describe("错误边界", () => {
  it("页面渲染失败时显示说明而不是白屏，可重试恢复", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const { rerender } = render(<ErrorBoundary scope="page"><Boom fail={fail} /></ErrorBoundary>);
    const alert = screen.getByTestId("error-boundary-page");
    expect(alert).toHaveTextContent("界面出错了");
    expect(alert).toHaveTextContent("渲染炸了");
    fail = false;
    rerender(<ErrorBoundary scope="page"><Boom fail={fail} /></ErrorBoundary>);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(screen.getByText("正常内容")).toBeInTheDocument();
    spy.mockRestore();
  });
});
