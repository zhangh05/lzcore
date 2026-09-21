import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, renderHook, act } from "@testing-library/react";
import { NetworkNotice, useNotice } from "../../../extensions/network_operations/frontend/components/NetworkNotice";

describe("NetworkNotice and useNotice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("useNotice hook", () => {
    it("initializes with empty notice", () => {
      const { result } = renderHook(() => useNotice(5000));
      expect(result.current.notice.text).toBe("");
      expect(result.current.notice.ok).toBe(true);
    });

    it("auto-dismisses notice after specified duration (5s)", () => {
      const { result } = renderHook(() => useNotice(5000));

      act(() => {
        result.current.setNotice("已从图纸移除“核心路由器 1”", true);
      });

      expect(result.current.notice.text).toBe("已从图纸移除“核心路由器 1”");
      expect(result.current.notice.ok).toBe(true);

      // Fast-forward 4.9s -> still visible
      act(() => {
        vi.advanceTimersByTime(4900);
      });
      expect(result.current.notice.text).toBe("已从图纸移除“核心路由器 1”");

      // Advance past 5s -> disappears
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(result.current.notice.text).toBe("");
    });

    it("allows manual dismissal via clearNotice", () => {
      const { result } = renderHook(() => useNotice(5000));

      act(() => {
        result.current.setNotice("临时提示信息");
      });
      expect(result.current.notice.text).toBe("临时提示信息");

      act(() => {
        result.current.clearNotice();
      });
      expect(result.current.notice.text).toBe("");

      // Advancing timer does nothing bad
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(result.current.notice.text).toBe("");
    });

    it("resets timer when a new notice is set before 5s expires", () => {
      const { result } = renderHook(() => useNotice(5000));

      act(() => {
        result.current.setNotice("第一条消息");
      });

      // Advance 3s
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(result.current.notice.text).toBe("第一条消息");

      // Set new notice -> timer resets
      act(() => {
        result.current.setNotice("第二条消息");
      });
      expect(result.current.notice.text).toBe("第二条消息");

      // Advance 3s (total 6s from start, but 3s from 2nd message) -> still visible
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(result.current.notice.text).toBe("第二条消息");

      // Advance remaining 2.1s -> disappears
      act(() => {
        vi.advanceTimersByTime(2100);
      });
      expect(result.current.notice.text).toBe("");
    });
  });

  describe("NetworkNotice component", () => {
    it("renders text, close button, and triggers onClose when clicked", () => {
      const onClose = vi.fn();
      const { rerender } = render(
        <NetworkNotice
          notice={{ text: "已从图纸移除“核心路由器 1”", ok: true }}
          onClose={onClose}
        />
      );

      const noticeEl = screen.getByRole("status");
      expect(noticeEl).toHaveClass("network-notice", "kind-ok");
      expect(screen.getByText("已从图纸移除“核心路由器 1”")).toBeInTheDocument();

      const closeBtn = screen.getByRole("button", { name: "关闭提示" });
      expect(closeBtn).toBeInTheDocument();

      fireEvent.click(closeBtn);
      expect(onClose).toHaveBeenCalledTimes(1);

      // When text is cleared, component renders null
      rerender(<NetworkNotice notice={{ text: "", ok: true }} onClose={onClose} />);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("renders warning notice without kind-ok class", () => {
      const onClose = vi.fn();
      render(
        <NetworkNotice
          notice={{ text: "拓扑版本冲突", ok: false }}
          onClose={onClose}
          role="alert"
        />
      );

      const alertEl = screen.getByRole("alert");
      expect(alertEl).toHaveClass("network-notice");
      expect(alertEl).not.toHaveClass("kind-ok");
      expect(screen.getByText("拓扑版本冲突")).toBeInTheDocument();
    });
  });
});
