import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TopologyAgentPanel } from "../components/TopologyAgentPanel";
import type { Topology } from "../components/topologyDocument";
import type { CanvasSelection } from "../components/canvasSelection";

const h = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  handlers: null as null | { onDone: () => void },
  existing: null as null | string,
  jobs: [] as Array<Record<string, unknown>>,
  resumed: [] as Array<{ clientRequestId: string; sessionId: string }>,
  onBroadcast: null as null | ((name: string, data: Record<string, unknown>) => void),
  emitted: [] as Array<Record<string, unknown>>,
  order: [] as string[],
}));

vi.mock("../../../../api/client", () => ({
  api: { get: vi.fn(async (path: string) => ({ kind: "http", status: 200, body: path === "/api/jobs" ? { jobs: h.jobs } : { messages: h.messages } })), post: vi.fn() },
  bodyOf: (o: { body?: unknown }) => o.body ?? null,
  describeFailure: () => "failed",
  enc: (s: string) => s,
  stableId: (p: string) => `${p}_1`,
}));
vi.mock("../../../../api/localAuth", () => ({ clearLocalAuth: vi.fn(), ensureLocalBrowserToken: vi.fn(async () => { h.order.push("token"); }) }));
vi.mock("../../../../realtime/turnTransport", () => ({
  wsUrl: () => "ws://test",
  turnErrorText: (f: Record<string, unknown>) => `本轮报错：${String(f.message ?? "")}`,
  TurnTransport: class {
    constructor(o: { onBroadcast?: (name: string, data: Record<string, unknown>) => void }) { h.onBroadcast = o.onBroadcast ?? null; }
    subscribeBroadcasts() {}
    sendMessage(o: { handlers: { onDone: () => void } }) { h.handlers = o.handlers; }
    resumeTurn(o: { clientRequestId: string; sessionId: string; handlers: { onDone: () => void } }) { h.order.push("resume"); h.resumed.push(o); h.handlers = o.handlers; }
    close() {}
  },
}));
vi.mock("../components/TopologySessionResolver", () => ({
  resolveTopologySession: vi.fn(async (_ws: string, _t: unknown, create: boolean) => (create ? "s1" : h.existing)),
}));
vi.mock("../platform/realtime/turnTransport", () => ({ emitTopologyUpdated: (d: Record<string, unknown>) => h.emitted.push(d) }));
vi.mock("../platform/router", () => ({ useNavigate: () => vi.fn() }));

const topo = { topology_id: "t1", name: "图", version: 1, nodes: [], links: [], groups: [], canvas_items: [] } as unknown as Topology;
const selection = { label: "整张图纸", node_ids: [], link_ids: [], canvas_item_ids: [], group_ids: [] } as unknown as CanvasSelection;

async function sendFirstTurn(onCompleted: () => Promise<boolean>) {
  render(<TopologyAgentPanel workspaceId="w" topology={topo} selection={selection} onCompleted={onCompleted} />);
  fireEvent.change(screen.getByTestId("agent-input"), { target: { value: "设计一个数据中心" } });
  fireEvent.click(screen.getByTestId("agent-send"));
  await waitFor(() => expect(h.handlers).not.toBeNull());
}

beforeEach(() => { h.messages = []; h.handlers = null; h.existing = null; h.jobs = []; h.resumed = []; h.emitted = []; h.order = []; });

describe("TopologyAgentPanel", () => {
  it("keeps the user's message visible when the first send creates the session", async () => {
    await sendFirstTurn(async () => true);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByTestId("agent-msg-user").textContent).toContain("设计一个数据中心");
  });

  it("does not claim 'no new version' while the drawing readback is still running", async () => {
    let finish: (ok: boolean) => void = () => {};
    await sendFirstTurn(() => new Promise<boolean>((r) => { finish = r; }));
    h.messages = [{ role: "user", content: "设计一个数据中心" }, { role: "assistant", content: "已完成" }];
    await act(async () => { h.handlers!.onDone(); });
    await waitFor(() => expect(screen.getByTestId("agent-version-readback").textContent).toContain("正在回读"));
    await act(async () => { finish(true); });
    expect(screen.getByTestId("agent-version-readback").textContent).toContain("本轮未产生新版本");
  });

  it("reports a failed readback instead of 'no new version', and offers a retry", async () => {
    const onCompleted = vi.fn(async () => false);
    await sendFirstTurn(onCompleted);
    await act(async () => { h.handlers!.onDone(); });
    await waitFor(() => expect(screen.getByTestId("agent-version-readback").textContent).toContain("回读失败"));
    onCompleted.mockResolvedValueOnce(true);
    await act(async () => { fireEvent.click(screen.getByText("重新回读图纸")); });
    expect(onCompleted).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("agent-version-readback").textContent).toContain("本轮未产生新版本");
  });
  it("re-attaches to a turn still running on the server after the panel remounts", async () => {
    h.existing = "s1";
    h.messages = [{ role: "user", content: "设计一个数据中心" }];
    h.jobs = [
      { job_id: "j0", metadata: { active_turn: { session_id: "other", client_request_id: "cr_x", status: "running" } } },
      { job_id: "j1", metadata: { active_turn: { session_id: "s1", client_request_id: "cr_live", status: "running" } } },
    ];
    render(<TopologyAgentPanel workspaceId="w" topology={topo} selection={selection} onCompleted={async () => true} />);
    await waitFor(() => expect(h.resumed.map((r) => r.clientRequestId)).toEqual(["cr_live"]));
    expect(h.order.indexOf("token")).toBeGreaterThanOrEqual(0);
    expect(h.order.indexOf("token")).toBeLessThan(h.order.indexOf("resume")); // 服务端在 resume 上校验本机令牌
    expect(screen.getByTestId("agent-run-state").textContent).toContain("上一轮仍在执行");
    h.messages = [...h.messages, { role: "assistant", content: "画好了" }];
    await act(async () => { h.handlers!.onDone(); });
    await waitFor(() => expect(screen.getByTestId("agent-msg-assistant").textContent).toContain("画好了"));
    expect(screen.getByTestId("agent-run-state").textContent).toBe("就绪");
  });

  it("forwards topology_updated broadcasts to the canvas", () => {
    render(<TopologyAgentPanel workspaceId="w" topology={topo} selection={selection} onCompleted={async () => true} />);
    h.onBroadcast!("topology_updated", { workspace_id: "w", topology_id: "t1", version: 5 });
    h.onBroadcast!("something_else", {});
    expect(h.emitted).toEqual([{ workspace_id: "w", topology_id: "t1", version: 5 }]);
  });
});
