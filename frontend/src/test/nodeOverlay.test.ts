import { describe, expect, it } from "vitest";
import { overlayBorderStatus, overlayCanvasLine, overlayCaption, type NodeOverlay } from "../../../extensions/network_operations/frontend/components/nodeOverlay";

const bound: NodeOverlay = {
  node_id: "pe1",
  device_id: "device_1",
  device_state: "bound",
  device: { name: "PE1" },
  connection: { status: "connected", last_tested_at: "2026-09-23T01:00:00Z" },
  observation: { observed_at: "2026-09-23T02:00:00Z", completeness: "partial" },
};

describe("node overlay", () => {
  it("does not paint a successful test as current health", () => {
    expect(overlayBorderStatus(bound)).toBe("unknown");
    expect(overlayBorderStatus({ ...bound, connection: { status: "failed", last_tested_at: "t" } })).toBe("error");
    expect(overlayBorderStatus({ ...bound, device_state: "missing", device: null })).toBe("error");
    expect(overlayBorderStatus(undefined)).toBe("unknown");
    expect(overlayCanvasLine(bound)).toContain("观测于");
    expect(overlayCanvasLine(bound)).not.toContain("正常");
    expect(overlayCaption(bound)).toContain("部分");
    expect(overlayCaption(bound)).not.toContain("complete");
    expect(overlayCaption(bound)).not.toMatch(/T\d{2}:/);
    expect(overlayCaption({ ...bound, device_state: "missing", device: null })).toContain("设备已不存在");
  });
});
