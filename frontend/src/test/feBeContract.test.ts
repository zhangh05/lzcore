import { describe, expect, it } from "vitest";
import { deriveGoalState, goalLabel } from "../contracts/outcomeState";
import { drawingSessionBinding } from "../extension-modules/network-operations/sessionBinding";
import { admitAttachments, type PendingAttachment } from "../pages/workbench/model";
import { toDraft, workflowBody } from "../pages/workflows/WorkflowForm";

// 对应 docs/audit/fe-be-coupling.md 中前端一侧的契约修复。
describe("前后端契约", () => {
  it("F02 编辑工作流原样带回 when / version / template_id", () => {
    const body = workflowBody(toDraft({ workflow_id: "wf1", name: "n", version: 7, template_id: "tpl", nodes: [{ node_id: "a", tool_id: "t", when: false }] }), "wf1");
    expect(body).toMatchObject({ version: 7, template_id: "tpl" });
    expect((body.nodes as Array<Record<string, unknown>>)[0].when).toBe(false);
  });

  it("F18 图片最多 4 张（后端 chat_attachments 上限）", () => {
    const img = (i: number): PendingAttachment => ({ id: `i${i}`, name: `p${i}.png`, size: 10, kind: "image", source: "upload" });
    const r = admitAttachments([], [1, 2, 3, 4, 5].map(img));
    expect(r.accepted).toHaveLength(4);
    expect(r.rejected[0].reason).toContain("4");
  });

  it("F19 历史绘图会话没写 allow_edit 时与后端一致：可编辑；显式 false 才只读", () => {
    expect(drawingSessionBinding({ topology_id: "topo_x" })?.allow_edit).toBe(true);
    expect(drawingSessionBinding({ topology_id: "topo_x", allow_edit: false })?.allow_edit).toBe(false);
  });

  it("F22 waiting_external_input 是服务端上报的结论，不是「未上报」", () => {
    const s = deriveGoalState({ metadata: { execution_outcome: "waiting_external_input" } });
    expect(s).toBe("waiting_external_input");
    expect(goalLabel(s)).not.toContain("完成");
  });
});

import { inspectionRetryGate } from "../extension-modules/network-operations/api";
import { accepted } from "../extension-modules/network-operations/shared";

describe("网络运维回执与重试范围", () => {
  it("F14 200 + ok:false 不算受理", () => {
    expect(accepted({ kind: "http", status: 200, body: { ok: false } })).toBe(false);
    expect(accepted({ kind: "http", status: 200, body: { ok: true } })).toBe(true);
    expect(accepted({ kind: "http", status: 409, body: {} })).toBe(false);
  });

  it("F17 证据落盘失败：允许对全部原目标重新采集", () => {
    const g = inspectionRetryGate({ task_id: "t", status: "failed", error: "inspection_evidence_persist_failed", connection_ids: ["c1", "c2"] },
      [{ connection_id: "c1", status: "succeeded" }, { connection_id: "c2", status: "succeeded" }]);
    expect(g).toMatchObject({ allowed: true, targets: ["c1", "c2"], scope: "evidence_recollection" });
  });
});
