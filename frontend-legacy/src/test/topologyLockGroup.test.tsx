import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TopologyPage from "../../../extensions/network_operations/frontend/TopologyPage";
import { apiRequest } from "../api/client";
import { ConfirmHost } from "../components/ConfirmDialog";
import { MemoryRouter } from "../router";

vi.mock("../api/client", () => ({ apiRequest: vi.fn() }));

const mockTopologyWithNodes = {
  topology_id: "topo-lock-test",
  name: "固定联动测试图纸",
  description: "测试设备多选固定联动与解绑",
  version: 1,
  nodes: [
    { node_id: "node-sw1", display_name: "交换机-1", device_type: "switch", x: 100, y: 100 },
    { node_id: "node-sw2", display_name: "交换机-2", device_type: "switch", x: 300, y: 100 },
    { node_id: "node-rt1", display_name: "路由器-1", device_type: "router", x: 200, y: 250 },
  ],
  links: [],
  groups: [],
  canvas_items: [],
  created_at: "2026-09-26T00:00:00Z",
  updated_at: "2026-09-26T00:00:00Z",
};

describe("Topology Node Lock Group (固定联动)", () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockImplementation(async (request) => {
      if (request.url?.endsWith("/topologies/topo-lock-test")) {
        return mockTopologyWithNodes as never;
      }
      if (request.url?.endsWith("/topologies")) {
        return { topologies: [mockTopologyWithNodes] } as never;
      }
      return { ok: true, topology: mockTopologyWithNodes } as never;
    });
  });

  it("supports multi-selecting devices to lock relative positions, moves peers together, and unlocks", async () => {
    const putPayloads: Array<Record<string, unknown>> = [];
    vi.mocked(apiRequest).mockImplementation(async (request) => {
      if (request.method === "PUT") {
        putPayloads.push(request.data as Record<string, unknown>);
        return { ok: true, topology: { ...mockTopologyWithNodes, ...request.data, version: 2 } } as never;
      }
      if (request.url?.endsWith("/topologies/topo-lock-test") || request.url?.endsWith("/topologies")) {
        return { topologies: [mockTopologyWithNodes] } as never;
      }
      return { ok: true } as never;
    });

    render(
      <MemoryRouter initialEntries={["/extensions/network.operations/topology?id=topo-lock-test"]}>
        <TopologyPage />
        <ConfirmHost />
      </MemoryRouter>
    );

    await screen.findByTestId("topo-node-node-sw1");

    // Multi-select node-sw1 and node-sw2
    const batchSelectBtn = screen.getByTestId("topo-batch-select");
    batchSelectBtn.dataset.ids = "node-sw1,node-sw2";
    fireEvent.click(batchSelectBtn);

    // Inspector shows multi-select header and "固定选中设备" button
    expect(await screen.findByText("已选 2 个对象")).toBeInTheDocument();
    const lockButtons = screen.getAllByRole("button", { name: /固定选中设备/ });
    expect(lockButtons.length).toBeGreaterThan(0);

    // Click "固定选中设备"
    fireEvent.click(lockButtons[0]);

    // Notice appears
    expect(await screen.findByText(/已将选中的 2 台设备固定相对位置/)).toBeInTheDocument();

    // Now "解除固定" button should appear in the inspector
    const unlockButtons = await screen.findAllByRole("button", { name: /解除固定/ });
    expect(unlockButtons.length).toBeGreaterThan(0);

    // Simulate moving node-sw1 by dx=+60, dy=+40
    // node-sw1 original is (100, 100), moving to (160, 140)
    const moveBtn = screen.getByTestId("topo-move-elements");
    moveBtn.dataset.positions = JSON.stringify([
      { element_id: "node-sw1", x: 160, y: 140 },
    ]);
    fireEvent.click(moveBtn);

    // Save topology to inspect persisted nodes
    const saveBtn = screen.getByRole("button", { name: "保存" });
    fireEvent.click(saveBtn);

    await waitFor(() => expect(putPayloads.length).toBeGreaterThanOrEqual(1));
    const lastSaved = putPayloads[putPayloads.length - 1];
    const nodes = lastSaved.nodes as Array<{ node_id: string; x: number; y: number; lock_group?: string }>;
    const sw1 = nodes.find((n) => n.node_id === "node-sw1")!;
    const sw2 = nodes.find((n) => n.node_id === "node-sw2")!;
    const rt1 = nodes.find((n) => n.node_id === "node-rt1")!;

    // Both sw1 and sw2 moved by (+60, +40)!
    expect(sw1.x).toBe(160);
    expect(sw1.y).toBe(140);
    expect(sw2.x).toBe(360); // 300 + 60
    expect(sw2.y).toBe(140); // 100 + 40
    // rt1 is not in lock group, so its coordinates are unchanged
    expect(rt1.x).toBe(200);
    expect(rt1.y).toBe(250);

    // Both sw1 and sw2 share the same lock_group
    expect(sw1.lock_group).toBeDefined();
    expect(sw1.lock_group).toBe(sw2.lock_group);

    // Now test unlocking
    batchSelectBtn.dataset.ids = "node-sw1,node-sw2";
    fireEvent.click(batchSelectBtn);

    const unlockBtn = (await screen.findAllByRole("button", { name: /解除固定/ }))[0];
    fireEvent.click(unlockBtn);

    expect(await screen.findByText("已解除选中设备的固定联动")).toBeInTheDocument();

    // Save again and verify lock_group is cleared
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(putPayloads.length).toBeGreaterThanOrEqual(2));
    const finalSaved = putPayloads[putPayloads.length - 1];
    const finalNodes = finalSaved.nodes as Array<{ node_id: string; lock_group?: string }>;
    const finalSw1 = finalNodes.find((n) => n.node_id === "node-sw1")!;
    const finalSw2 = finalNodes.find((n) => n.node_id === "node-sw2")!;
    expect(finalSw1.lock_group).toBeUndefined();
    expect(finalSw2.lock_group).toBeUndefined();
  });

  it("displays locked status in single node inspector and allows unlinking", async () => {
    const lockedTopology = {
      ...mockTopologyWithNodes,
      nodes: [
        { node_id: "node-sw1", display_name: "交换机-1", device_type: "switch", x: 100, y: 100, lock_group: "lg_test_1" },
        { node_id: "node-sw2", display_name: "交换机-2", device_type: "switch", x: 300, y: 100, lock_group: "lg_test_1" },
      ],
    };

    vi.mocked(apiRequest).mockImplementation(async (request) => {
      if (request.url?.endsWith("/topologies/topo-lock-test") || request.url?.endsWith("/topologies")) {
        return { topologies: [lockedTopology] } as never;
      }
      return { ok: true, topology: lockedTopology } as never;
    });

    render(
      <MemoryRouter initialEntries={["/extensions/network.operations/topology?id=topo-lock-test"]}>
        <TopologyPage />
        <ConfirmHost />
      </MemoryRouter>
    );

    await screen.findByTestId("topo-node-node-sw1");

    // Click single node-sw1
    fireEvent.click(screen.getByTestId("topo-node-node-sw1"));

    // Single node inspector shows "已与 1 台设备固定联动"
    expect(await screen.findByText(/已与 1 台设备固定联动/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "选中同组设备" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "解除固定" })).toBeInTheDocument();

    // Click "解除固定"
    fireEvent.click(screen.getByRole("button", { name: "解除固定" }));
    expect(await screen.findByText("已解除设备固定联动")).toBeInTheDocument();
  });
});
