import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThinkingBlock } from "../pages/AgentWorkbench/components/ThinkingBlock";
import { WorkbenchComposer } from "../pages/AgentWorkbench/components/WorkbenchComposer";

describe("ThinkingBlock interaction semantics", () => {
  it("keeps disclosure and copy as independent buttons", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<ThinkingBlock content="evidence" />);

    const disclosure = screen.getByRole("button", { name: /思考与推理过程/ });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("evidence"));
    expect(screen.getByRole("button", { name: "已复制" })).toBeInTheDocument();
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
  });

  it("reports a rejected clipboard write instead of claiming success", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });

    render(<ThinkingBlock content="evidence" defaultOpen />);
    fireEvent.click(screen.getByRole("button", { name: "复制" }));

    expect(await screen.findByRole("button", { name: "复制失败" })).toBeInTheDocument();
  });
});

describe("WorkbenchComposer send contract", () => {
  const baseProps = {
    currentSessionId: "session-1",
    turnRunning: false,
    input: "",
    onInputChange: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    attachments: [],
    onRemoveAttachment: vi.fn(),
    onPickFile: vi.fn(),
    fileInputRef: createRef<HTMLInputElement>(),
    onFileInputChange: vi.fn(),
    inputRef: createRef<HTMLTextAreaElement>(),
    workbenchSkills: [],
    selectedSkillKey: "",
    onSelectSkillKey: vi.fn(),
    selectedSkill: undefined,
    selectedResourceIds: [],
    onSelectResourceIds: vi.fn(),
    onDragOver: vi.fn(),
    onDrop: vi.fn(),
  };

  it("does not dispatch an empty Enter submission", () => {
    const onSend = vi.fn();
    render(<WorkbenchComposer {...baseProps} onSend={onSend} />);

    fireEvent.keyDown(screen.getByTestId("chat-input"), { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId("btn-send")).toBeDisabled();
  });

  it("dispatches a non-empty Enter submission once", () => {
    const onSend = vi.fn();
    render(<WorkbenchComposer {...baseProps} input="检查设备" onSend={onSend} />);

    fireEvent.keyDown(screen.getByTestId("chat-input"), { key: "Enter" });

    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("renders locked badge and non-interactive resource chips when isSkillLocked is true", () => {
    const topoSkill = {
      extension_id: "network.operations",
      skill_id: "drawing:topo_123",
      name: "拓扑绘图 · 大型企业网络拓扑",
      description: "围绕网络拓扑进行实时读图与绘图修改",
      resources: [{ resource_id: "topo_123", name: "大型企业网络拓扑", description: "拓扑图纸", kind: "drawing" }],
      default_resource_ids: ["topo_123"],
      selection_mode: "single" as const,
    };

    render(
      <WorkbenchComposer
        {...baseProps}
        isSkillLocked={true}
        selectedSkill={topoSkill}
        selectedSkillKey="network.operations:drawing:topo_123"
        selectedResourceIds={["topo_123"]}
      />
    );

    // Dropdown select should NOT be present
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    // Locked badge must be visible with lock label
    const lockedBadge = screen.getByTestId("workbench-skill-locked-badge");
    expect(lockedBadge).toBeInTheDocument();
    expect(lockedBadge).toHaveTextContent("已绑定：拓扑绘图 · 大型企业网络拓扑");

    // Resource chip should be a non-button span with is-locked class
    const chip = screen.getByText("大型企业网络拓扑");
    expect(chip.tagName.toLowerCase()).toBe("span");
    expect(chip).toHaveClass("wb-skill-device-chip", "is-locked");
  });

  it("renders normal dropdown and interactive resource buttons when isSkillLocked is false", () => {
    const deviceSkill = {
      extension_id: "network.operations",
      skill_id: "device_control",
      name: "网络设备控制",
      description: "设备控制",
      resources: [{ resource_id: "dev_1", name: "核心交换机1", description: "设备1", kind: "device" }],
      default_resource_ids: ["dev_1"],
      selection_mode: "single" as const,
    };

    render(
      <WorkbenchComposer
        {...baseProps}
        isSkillLocked={false}
        workbenchSkills={[deviceSkill]}
        selectedSkill={deviceSkill}
        selectedSkillKey="network.operations:device_control"
        selectedResourceIds={["dev_1"]}
      />
    );

    // Dropdown select should be present
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.queryByTestId("workbench-skill-locked-badge")).not.toBeInTheDocument();

    // Resource button should be clickable button
    const btn = screen.getByRole("button", { name: "核心交换机1" });
    expect(btn).toBeInTheDocument();
  });
});
