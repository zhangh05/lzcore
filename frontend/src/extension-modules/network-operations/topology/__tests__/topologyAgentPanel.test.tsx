import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TopologyAgentPanel } from "../components/TopologyAgentPanel";
import type { Topology } from "../components/topologyDocument";
import type { CanvasSelection } from "../components/canvasSelection";

const h = vi.hoisted(() => ({
  messages: [] as Array<Record<string, unknown>>,
  handlers: null as null | { onDone: () => void },
}));

vi.mock("../../../../api/client", () => ({
  api: { get: vi.fn(async () => ({ kind: "http", status: 200, body: { messages: h.messages } })), post: vi.fn() },
  bodyOf: (o: { body?: unknown }) => o.body ?? null,
  describeFailure: () => "failed",
  enc: (s: string) => s,
  stableId: (p: string) => `${p}_1`,
}));
vi.mock("../../../../api/localAuth", () => ({ ensureLocalBrowserToken: vi.fn(async () => undefined) }));
vi.mock("../../../../realtime/turnTransport", () => ({
  wsUrl: () => "ws://test",
  TurnTransport: class {
    sendMessage(o: { handlers: { onDone: () => void } }) { h.handlers = o.handlers; }
    close() {}
  },
}));
vi.mock("../components/TopologySessionResolver", () => ({
  resolveTopologySession: vi.fn(async (_ws: string, _t: unknown, create: boolean) => (create ? "s1" : null)),
}));
vi.mock("../platform/router", () => ({ useNavigate: () => vi.fn() }));

const topo = { topology_id: "t1", name: "图", version: 1, nodes: [], links: [], groups: [], canvas_items: [] } as unknown as Topology;
const selection = { label: "整张图纸", node_ids: [], link_ids: [], canvas_item_ids: [], group_ids: [] } as unknown as CanvasSelection;

async function sendFirstTurn(onCompleted: () => Promise<boolean>) {
  render(<TopologyAgentPanel workspaceId="w" topology={topo} selection={selection} onCompleted={onCompleted} />);
  fireEvent.change(screen.getByTestId("agent-input"), { target: { value: "设计一个数据中心" } });
  fireEvent.click(screen.getByTestId("agent-send"));
  await waitFor(() => expect(h.handlers).not.toBeNull());
}

beforeEach(() => { h.messages = []; h.handlers = null; });

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
});
