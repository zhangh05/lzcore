import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import TopologyWorkspace, { type Topology } from "../../../extensions/network_operations/frontend/components/TopologyWorkspace";
import type NetOpsCanvas from "../../../extensions/network_operations/frontend/components/NetOpsCanvas";
import { applyDrawingEdit, drawingActivity, moveDrawingNodes } from "../../../extensions/network_operations/frontend/components/topologyCollaboration";
import { mergeTopologies } from "../../../extensions/network_operations/frontend/components/topologyMerge";
import { apiRequest } from "../api/client";
import { MemoryRouter } from "../router";

const live = vi.hoisted(() => ({ updated: null as null | ((data: Record<string, unknown>) => void), prepare: null as null | (() => Promise<unknown>) }));
vi.mock("../api/client", () => ({ apiRequest: vi.fn() }));
vi.mock("../realtime/turnTransport", () => ({
  onTopologyUpdated: (callback: (data: Record<string, unknown>) => void) => { live.updated = callback; return () => { live.updated = null; }; },
  onTransportResumed: () => () => {},
}));
vi.mock("../../../extensions/network_operations/frontend/components/NetOpsCanvas", () => ({
  default: (props: ComponentProps<typeof NetOpsCanvas>) => <>
    <output data-testid="drawing">{JSON.stringify(props.topology)}</output>
    <output data-testid="changes">{JSON.stringify(props.highlightedIds)}</output>
    <button onClick={() => props.onSelectNode("a")}>选择A</button>
    <button onClick={() => props.onMoveElements([{ element_id: "a", x: 100, y: 0 }])}>移动A</button>
    <button onClick={() => props.onMoveElements([{ element_id: "b", x: 500, y: 0 }])}>移动B</button>
  </>,
}));
vi.mock("../../../extensions/network_operations/frontend/components/TopologyAgentPanel", () => ({
  TopologyAgentPanel: (props: { prepareDrawing: () => Promise<unknown>; activities: Array<{version: number; status: string}>; onUndoChange: (version: number) => void }) => {
    live.prepare = props.prepareDrawing;
    return <>{props.activities.map(item => <button key={item.version} onClick={() => props.onUndoChange(item.version)}>撤销协作{item.version} {item.status}</button>)}</>;
  },
}));

const sheet: Topology = { topology_id: "sheet", name: "协作", description: "", version: 1,
  nodes: [{node_id: "a", x: 0, y: 0}, {node_id: "b", x: 300, y: 0}],
  links: [], groups: [], canvas_items: [], created_at: "", updated_at: "" };
const snapshot = () => JSON.parse(screen.getByTestId("drawing").textContent || "{}") as Topology;
let remote: Topology;
beforeEach(() => {
  vi.mocked(apiRequest).mockClear();
  remote = structuredClone(sheet);
  vi.mocked(apiRequest).mockImplementation(async request => {
    if (request.method === "PUT") {
      remote = { ...remote, ...request.data, version: remote.version + 1 };
      return { topology: remote } as never;
    }
    if (request.url?.endsWith("/topologies/sheet")) return { topology: structuredClone(remote) } as never;
    return { skills: [], revisions: [], node_overlays: [] } as never;
  });
});
function setup() {
  render(<MemoryRouter initialEntries={["/topology?topology=sheet"]}>
    <TopologyWorkspace workspaceId="ws" topologies={[sheet]} loadError="" onReload={async () => {}} setNotice={() => {}} busy={false} />
  </MemoryRouter>);
}
async function update(next: Topology) {
  remote = next;
  await act(async () => { live.updated?.({workspace_id: "ws", topology_id: "sheet", version: remote.version}); });
}

describe("drawing deltas", () => {
  it("undoes only collaboration fields and keeps subsequent manual edits", () => {
    const after = {...sheet, version: 2, nodes: [{...sheet.nodes[0], x: 100}, sheet.nodes[1]]};
    const current = {...after, version: 4, nodes: [after.nodes[0], {...after.nodes[1], y: 200}]};
    const result = applyDrawingEdit(current, {before: sheet, after, source: "collaboration"});
    expect(result.conflicts).toEqual([]);
    expect(result.topology.version).toBe(4);
    expect(result.topology.nodes.map(node => [node.x, node.y])).toEqual([[0, 0], [300, 200]]);
  });
  it("rejects undo of overlapping later changes and new dependent links", () => {
    const after = {...sheet, version: 2, nodes: [{...sheet.nodes[0], x: 100}, sheet.nodes[1]]};
    expect(applyDrawingEdit({...after, nodes: [{...after.nodes[0], x: 150}, after.nodes[1]]}, {before: sheet, after, source: "collaboration"}).conflicts).toHaveLength(1);
    const added = {...sheet, nodes: [...sheet.nodes, {node_id: "c", x: 600, y: 0}]};
    const linked: Topology = {...added, links: [{link_id: "bc", source_node_id: "b", target_node_id: "c", kind: "physical", source_interface: "", target_interface: "", source: "manual", status: "unknown"}]};
    expect(applyDrawingEdit(linked, {before: sheet, after: added, source: "collaboration"}).conflicts[0].field).toBe("端点已删除");
  });
  it("moves fixed-link members and reports actual object changes", () => {
    const nodes = sheet.nodes.map(node => ({...node, lock_group: "rigid"}));
    const moved = moveDrawingNodes(nodes, [{element_id: "a", x: 100, y: 20}]);
    expect(moved.map(node => [node.x, node.y])).toEqual([[100, 20], [400, 20]]);
    const activity = drawingActivity({...sheet, nodes}, {...sheet, nodes: moved}, "displayed");
    expect(activity.ids).toEqual(["a", "b"]);
    expect(activity.modified).toBe(2);
  });
  it("ignores persistence timestamps and versions when merging edits", () => {
    const result = mergeTopologies(sheet, {...sheet, version: 5, updated_at: "local"}, {...sheet, version: 6, updated_at: "remote"});
    expect(result.conflicts).toEqual([]);
    expect(result.topology.version).toBe(6);
  });
});

describe("workspace collaboration", () => {
  it("keeps selected nodes available without opening details over the drawing conversation", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", {name: "绘图对话"}));
    fireEvent.click(screen.getByText("选择A"));
    expect(document.querySelector(".topology-inspector")).not.toHaveClass("is-open");
    fireEvent.click(screen.getByRole("button", {name: "绘图对话"}));
    await waitFor(() => expect(document.querySelector(".topology-inspector")).toHaveClass("is-open"));
  });
  it("merges an agent move with a dirty manual move and can undo just the agent move", async () => {
    setup();
    await waitFor(() => expect(live.updated).not.toBeNull());
    fireEvent.click(screen.getByText("移动B"));
    await update({...sheet, version: 2, nodes: [{...sheet.nodes[0], x: 200}, sheet.nodes[1]]});
    await waitFor(() => expect(snapshot().nodes.map(node => node.x)).toEqual([200, 500]));
    expect(screen.getByTestId("changes")).toHaveTextContent('"a"');
    fireEvent.click(screen.getByText("撤销协作2 displayed"));
    expect(snapshot().nodes.map(node => node.x)).toEqual([0, 500]);
    fireEvent.click(screen.getByRole("button", {name: "保存"}));
    await waitFor(() => expect(remote.nodes.map(node => node.x)).toEqual([0, 500]));
    expect(remote.version).toBe(3);
  });
  it("keeps overlapping edits pending and refuses to send against that conflict", async () => {
    setup();
    fireEvent.click(screen.getByText("移动A"));
    await update({...sheet, version: 2, nodes: [{...sheet.nodes[0], x: 200}, sheet.nodes[1]]});
    await waitFor(() => expect(screen.getByText("撤销协作2 pending")).toBeInTheDocument());
    expect(snapshot().nodes[0].x).toBe(100);
    await expect(live.prepare!()).rejects.toThrow("冲突");
    expect(vi.mocked(apiRequest).mock.calls.filter(([request]) => request.method === "PUT")).toHaveLength(0);
  });
  it("flushes a newly edited node before preparing an agent baseline", async () => {
    setup();
    fireEvent.click(screen.getByText("移动A"));
    let baseline: unknown;
    await act(async () => { baseline = await live.prepare!(); });
    expect(baseline).toMatchObject({version: 2, nodes: [{node_id: "a", x: 100}, {node_id: "b", x: 300}]});
    expect(snapshot().version).toBe(2);
  });
  it("includes manual edits made while a save is in flight in the confirmed baseline", async () => {
    setup();
    const baseMock = vi.mocked(apiRequest).getMockImplementation()!;
    let release!: () => void;
    let waiting = true;
    vi.mocked(apiRequest).mockImplementation(async request => {
      if (request.method === "PUT" && waiting) {
        waiting = false;
        await new Promise<void>(resolve => { release = resolve; });
      }
      return baseMock(request);
    });
    fireEvent.click(screen.getByText("移动A"));
    const prepared = live.prepare!();
    await waitFor(() => expect(release).toBeDefined());
    fireEvent.click(screen.getByText("移动B"));
    let baseline: unknown;
    await act(async () => { release(); baseline = await prepared; });
    expect(baseline).toMatchObject({version: 3, nodes: [{node_id: "a", x: 100}, {node_id: "b", x: 500}]});
  });
  it("reconciles a clicked save after a lost response without a second write", async () => {
    setup();
    const baseMock = vi.mocked(apiRequest).getMockImplementation()!;
    let loseResponse = true;
    vi.mocked(apiRequest).mockImplementation(async request => {
      const result = await baseMock(request);
      if (request.method === "PUT" && loseResponse) { loseResponse = false; throw new Error("response_lost"); }
      return result;
    });
    fireEvent.click(screen.getByText("移动A"));
    await act(async () => { await expect(live.prepare!()).rejects.toThrow("保存未确认"); });
    fireEvent.click(screen.getByRole("button", {name: "保存"}));
    await waitFor(() => expect(snapshot().version).toBe(2));
    expect(snapshot().nodes[0].x).toBe(100);
    expect(vi.mocked(apiRequest).mock.calls.filter(([request]) => request.method === "PUT")).toHaveLength(1);
  });
  it("does not replay a save with an unknown result and reads back before the next attempt", async () => {
    setup();
    const baseMock = vi.mocked(apiRequest).getMockImplementation()!;
    let loseResponse = true;
    vi.mocked(apiRequest).mockImplementation(async request => {
      const result = await baseMock(request);
      if (request.method === "PUT" && loseResponse) { loseResponse = false; throw new Error("response_lost"); }
      return result;
    });
    fireEvent.click(screen.getByText("移动A"));
    await act(async () => { await expect(live.prepare!()).rejects.toThrow("保存未确认"); });
    expect(vi.mocked(apiRequest).mock.calls.filter(([request]) => request.method === "PUT")).toHaveLength(1);
    let recovered: unknown;
    await act(async () => { recovered = await live.prepare!(); });
    expect(recovered).toMatchObject({version: 2, nodes:[{node_id:"a", x:100}, {node_id:"b", x:300}]});
    expect(vi.mocked(apiRequest).mock.calls.filter(([request]) => request.method === "PUT")).toHaveLength(1);
  });
});


it("loads persisted history on reopen and undoes only that delta", async () => {
  const original = vi.mocked(apiRequest).getMockImplementation()!;
  vi.mocked(apiRequest).mockImplementation(async request => {
    if (request.url?.endsWith("/revisions")) return {revisions: [{revision_id: "persisted", version: 1, source: "agent", activity: {
      ids: ["a"], added: 0, modified: 1, removed: 0, removedLabels: []}}]} as never;
    if (request.url?.endsWith("/persisted/edit")) return {edit: {
      before: {...sheet, nodes: [{...sheet.nodes[0], x: -100}]},
      after: {...sheet, nodes: [sheet.nodes[0]]},
    }} as never;
    return original(request);
  });
  setup();
  await screen.findByText("撤销协作1 displayed");
  fireEvent.click(screen.getByText("移动B"));
  fireEvent.click(screen.getByText("撤销协作1 displayed"));
  await waitFor(() => expect(snapshot().nodes.map(node => node.x)).toEqual([-100, 500]));
});
