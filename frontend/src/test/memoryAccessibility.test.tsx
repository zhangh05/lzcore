import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryPage } from "../pages/MemoryPage/MemoryPage";
import { enqueue, installMockApi, resetMocks } from "./mockServer";
import { useSessionStore } from "../stores/session";

describe("memory row disclosure", () => {
  beforeEach(() => {
    resetMocks();
    installMockApi();
    useSessionStore.setState({ currentWorkspaceId: "default" });
    enqueue("/memory/list", { status: 200, data: { ok: true, records: [{
      memory_id: "memory-review", title: "机房访问约定", content: "先核对工单", status: "active",
      memory_type: "knowledge_note", scope: "workspace", metadata: { extraction_reason: "用户约定" },
    }] } });
  });

  it("opens with the keyboard without hijacking checkbox or detail clicks", async () => {
    const user = userEvent.setup();
    render(<MemoryPage />);
    const disclosure = await screen.findByRole("button", { name: "机房访问约定" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    disclosure.focus();
    await user.keyboard("{Enter}");
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByText("为什么记：用户约定"));
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("checkbox", { name: "选择记忆：机房访问约定" }));
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    disclosure.focus();
    await user.keyboard(" ");
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
  });
});
