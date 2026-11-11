import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeBackend } from "./fakeBackend";
import { NetworkEvidence, networkEvidence } from "../extension-modules/network-operations/NetworkEvidence";
import { evidenceRenderers } from "../extension-modules/registry";

const DEVICE = "network.operations.device.manage";

describe("网络领域证据", () => {
  it("信封 ok 但读取不完整 → 证据不完整，并保留原始回显", () => {
    render(<NetworkEvidence ws="w" toolId={DEVICE} result={{
      ok: true, status: "partial", connection_ok: true, read_ok: false, target: { connection_id: "conn-a", name: "核心交换机" },
      command_results: [{ command: "display version", dispatch_status: "sent", complete: false, output: "完整保留的部分回显", error_code: "prompt_timeout" }],
    }} />);
    expect(screen.getByTestId("network-evidence")).toHaveAttribute("data-outcome", "partial");
    expect(screen.getByTestId("network-evidence-label")).toHaveTextContent("证据不完整");
    expect(screen.getByText("display version")).toBeInTheDocument();
    expect(screen.getByText(/需核对回显/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("原始回显"));
    expect(screen.getByText("完整保留的部分回显")).toBeVisible();
  });

  it("状态判定：不可达 / 写入未知 / 配置提醒业务核验 / 巡检 list 交给普通卡", () => {
    expect(networkEvidence(DEVICE, { ok: false, connection_ok: false })?.label).toBe("设备不可达");
    expect(networkEvidence(DEVICE, { ok: true, execution_may_continue: true })?.label).toBe("写入结果未知");
    expect(networkEvidence(DEVICE, { ok: true, status: "ok", executed_action: "configure" })?.label).toBe("命令已处理，待业务核验");
    expect(networkEvidence(DEVICE, { ok: true })?.label).toBe("读取完成");
    expect(networkEvidence("network.operations.inspection", { ok: true, inspections: [] })).toBeNull();
    expect(networkEvidence("network.operations.inspection", { ok: true, task: { task_id: "t1", status: "running" } })?.label).toBe("巡检进行中");
    expect(networkEvidence("web.manage", { ok: true })).toBeNull();
  });

  it("只在网络扩展可用时接管，并能读取完整证据原件", async () => {
    expect(evidenceRenderers(new Set())).toHaveLength(0);
    const [r] = evidenceRenderers(new Set(["network.operations"]));
    const call = { tool_id: DEVICE, call_id: "c1", result: { ok: true, status: "ok", presentation: { artifact_id: "art_1" } } };
    expect(r.match(call)).toBe(`${DEVICE}#c1`);
    fakeBackend((_m, p) => (p.startsWith("/api/workspaces/w/artifacts/art_1/content") ? { status: 200, body: { content: "FULL EVIDENCE" } } : undefined));
    render(<>{r.render("w", r.match(call)!, call)}</>);
    fireEvent.click(screen.getByText("读取完整证据"));
    expect(await screen.findByText("FULL EVIDENCE")).toBeInTheDocument();
  });
});
