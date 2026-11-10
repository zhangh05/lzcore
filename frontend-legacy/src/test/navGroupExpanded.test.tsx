import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { App } from "../app/App";
import { authApi } from "../api";
import { installMockApi, resetMocks } from "./mockServer";
import { useSessionStore } from "../stores/session";
import { useWorkbenchStore } from "../stores/workbench";
import { DataCenter, KnowledgeLibrary, MemoryPage } from "../routes";

describe("navigation group disclosure", () => {
  beforeEach(() => {
    resetMocks(); installMockApi();
    useSessionStore.getState().resetForUser("default");
    useWorkbenchStore.getState().resetForUser();
    window.history.replaceState({}, "", "/data");
    vi.spyOn(authApi, "status").mockResolvedValue({ ok: true, login_enabled: true, authenticated: true, username: "Admin" });
  });

  it("reports the menu's real visibility instead of the active route", async () => {
    render(<App />);
    const trigger = await screen.findByTestId("nav-group-materials");
    const group = trigger.closest(".app-nav-group")!;
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    // The current route lives in this group, but its menu is closed.
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.mouseEnter(group);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.mouseLeave(group);
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.focus(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(group).toHaveClass("menu-dismissed");
    fireEvent.blur(trigger, { relatedTarget: document.body });
    expect(group).not.toHaveClass("menu-dismissed");
    // Let the route chunks the current page and hover-preload requested finish
    // loading before the test environment is torn down.
    await Promise.all([DataCenter, KnowledgeLibrary, MemoryPage].map((page) => page.preload()));
    expect(await screen.findByTestId("page-data-center", {}, { timeout: 5000 })).toBeInTheDocument();
  });
});
