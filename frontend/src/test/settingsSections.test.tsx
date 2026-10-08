/**
 * Settings — grouped sections (batch 5 redesign).
 *
 * The section rail only navigates; every section stays rendered. 外观 writes
 * the existing UI store (same theme/density the header and account menu use)
 * and never calls a settings API. The danger zone keeps btn-reset-llm with the
 * same confirm → providerDelete flow and disabled rules.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "../pages/Settings/Settings";
import { settingsApi } from "../api";
import { useSessionStore, useUIStore } from "../stores/session";
import { ConfirmHost } from "../components/ConfirmDialog";
import type { ProviderConfig } from "../types";

const provider = (id: string, extra: Partial<ProviderConfig> = {}): ProviderConfig => ({
  provider: id, provider_type: "openai_compatible", label: id.toUpperCase(), enabled: true,
  base_url: "https://gw.example/v1", model: "m", temperature: 0.2, max_tokens: 1200,
  safe_mode: true, prompt_cache_enabled: true, key_configured: false, key_preview: null,
  is_active: false, ...extra,
} as ProviderConfig);

function mockApi(providers: ProviderConfig[], active: string) {
  vi.spyOn(settingsApi, "providersList").mockResolvedValue({ ok: true, active, providers } as never);
  vi.spyOn(settingsApi, "workspaceSettings").mockResolvedValue({ workspace: { memory_enabled: true } } as never);
  const update = vi.spyOn(settingsApi, "updateWorkspaceSettings").mockResolvedValue({ ok: true } as never);
  const del = vi.spyOn(settingsApi, "providerDelete").mockResolvedValue({ ok: true, deleted: true } as never);
  const get = vi.spyOn(settingsApi, "providerGet").mockResolvedValue({ ok: true, config: providers[0] } as never);
  const save = vi.spyOn(settingsApi, "providerSave");
  return { update, del, get, save };
}

beforeEach(() => {
  vi.restoreAllMocks();
  useSessionStore.setState({ currentWorkspaceId: "ws-settings", currentSessionId: null });
  useUIStore.setState({ theme: "light", themePreference: "light", density: "comfortable" });
});

describe("Settings sections", () => {
  it("renders every group at once with a section rail", async () => {
    mockApi([provider("openai", { is_active: true })], "openai");
    render(<Settings />);
    const nav = await screen.findByRole("navigation", { name: "设置分区" });
    for (const name of ["模型服务", "长期记忆", "外观", "危险操作"]) {
      expect(nav).toHaveTextContent(name);
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    expect(screen.getByTestId("form-card")).toBeVisible();
    expect(screen.getByTestId("toggle-memory-enabled")).toBeVisible();
    expect(screen.getByTestId("btn-reset-llm")).toBeVisible();
  });

  it("marks the chosen section current without hiding the others", async () => {
    const user = userEvent.setup();
    mockApi([provider("openai", { is_active: true })], "openai");
    render(<Settings />);
    const nav = await screen.findByRole("navigation", { name: "设置分区" });
    const appearance = Array.from(nav.querySelectorAll("button")).find((b) => b.textContent?.startsWith("外观"))!;
    await user.click(appearance);
    expect(appearance).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("heading", { level: 2, name: "外观" })).toHaveFocus();
    expect(screen.getByTestId("form-card")).toBeVisible();
  });

  it("appearance writes the existing UI store only — no settings request", async () => {
    const user = userEvent.setup();
    const { update, save } = mockApi([provider("openai", { is_active: true })], "openai");
    render(<Settings />);
    const theme = await screen.findByRole("radiogroup", { name: "主题" });
    const density = screen.getByRole("radiogroup", { name: "显示密度" });
    expect(screen.getByRole("radio", { name: "浅色" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "深色" }));
    expect(useUIStore.getState().theme).toBe("dark");
    expect(useUIStore.getState().themePreference).toBe("dark");
    await user.click(screen.getByRole("radio", { name: "紧凑" }));
    expect(useUIStore.getState().density).toBe("compact");
    expect(JSON.parse(localStorage.getItem("lzcore_ui") || "{}").state).toMatchObject({ theme: "dark", density: "compact" });

    useUIStore.setState({ theme: "light", density: "comfortable" });
    await waitFor(() => expect(screen.getByRole("radio", { name: "浅色" })).toBeChecked());
    expect(screen.getByRole("radio", { name: "舒适" })).toBeChecked();
    expect(theme).toBeInTheDocument(); expect(density).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("danger zone keeps the reset flow and the active-custom disabled rule", async () => {
    const user = userEvent.setup();
    const { del } = mockApi([provider("openai", { is_active: true, is_builtin: true }), provider("corp", { is_builtin: false })], "openai");
    render(<><Settings /><ConfirmHost /></>);
    const reset = await screen.findByTestId("btn-reset-llm");
    expect(reset).toHaveTextContent("重置");
    expect(reset).toBeEnabled();
    await user.click(reset);
    await user.click(await screen.findByRole("button", { name: "取消" }));
    expect(del).not.toHaveBeenCalled();
    await user.click(reset);
    await user.click(await screen.findByTestId("confirm-dialog-confirm"));
    await waitFor(() => expect(del).toHaveBeenCalledWith("openai"));

    await user.click(screen.getByTestId("provider-corp"));
    expect(screen.getByTestId("btn-reset-llm")).toHaveTextContent("删除厂商");
    expect(screen.getByTestId("btn-reset-llm")).toBeEnabled();
  });

  it("cannot delete the active custom provider", async () => {
    mockApi([provider("corp", { is_active: true, is_builtin: false })], "corp");
    render(<Settings />);
    const reset = await screen.findByTestId("btn-reset-llm");
    expect(reset).toBeDisabled();
    expect(reset).toHaveAttribute("title", "先应用其他厂商，再删除当前厂商");
  });
});
