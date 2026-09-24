import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { ComponentProps } from "react";
import TopologyWorkspace, { type Topology } from "../../../extensions/network_operations/frontend/components/TopologyWorkspace";
import type NetOpsCanvas from "../../../extensions/network_operations/frontend/components/NetOpsCanvas";
import { apiRequest } from "../api/client";
import { ConfirmHost } from "../components/ConfirmDialog";
import { MemoryRouter } from "../router";

vi.mock("../api/client", () => ({ apiRequest: vi.fn() }));
vi.mock("../../../extensions/network_operations/frontend/components/NetOpsCanvas", () => ({
  default: (props: ComponentProps<typeof NetOpsCanvas>) => <>
    <button onClick={() => props.onSelectNode("old")}>旧详情</button>
    <button onClick={() => props.onSelectionChange(["canvas-note"])}>框选一个文本框</button>
    <button onClick={() => props.onSelectionChange(["old", "other"])}>框选两个节点</button>
  </>,
}));

const topology: Topology = {
  topology_id: "keyboard", name: "键盘测试", description: "", version: 1,
  nodes: [{ node_id: "old", display_name: "旧节点", x: 0, y: 0 }, { node_id: "other", x: 100, y: 100 }],
  links: [], groups: [], canvas_items: [{ item_id: "note", kind: "text", text: "备注", x: 50, y: 50, width: 100, height: 40 }],
  created_at: "", updated_at: "",
};

beforeEach(() => {
  vi.mocked(apiRequest).mockImplementation(async (request) => {
    if (request.method === "PUT") return { topology: { ...topology, ...request.data, version: 2 } } as never;
    return { skills: [] } as never;
  });
});

function setup() {
  render(
    <MemoryRouter initialEntries={["/topology"]}>
      <TopologyWorkspace workspaceId="default"
        topologies={[topology]} loadError="" onReload={async () => {}} setNotice={() => {}} busy={false} />
      <ConfirmHost />
    </MemoryRouter>
  );
}

test("Delete uses a lone canvas item rather than an earlier node inspector", async () => {
  setup();
  fireEvent.click(screen.getByText("旧详情"));
  fireEvent.click(screen.getByText("框选一个文本框"));
  fireEvent.keyDown(window, { key: "Delete" });
  const dialog = screen.getByRole("dialog");
  expect(dialog).toHaveTextContent("0 个节点、1 个图元");
  fireEvent.click(within(dialog).getByRole("button", { name: "移除" }));
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(expect.objectContaining({
    method: "PUT", data: expect.objectContaining({ nodes: topology.nodes, canvas_items: [] }),
  })), { timeout: 3000 });
});

test("studio dialogs are modal so canvas shortcuts do not fire behind them", async () => {
  setup();
  fireEvent.click(screen.getByText("框选两个节点"));
  fireEvent.click(screen.getByRole("button", { name: "版本历史" }));
  const dialog = await screen.findByRole("dialog", { name: "版本历史" });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  fireEvent.keyDown(window, { key: "Delete" });
  expect(screen.getByRole("dialog", { name: "版本历史" })).toBe(dialog);
  expect(screen.queryByRole("button", { name: "移除" })).not.toBeInTheDocument();
});

test("modal keyboard events do not move the selected drawing or replace its confirmation", () => {
  setup();
  fireEvent.click(screen.getByText("框选两个节点"));
  fireEvent.keyDown(window, { key: "Delete" });
  const dialog = screen.getByRole("dialog");
  fireEvent.keyDown(within(dialog).getByRole("button", { name: "取消" }), { key: "ArrowRight" });
  fireEvent.keyDown(window, { key: "Delete" });
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
