import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  buildTopologyRequest,
  TopologyAgentPanel,
} from "../../../extensions/network_operations/frontend/components/TopologyAgentPanel";

vi.mock("../api", () => ({
  sessionsApi: {
    messages: vi.fn().mockResolvedValue({ messages: [] }),
    create: vi.fn().mockResolvedValue({ session: { session_id: "s-mock-123" } }),
  },
  jobsApi: {
    list: vi.fn().mockResolvedValue({ jobs: [] }),
    cancel: vi.fn().mockResolvedValue({ ok: true }),
  },
}));

vi.mock("../hooks/useChatStream", () => ({
  useChatStream: () => ({
    send: vi.fn(),
    stop: vi.fn(),
    sending: false,
  }),
}));

vi.mock("../hooks/useActiveTurn", () => ({
  useActiveTurn: () => ({
    job: null,
    loaded: true,
    refresh: vi.fn(),
  }),
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
  });

  describe("buildTopologyRequest prompt generation", () => {
    it("generates editing instructions when allowEdit is true", () => {
      const result = buildTopologyRequest(mockTopology as never, mockSelection, "添加一台路由器", true);
      expect(result).toContain("添加一台路由器");
      expect(result).toContain("已明确授权绘图。请先读取当前图纸，再按要求绘图。");
      expect(result).not.toContain("只读咨询模式");
      expect(result).toContain('"topology_id":"topo_test_123"');
    });

    it("generates strict read-only instructions when allowEdit is false", () => {
      const result = buildTopologyRequest(mockTopology as never, mockSelection, "分析网络结构", false);
      expect(result).toContain("分析网络结构");
      expect(result).toContain("【当前为只读咨询模式，未授权修改图纸】");
      expect(result).toContain("严禁调用 patch 或修改任何图纸内容");
      expect(result).not.toContain("已明确授权绘图");
      expect(result).toContain('"topology_id":"topo_test_123"');
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
  });
});
