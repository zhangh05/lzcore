import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  buildTopologyRequest,
  buildTopologySelection,
  TopologyAgentPanel,
} from "../../../extensions/network_operations/frontend/components/TopologyAgentPanel";
import { ConfirmHost } from "../components/ConfirmDialog";

vi.mock("../api", () => ({
  sessionsApi: {
    messages: vi.fn().mockResolvedValue({ messages: [] }),
    create: vi.fn().mockResolvedValue({ session: { session_id: "s-mock-123" } }),
    get: vi.fn().mockResolvedValue({ session: { session_id: "s-mock-123", status: "active" } }),
    list: vi.fn().mockResolvedValue({ sessions: [] }),
    rename: vi.fn().mockResolvedValue({ session: { session_id: "s-mock-123" } }),
  },
  jobsApi: {
    list: vi.fn().mockResolvedValue({ jobs: [] }),
    cancel: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

const mockSend = vi.fn();
const mockActiveTurnState = {
  job: null as any,
  loaded: true,
  refresh: vi.fn(),
};

vi.mock("../hooks/useChatStream", () => ({
  useChatStream: () => ({
    send: mockSend,
    stop: vi.fn(),
    sending: false,
  }),
}));

vi.mock("../hooks/useActiveTurn", () => ({
  useActiveTurn: () => mockActiveTurnState,
}));

const mockTopology = {
  topology_id: "topo_test_123",
  name: "测试图纸",
  version: 3,
  nodes: [{ node_id: "n1", display_name: "SW1", device_type: "switch", x: 100, y: 100 }],
  links: [],
  groups: [],
  canvas_items: [],
  created_at: "2026-09-18T00:00:00Z",
  updated_at: "2026-09-18T00:00:00Z",
};

const mockSelection = {
  node_ids: [],
  link_ids: [],
  canvas_item_ids: [],
  group_ids: [],
  label: "整张图纸",
};

describe("TopologyAgentPanel and buildTopologyRequest", () => {
  beforeEach(() => {
    localStorage.clear();
    mockSend.mockClear();
    mockActiveTurnState.loaded = true;
    mockActiveTurnState.job = null;
  });

  it("waits for saved drawing and sends its version with the captured selection", async () => {
    let resolve!: (value: typeof mockTopology) => void;
    const prepareDrawing = vi.fn(() => new Promise<typeof mockTopology>(done => { resolve = done; }));
    render(<TopologyAgentPanel workspaceId="default" topology={mockTopology as never}
      selection={{...mockSelection, node_ids:["n1"]}} onCompleted={() => {}} prepareDrawing={prepareDrawing as never} />);
    fireEvent.change(screen.getByLabelText("拓扑协作指令"), {target:{value:"移动这个设备"}});
    fireEvent.submit(screen.getByLabelText("拓扑协作指令").closest("form")!);
    expect(mockSend).not.toHaveBeenCalled();
    expect(screen.getByText("正在确认图纸版本…")).toBeInTheDocument();
    resolve({...mockTopology, version: 4});
    await vi.waitFor(() => expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      text:"移动这个设备", turnMetadata:{workbench_selection:expect.objectContaining({drawing_version:4, canvas_selection:expect.objectContaining({node_ids:["n1"]})})},
    })));
  });

  it("retains the instruction and does not send if baseline saving fails", async () => {
    render(<TopologyAgentPanel workspaceId="default" topology={mockTopology as never} selection={mockSelection}
      onCompleted={() => {}} prepareDrawing={vi.fn().mockRejectedValue(new Error("图纸保存失败，请重试"))} />);
    const input = screen.getByLabelText("拓扑协作指令");
    fireEvent.change(input, {target:{value:"添加一台设备"}});
    fireEvent.submit(input.closest("form")!);
    await vi.waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("图纸保存失败"));
    expect(mockSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("添加一台设备");
  });

  describe("separate user text and drawing selection", () => {
    it("keeps questions and negated edits as the exact user request", () => {
      expect(buildTopologyRequest(" 只检查画板，不要修改 ")).toBe("只检查画板，不要修改");
      expect(buildTopologyRequest("你什么情况")).toBe("你什么情况");
    });
    it("sends editing scope and selected ids separately", () => {
      expect(buildTopologySelection(mockTopology as never, {...mockSelection, node_ids:["n1"]}, false)).toMatchObject({
        skill_id:"drawing:topo_test_123:ro", allow_edit:false, canvas_selection:{node_ids:["n1"]},
      });
    });
  });

  describe("TopologyAgentPanel component UI and interactions", () => {
    it("renders with allowEdit checked by default and allows toggling to read-only", () => {
      render(
        <TopologyAgentPanel
          workspaceId="default"
          topology={mockTopology as never}
          selection={mockSelection}
          onCompleted={() => {}}
        />
      );

      // Default state: checked
      const checkbox = screen.getByLabelText("允许修改拓扑") as HTMLInputElement;
      expect(checkbox).toBeInTheDocument();
      expect(checkbox.checked).toBe(true);
      expect(screen.getByText("拓扑绘图 Skill")).toBeInTheDocument();
      expect(screen.getByText("可修改当前图纸")).toBeInTheDocument();

      const textarea = screen.getByLabelText("拓扑协作指令") as HTMLTextAreaElement;
      expect(textarea.placeholder).toContain("描述你想画的设备");

      // Toggle to unchecked (read-only)
      fireEvent.click(checkbox);
      expect(checkbox.checked).toBe(false);
      expect(screen.getByText("拓扑只读分析")).toBeInTheDocument();
      expect(screen.getByText("只读模式，不可修改")).toBeInTheDocument();
      expect(textarea.placeholder).toContain("只读模式");

      // Toggle back to checked
      fireEvent.click(checkbox);
      expect(checkbox.checked).toBe(true);
      expect(screen.getByText("拓扑绘图 Skill")).toBeInTheDocument();
      expect(screen.getByText("可修改当前图纸")).toBeInTheDocument();
    });

    it("auto-heals and clears state when backend returns 404 for a deleted session", async () => {
      const { sessionsApi } = await import("../api");
      const { useWorkbenchStore } = await import("../stores/workbench");
      const { scopedLocalStorageKey } = await import("../utils/userScope");
      const storageKey = scopedLocalStorageKey(`drawing_session_v2:default:${mockTopology.topology_id}`);
      localStorage.setItem(storageKey, "s-deleted-404");

      // Populate workbench store with old ghost messages
      useWorkbenchStore.setState({
        bySession: {
          "s-deleted-404": [
            { id: "m1", role: "assistant", text: "任务受阻：模型连续提出重复调用", status: "ready" } as never,
          ],
        },
      });

      // Mock sessionsApi.messages to throw 404 ApiError
      vi.mocked(sessionsApi.messages).mockRejectedValueOnce({
        ok: false,
        code: "not_found",
        status: 404,
        message: "session_not_found",
      });

      render(
        <TopologyAgentPanel
          workspaceId="default"
          topology={mockTopology as never}
          selection={mockSelection}
          onCompleted={() => {}}
        />
      );

      // Wait for auto-healing
      await vi.waitFor(() => {
        // localStorage must be cleaned
        expect(localStorage.getItem(storageKey)).toBeNull();
        // workbenchStore must be cleared of the dead session
        expect(useWorkbenchStore.getState().bySession["s-deleted-404"]?.length || 0).toBe(0);
        // Clean intro state should be shown
        expect(screen.getByText("把想法画出来")).toBeInTheDocument();
        expect(screen.queryByText("任务受阻：模型连续提出重复调用")).not.toBeInTheDocument();
      });
    });

    it("renders '新对话' button when session has messages, and resetting clears session", async () => {
      const { sessionsApi } = await import("../api");
      const { useWorkbenchStore } = await import("../stores/workbench");
      const { scopedLocalStorageKey } = await import("../utils/userScope");
      const storageKey = scopedLocalStorageKey(`drawing_session_v2:default:${mockTopology.topology_id}`);
      localStorage.setItem(storageKey, "s-active-123");

      useWorkbenchStore.setState({
        bySession: {
          "s-active-123": [
            { id: "m1", role: "user", text: "画个交换机", status: "ready" } as never,
          ],
        },
      });

      const nativeConfirm = vi.fn().mockReturnValue(true);
      window.confirm = nativeConfirm;
      const deleteSpy = vi.fn().mockResolvedValue({ ok: true });
      (sessionsApi as unknown as { delete: typeof deleteSpy }).delete = deleteSpy;

      render(
        <>
          <TopologyAgentPanel
            workspaceId="default"
            topology={mockTopology as never}
            selection={mockSelection}
            onCompleted={() => {}}
          />
          <ConfirmHost />
        </>
      );

      // Verify messages exist in store
      expect(useWorkbenchStore.getState().bySession["s-active-123"]?.length).toBe(1);
      const newChatBtn = screen.getByTitle("清空当前图纸对话，开启新会话");
      expect(newChatBtn).toBeInTheDocument();

      fireEvent.click(newChatBtn);
      await screen.findByRole("dialog", { name: "为当前图纸开启新会话？" });
      expect(deleteSpy).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "开启新会话" }));

      await vi.waitFor(() => {
        expect(nativeConfirm).not.toHaveBeenCalled();
        expect(deleteSpy).toHaveBeenCalledWith("s-active-123", "default");
        expect(localStorage.getItem(storageKey)).toBeNull();
        expect(useWorkbenchStore.getState().bySession["s-active-123"]?.length || 0).toBe(0);
        expect(screen.getByText("把想法画出来")).toBeInTheDocument();
      });
    });

    it("cancelling the new-session dialog keeps the session and sends no delete", async () => {
      const { sessionsApi } = await import("../api");
      const { useWorkbenchStore } = await import("../stores/workbench");
      const { scopedLocalStorageKey } = await import("../utils/userScope");
      const storageKey = scopedLocalStorageKey(`drawing_session_v2:default:${mockTopology.topology_id}`);
      localStorage.setItem(storageKey, "s-keep-1");
      useWorkbenchStore.setState({
        bySession: { "s-keep-1": [{ id: "m1", role: "user", text: "画个交换机", status: "ready" } as never] },
      });
      const nativeConfirm = vi.fn().mockReturnValue(true);
      window.confirm = nativeConfirm;
      const deleteSpy = vi.fn().mockResolvedValue({ ok: true });
      (sessionsApi as unknown as { delete: typeof deleteSpy }).delete = deleteSpy;
      render(
        <>
          <TopologyAgentPanel workspaceId="default" topology={mockTopology as never} selection={mockSelection} onCompleted={() => {}} />
          <ConfirmHost />
        </>
      );
      fireEvent.click(screen.getByTitle("清空当前图纸对话，开启新会话"));
      await screen.findByRole("dialog", { name: "为当前图纸开启新会话？" });
      fireEvent.click(screen.getByRole("button", { name: "取消" }));
      await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(nativeConfirm).not.toHaveBeenCalled();
      expect(localStorage.getItem(storageKey)).toBe("s-keep-1");
    });

    it("leaving the graph while the new-session dialog is open aborts it without deleting", async () => {
      const { sessionsApi } = await import("../api");
      const { scopedLocalStorageKey } = await import("../utils/userScope");
      const storageKey = scopedLocalStorageKey(`drawing_session_v2:default:${mockTopology.topology_id}`);
      localStorage.setItem(storageKey, "s-left-1");
      const { useWorkbenchStore } = await import("../stores/workbench");
      useWorkbenchStore.setState({ bySession: { "s-left-1": [{ id: "m1", role: "user", text: "画", status: "ready" } as never] } });
      const deleteSpy = vi.fn().mockResolvedValue({ ok: true });
      (sessionsApi as unknown as { delete: typeof deleteSpy }).delete = deleteSpy;
      const view = render(<TopologyAgentPanel workspaceId="default" topology={mockTopology as never} selection={mockSelection} onCompleted={() => {}} />);
      const host = render(<ConfirmHost />);
      fireEvent.click(screen.getByTitle("清空当前图纸对话，开启新会话"));
      await screen.findByRole("dialog", { name: "为当前图纸开启新会话？" });
      view.unmount();
      await vi.waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(localStorage.getItem(storageKey)).toBe("s-left-1");
      host.unmount();
    });

    it("enables the send button when user types text, even if active turn job loaded is false", async () => {
      mockActiveTurnState.loaded = false;
      const { scopedLocalStorageKey } = await import("../utils/userScope");
      const storageKey = scopedLocalStorageKey(`drawing_session_v2:default:${mockTopology.topology_id}`);
      localStorage.setItem(storageKey, "s-existing-turn");

      render(
        <TopologyAgentPanel
          workspaceId="default"
          topology={mockTopology as never}
          selection={mockSelection}
          onCompleted={() => {}}
        />
      );

      const sendBtn = screen.getByRole("button", { name: /发送/ });
      const textarea = screen.getByLabelText("拓扑协作指令") as HTMLTextAreaElement;

      // Initially empty -> disabled
      expect(sendBtn).toBeDisabled();

      // Type text -> enabled immediately (not blocked by loaded=false)
      fireEvent.change(textarea, { target: { value: "写的是啥" } });
      expect(sendBtn).not.toBeDisabled();

      // Press Enter -> submits via mockSend
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
      await vi.waitFor(() => {
        expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
          text: "写的是啥", turnMetadata: expect.objectContaining({
            workbench_selection: expect.objectContaining({
              skill_id: "drawing:topo_test_123", canvas_selection: mockSelection,
            }),
          }),
        }));
      });

      // Cleanup mock state
      mockActiveTurnState.loaded = true;
    });
  });
});


it("keeps persisted drawing activity collapsed and separate from messages", async () => {
  render(<TopologyAgentPanel workspaceId="default" topology={mockTopology as never} selection={mockSelection}
    onCompleted={() => {}} activities={[{version: 3, revision_id: "revision", source: "collaboration",
      status: "displayed", ids: ["n1"], added: 1, modified: 0, removed: 0, removedLabels: []}]} />);
  const record = screen.getByLabelText("图纸变化");
  expect(record.tagName).toBe("DETAILS");
  expect(record).not.toHaveAttribute("open");
  expect(screen.getByText("图纸变化记录")).toBeInTheDocument();
  expect(document.querySelector(".topology-agent-messages")?.contains(record)).toBe(false);
});
