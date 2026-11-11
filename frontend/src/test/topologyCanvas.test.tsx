import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGateView } from "../app/AuthGate";
import { normalizeTopologyHref, readTopologyParam, writeTopologyParam } from "../extension-modules/network-operations/topology/topologyParams";
import { resetDirty } from "../extension-modules/network-operations/topology/platform/desktop/bridge";
import { BrowserRouter } from "../router";
import { installApp, type AppFixtureOptions } from "./appFixture";

function renderAt(url: string, opts: AppFixtureOptions = {}) {
  window.history.replaceState({}, "", url);
  const backend = installApp({ extensions: "network_ready", ...opts });
  render(<BrowserRouter><AuthGateView /></BrowserRouter>);
  return backend;
}
const BASE = "/extensions/network.operations/manage?ws=ws-demo-1&tab=topologies";

afterEach(() => { resetDirty(); });

describe("拓扑深链参数（P-30）", () => {
  it("读：topology 优先，兼容旧 topology_id 与通用 id；写：只写 topology", () => {
    expect(readTopologyParam("?topology=a&topology_id=b")).toBe("a");
    expect(readTopologyParam("?topology_id=b")).toBe("b");
    expect(readTopologyParam("?id=c")).toBe("c");
    const u = writeTopologyParam(new URL("http://x/p?topology_id=b&id=c&tab=topologies"), "b");
    expect(u.search).toBe("?tab=topologies&topology=b");
    expect(normalizeTopologyHref("/p?tab=topologies&topology=a")).toBeNull();
    expect(normalizeTopologyHref("/p?tab=topologies&topology_id=a")).toBe("/p?tab=topologies&topology=a");
  });
});

describe("拓扑画布（旧编辑器迁入扩展区）", () => {
  it("经注册表挂载可编辑画布；旧 topology_id 入参规范化为 topology", async () => {
    renderAt(`${BASE}&topology_id=topo1`);
    expect(await screen.findByTestId("topology-mount", {}, { timeout: 4000 })).toBeInTheDocument();
    expect(await screen.findByTestId("topo-node-n1", {}, { timeout: 4000 })).toHaveTextContent("核心-1");
    const q = new URLSearchParams(window.location.search);
    expect(q.get("topology")).toBe("topo1");
    expect(q.has("topology_id")).toBe(false);
    expect(q.get("tab")).toBe("topologies");
    // 编辑工具栏存在（不是只读预览）
    expect(screen.getByRole("toolbar", { name: "拓扑操作" })).toBeInTheDocument();
    expect(screen.queryByTestId("topology-preview")).toBeNull();
  });

  it("移动节点 → 未保存；站内跳转被守卫拦截；保存时 PUT 带 version 与新坐标", async () => {
    const { log } = renderAt(`${BASE}&topology=topo1`);
    await screen.findByTestId("topo-node-n1", {}, { timeout: 4000 });
    const move = screen.getByTestId("topo-move-elements");
    move.dataset.positions = JSON.stringify([{ element_id: "n1", x: 180, y: 140 }]);
    fireEvent.click(move);
    await waitFor(() => expect(screen.getByTestId("topology-mount").dataset.dirty).toBe("1"));

    const confirmSpy = vi.fn(() => false);
    window.confirm = confirmSpy;
    fireEvent.click(within(screen.getByRole("navigation", { name: "主导航" })).getByText("任务").closest("a")!);
    expect(confirmSpy).toHaveBeenCalledWith("拓扑有未保存的改动，确定离开吗？");
    expect(window.location.pathname).toBe("/extensions/network.operations/manage");
    // 切到同页别的 tab 也要确认
    fireEvent.click(screen.getByRole("tab", { name: /^设备/ }));
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("topologies");

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(log.some((l) => l.method === "PUT" && l.path.startsWith("/api/extensions/network.operations/topologies/topo1"))).toBe(true));
    const put = log.find((l) => l.method === "PUT")!.body as { version: number; nodes: { node_id: string; x: number; y: number }[] };
    expect(put.version).toBe(3);
    expect(put.nodes.find((n) => n.node_id === "n1")).toMatchObject({ x: 180, y: 140 });
    await waitFor(() => expect(screen.getByTestId("topology-mount").dataset.dirty).toBe("0"));
  });

  it("多选节点后可编为区域 / 固定联动（区域编辑入口可用）", async () => {
    renderAt(`${BASE}&topology=topo1`);
    await screen.findByTestId("topo-node-n1", {}, { timeout: 4000 });
    const sel = screen.getByTestId("topo-batch-select");
    sel.dataset.ids = "n1,n2";
    act(() => { fireEvent.click(sel); });
    expect(await screen.findByText("已选 2 个对象")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /固定选中设备/ }).length).toBeGreaterThan(0);
  });

  it("保存遇到 409 版本冲突：进入冲突态，不静默覆盖", async () => {
    const { log } = renderAt(`${BASE}&topology=topo1`, { conflict: "topology" });
    await screen.findByTestId("topo-node-n1", {}, { timeout: 4000 });
    const move = screen.getByTestId("topo-move-elements");
    move.dataset.positions = JSON.stringify([{ element_id: "n1", x: 220, y: 160 }]);
    fireEvent.click(move);
    fireEvent.click(await screen.findByRole("button", { name: "保存" }));
    await waitFor(() => expect(log.filter((l) => l.method === "PUT").length).toBe(1));
    await waitFor(() => expect(document.querySelector(".topology-save-btn.status-conflict")).not.toBeNull());
    expect(document.querySelector(".topology-save-btn")!.getAttribute("title")).toContain("被其他人修改过");
    expect(screen.getByTestId("topology-mount").dataset.dirty).toBe("1");
  });
});
