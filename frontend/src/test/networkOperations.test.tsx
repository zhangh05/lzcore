import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, vi } from "vitest";
import NetworkOperations from "../../../extensions/network_operations/frontend/NetworkOperations";
import { apiRequest } from "../api/client";
import { ConfirmHost } from "../components/ConfirmDialog";

vi.mock("../api/client", () => ({ apiRequest: vi.fn() }));
const tools = ["network.operations.device.manage"];
const skill = { skill_id: "s1", name: "测试巡检", description: "", enabled: true, device_ids: ["d1"], connection_ids: ["c1"], allowed_tool_ids: tools };
const sampleTopology = {
  topology_id: "t1",
  name: "数据中心拓扑",
  description: "生产核心网",
  version: 1,
  nodes: [{ device_id: "d1", x: 100, y: 100, display_name: "核心交换机-1" }],
  links: [],
  groups: [{ group_id: "g1", name: "生产DC", kind: "datacenter", x: 50, y: 50, width: 400, height: 300 }],
  created_at: "2026-09-06T00:00:00Z",
  updated_at: "2026-09-06T00:00:00Z",
};

beforeEach(() => {
  vi.mocked(apiRequest).mockImplementation(async (request) => {
    if (request.method !== "GET") return { ok: true, topology: sampleTopology } as never;
    if (request.url?.endsWith("/regions")) return { regions: [{ region_id: "r1", name: "测试区域" }] } as never;
    if (request.url?.endsWith("/devices")) return { devices: [{ device_id: "d1", name: "CE_1", host: "127.0.0.1", vendor: "h3c", device_type: "switch", region_id: "r1" }] } as never;
    if (request.url?.endsWith("/connections")) return { connections: [{ connection_id: "c1", device_id: "d1", protocol: "telnet", port: 30001, credential_configured: true, status: "untested", verified: false }] } as never;
    if (request.url?.endsWith("/topologies")) return { topologies: [sampleTopology] } as never;
    if (request.url?.includes("/compare")) return {
        topology_id: "t1",
        topology_name: "数据中心拓扑",
        topology_devices_not_in_scope: [],
        devices_in_scope_not_in_topology: [],
        link_comparisons: [{ link_id: "l1", source_device_id: "d1", target_device_id: "d2", source_interface: "GE0/0", target_interface: "GE0/1", comparison_status: "unknown", note: "无两端接口邻接证据，保持未知状态" }],
        summary: { total_nodes: 2, total_links: 1, matched_links: 0, mismatched_links: 0, unknown_evidence_links: 1, available_devices_missing_from_topology: 0 },
    } as never;
    if (request.url?.endsWith("/context")) return {
      observations: [{ observation_id: "o1", source_id: "inspection-1", observed_at: "2026-09-06T00:00:00Z", completeness: "complete", target_ids: ["c1"] }],
      references: [{ reference_id: "ref1", name: "巡检候选参考", state: "candidate", authority: "observed", current: false, completeness: "complete", target_ids: ["c1"], updated_at: "2026-09-06T00:00:00Z" }],
      command_experience: [{ experience_id: "e1", connection_id: "c1", driver_id: "h3c.comware", command: "display version", status: "accepted", observations: 1, last_observed_at: "2026-09-06T00:00:00Z" }],
      sources: [{ source_id: "live_cli", kind: "live_observation", available: true, authority: "observed" }],
    } as never;
    return { skills: [skill] } as never;
  });
});

test("device inventory is first; editors are on demand and search works", async () => {
  render(<NetworkOperations />);
  await screen.findByTestId("device-card-d1");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("搜索设备"), { target: { value: "absent" } });
  expect(screen.getByText("没有匹配的设备")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("搜索设备"), { target: { value: "CE_1" } });
  fireEvent.click(screen.getByRole("button", { name: "编辑设备" }));
  expect(screen.getByRole("dialog", { name: "设备编辑面板" })).toBeInTheDocument();
  expect(screen.getByLabelText("设备名称")).toHaveValue("CE_1");
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("published Skill has device configuration capability by default", async () => {
  render(<NetworkOperations />);
  await screen.findByTestId("device-card-d1");
  fireEvent.click(screen.getByRole("tab", { name: /Skill 配置/ }));
  expect(screen.getByText("可执行设备配置")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "编辑 Skill" }));
  const dialog = screen.getByRole("dialog", { name: "Skill 编辑面板" });
  expect(within(dialog).queryByText(/实时设备只读操作/)).not.toBeInTheDocument();
  expect(within(dialog).queryByRole("checkbox", { name: /允许配置写入/ })).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "保存 Skill" }));
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(expect.objectContaining({
    method: "PUT", data: expect.objectContaining({ allowed_tool_ids: tools }),
  })));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

test("operational context separates observations from explicitly confirmed references", async () => {
  render(<><NetworkOperations /><ConfirmHost /></>);
  await screen.findByTestId("device-card-d1");
  fireEvent.click(screen.getByRole("tab", { name: /环境与证据/ }));
  expect(screen.getByText("巡检候选参考")).toBeInTheDocument();
  expect(screen.getByText(/巡检只产生候选参考/)).toBeInTheDocument();
  expect(screen.getByText("display version")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "确认参考" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "确认参考" }));
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(expect.objectContaining({
    method: "POST", url: "/extensions/network.operations/references/ref1", data: expect.objectContaining({ action: "confirm" }),
  })));
});

test("selects and permanently deletes multiple operational references in one request", async () => {
  const original = vi.mocked(apiRequest).getMockImplementation();
  vi.mocked(apiRequest).mockImplementation(async (request) => {
    if (request.url?.endsWith("/context")) return {
      observations: [], command_experience: [], sources: [],
      references: [
        { reference_id: "ref-a", name: "巡检候选参考 A", state: "candidate", authority: "observed", current: false, completeness: "complete", target_ids: ["c1"], updated_at: "2026-09-06T00:00:00Z" },
        { reference_id: "ref-b", name: "巡检候选参考 B", state: "candidate", authority: "observed", current: false, completeness: "complete", target_ids: ["c2"], updated_at: "2026-09-07T00:00:00Z" },
      ],
    } as never;
    return original?.(request) as never;
  });
  render(<><NetworkOperations /><ConfirmHost /></>);
  await screen.findByTestId("device-card-d1");
  fireEvent.click(screen.getByRole("tab", { name: /环境与证据/ }));
  fireEvent.click(screen.getByLabelText("选择运行参考 巡检候选参考 A"));
  fireEvent.click(screen.getByLabelText("选择运行参考 巡检候选参考 B"));
  fireEvent.click(screen.getByRole("button", { name: "删除已选 (2)" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "永久删除" }));
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(expect.objectContaining({
    method: "DELETE", url: "/extensions/network.operations/references/batch-delete",
    data: { workspace_id: "default", reference_ids: ["ref-a", "ref-b"] },
  })));
});

test("selects observations and command feedback for their own batch-delete endpoints", async () => {
  const original = vi.mocked(apiRequest).getMockImplementation();
  vi.mocked(apiRequest).mockImplementation(async (request) => {
    if (request.url?.endsWith("/context")) return {
      references: [], sources: [],
      observations: [
        { observation_id: "obs-a", source_id: "inspection-a", observed_at: "2026-09-06T00:00:00Z", completeness: "complete", target_ids: ["c1"] },
        { observation_id: "obs-b", source_id: "inspection-b", observed_at: "2026-09-07T00:00:00Z", completeness: "partial", target_ids: ["c2"] },
      ],
      command_experience: [
        { experience_id: "exp-a", connection_id: "c1", driver_id: "h3c.comware", command: "display version", status: "accepted", observations: 1, last_observed_at: "2026-09-06T00:00:00Z" },
        { experience_id: "exp-b", connection_id: "c2", driver_id: "h3c.comware", command: "display interface brief", status: "accepted", observations: 1, last_observed_at: "2026-09-07T00:00:00Z" },
      ],
    } as never;
    return original?.(request) as never;
  });
  render(<><NetworkOperations /><ConfirmHost /></>);
  await screen.findByTestId("device-card-d1");
  fireEvent.click(screen.getByRole("tab", { name: /环境与证据/ }));
  fireEvent.click(screen.getByLabelText("选择全部最近观察"));
  fireEvent.click(screen.getByRole("button", { name: "删除已选 (2)" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "永久删除" }));
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(expect.objectContaining({
    method: "DELETE", url: "/extensions/network.operations/observations/batch-delete",
    data: { workspace_id: "default", observation_ids: ["obs-a", "obs-b"] },
  })));

  fireEvent.click(screen.getByLabelText("选择全部命令反馈"));
  fireEvent.click(screen.getByRole("button", { name: "删除已选 (2)" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "永久删除" }));
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(expect.objectContaining({
    method: "DELETE", url: "/extensions/network.operations/command-experience/batch-delete",
    data: { workspace_id: "default", experience_ids: ["exp-a", "exp-b"] },
  })));
});

test("command feedback renders one row for duplicate driver commands during a rolling upgrade", async () => {
  const original = vi.mocked(apiRequest).getMockImplementation();
  vi.mocked(apiRequest).mockImplementation(async (request) => {
    if (request.url?.endsWith("/context")) return {
      observations: [], references: [], sources: [],
      command_experience: [
        { experience_id: "legacy-1", connection_id: "c1", driver_id: "h3c.comware", command: "display cpu-usage", status: "accepted", observations: 1, last_observed_at: "2026-09-06T00:00:00Z" },
        { experience_id: "legacy-2", connection_id: "c2", driver_id: "h3c.comware", command: " DISPLAY   CPU-USAGE ", status: "accepted", observations: 1, last_observed_at: "2026-09-07T00:00:00Z" },
      ],
    } as never;
    return original?.(request) as never;
  });
  render(<NetworkOperations />);
  await screen.findByTestId("device-card-d1");
  fireEvent.click(screen.getByRole("tab", { name: /环境与证据/ }));
  expect(screen.getAllByText(/DISPLAY\s+CPU-USAGE/i)).toHaveLength(1);
  expect(screen.getByText("1 条")).toBeInTheDocument();
  expect(screen.getByText(/2 次观察/)).toBeInTheDocument();
});

test("operational context exposes confirmed hard deletes", async () => {
  render(<><NetworkOperations /><ConfirmHost /></>);
  await screen.findByTestId("device-card-d1");
  fireEvent.click(screen.getByRole("tab", { name: /环境与证据/ }));
  fireEvent.click(screen.getByRole("button", { name: "永久删除观察 inspection-1" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "永久删除" }));
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(expect.objectContaining({
    method: "DELETE", url: "/extensions/network.operations/observations/o1", data: { workspace_id: "default" },
  })));
  fireEvent.click(screen.getByRole("button", { name: "永久删除命令反馈 display version" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "永久删除" }));
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(expect.objectContaining({
    method: "DELETE", url: "/extensions/network.operations/command-experience/e1", data: { workspace_id: "default" },
  })));
});

test("context loading failure does not hide device and Skill management", async () => {
  const original = vi.mocked(apiRequest).getMockImplementation();
  vi.mocked(apiRequest).mockImplementation(async (request) => {
    if (request.url?.endsWith("/context")) throw new Error("context unavailable");
    return original?.(request) as never;
  });
  render(<NetworkOperations />);
  expect(await screen.findByTestId("device-card-d1")).toBeInTheDocument();
  expect(screen.queryByText("数据加载失败，请检查服务。")).not.toBeInTheDocument();
});

test("topology tab keeps the canvas primary and exposes the device palette", async () => {
  render(<NetworkOperations />);
  await screen.findByTestId("device-card-d1");
  fireEvent.click(screen.getByRole("tab", { name: /网络拓扑/ }));
  const matches = await screen.findAllByText(/数据中心拓扑/);
  expect(matches.length).toBeGreaterThan(0);
  expect(screen.getAllByText("v1").length).toBeGreaterThan(0);
  expect(screen.getByText("已全部加入")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "查看详情" })).toBeInTheDocument();
  expect(screen.getByTestId("palette-dev-d1")).toBeInTheDocument();
  expect(within(screen.getByTestId("palette-dev-d1")).getByText("已在画布")).toBeInTheDocument();
});

test("topology endpoint failure is shown as a loading error instead of an empty canvas", async () => {
  const original = vi.mocked(apiRequest).getMockImplementation();
  vi.mocked(apiRequest).mockImplementation(async (request) => {
    if (request.url?.endsWith("/topologies")) throw new Error("topology endpoint unavailable");
    return original?.(request) as never;
  });
  render(<NetworkOperations />);
  await screen.findByTestId("device-card-d1");
  fireEvent.click(screen.getByRole("tab", { name: /网络拓扑/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("拓扑数据加载失败");
  expect(screen.queryByText("尚未创建网络拓扑")).not.toBeInTheDocument();
});

test("associates topology with Skill and displays it in Skill card", async () => {
  render(<NetworkOperations />);
  await screen.findByTestId("device-card-d1");
  fireEvent.click(screen.getByRole("tab", { name: /Skill 配置/ }));
  fireEvent.click(screen.getByRole("button", { name: "编辑 Skill" }));
  const dialog = screen.getByRole("dialog", { name: "Skill 编辑面板" });
  fireEvent.change(within(dialog).getByRole("combobox", { name: /关联网络拓扑/ }), { target: { value: "t1" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存 Skill" }));
  await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(expect.objectContaining({
    method: "PUT",
    data: expect.objectContaining({ topology_id: "t1" }),
  })));
});

test("topology compare modal opens and emphasizes evidence-based unknown status", async () => {
  render(<NetworkOperations />);
  await screen.findByTestId("device-card-d1");
  fireEvent.click(screen.getByRole("tab", { name: /网络拓扑/ }));
  const matches = await screen.findAllByText(/数据中心拓扑/);
  expect(matches.length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "拓扑比对" }));
  expect(await screen.findByRole("dialog", { name: "拓扑比对报告" })).toBeInTheDocument();
  expect(screen.getByText(/无两端接口邻接证据，保持未知状态/)).toBeInTheDocument();
  expect(screen.getByText("暂无证据链路")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "关闭报告" }));
  await waitFor(() => expect(screen.queryByText(/拓扑比对报告/)).not.toBeInTheDocument());
});

test("removing a node from topology preserves the workspace device entity", async () => {
  render(<><NetworkOperations /><ConfirmHost /></>);
  await screen.findByTestId("device-card-d1");
  fireEvent.click(screen.getByRole("tab", { name: /网络拓扑/ }));
  const matches = await screen.findAllByText(/数据中心拓扑/);
  expect(matches.length).toBeGreaterThan(0);

  // Click on node in canvas
  const nodeEl = await screen.findByTestId("topo-node-d1");
  fireEvent.click(nodeEl);

  // Inspector should show node properties and remove button
  const removeBtn = await screen.findByRole("button", { name: "从拓扑中移除节点" });
  fireEvent.click(removeBtn);

  // Confirm dialog should state device entity will be preserved
  expect(screen.getByText(/工作区的“CE_1”设备实体及管理连接将被完整保留/)).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "从拓扑移除" }));

  // Node is removed from topology, but device still exists in workspace
  await waitFor(() => {
    expect(within(screen.getByTestId("palette-dev-d1")).getByRole("button", { name: "加入" })).toBeInTheDocument();
  });
});
