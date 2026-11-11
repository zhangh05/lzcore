/**
 * 子 Agent 观察（agent.manage 工具结果）→ 按子任务分组。
 * 迁自 frontend-legacy/src/utils/subagentTracking.ts，语义保持一致：
 * - 工具信封 ok=true 只说明「这次读取成功」，从不代表子任务完成；完成看 task_status。
 * - 同一子任务的多次观察按 observation_revision 取最新；旧 revision 迟到不覆盖新状态。
 * - content_complete=false 或执行结果未知 → 「待核对」，不显示为完成。
 */
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

export interface SubagentCall { call_id?: string; tool_id: string; ok?: boolean; status?: string; summary?: string; duration_ms?: number; result?: Obj }

export interface SubagentObservation {
  id: string;
  status: string;
  revision: number;
  profile: string;
  instruction: string;
  startedAt: string;
  finishedAt: string;
  progress: Obj;
  output: Obj;
  call: SubagentCall;
}
export interface SubagentGroup { id: string; latest: SubagentObservation; observations: SubagentObservation[] }

export function subagentObservations(call: SubagentCall): SubagentObservation[] {
  if (call.tool_id !== "agent.manage") return [];
  const result = obj(call.result);
  const outputs = Array.isArray(result.observations) ? result.observations.map((item) => obj(obj(item).result)) : [result];
  return outputs.flatMap((output) => {
    const tracking = obj(output.tracking);
    const id = String(output.subtask_id || (tracking.domain === "subagent" ? tracking.task_id : "") || "");
    if (!id) return [];
    return [{
      id,
      status: String(output.task_status || tracking.status || "unknown"),
      revision: Number(output.observation_revision || tracking.observation_token || 0),
      profile: String(output.profile_id || ""),
      instruction: String(output.instruction || output.goal || ""),
      startedAt: String(output.started_at || output.created_at || ""),
      finishedAt: String(output.finished_at || ""),
      progress: obj(output.progress || tracking.progress),
      output,
      call,
    }];
  });
}

/** 拆分：子任务分组 + 其余普通工具调用（保持原顺序）。 */
export function partitionSubagentCalls<C extends SubagentCall>(calls: C[]): { ordinary: C[]; tasks: SubagentGroup[] } {
  const groups = new Map<string, SubagentGroup>();
  const ordinary: C[] = [];
  for (const call of calls) {
    const observations = subagentObservations(call);
    if (!observations.length) { ordinary.push(call); continue; }
    for (const o of observations) {
      const g = groups.get(o.id);
      if (!g) { groups.set(o.id, { id: o.id, latest: o, observations: [o] }); continue; }
      g.observations.push(o);
      if (o.revision >= g.latest.revision) g.latest = o;
    }
  }
  return { ordinary, tasks: [...groups.values()] };
}

function executionUnknown(o: SubagentObservation): boolean {
  return ["execution_unknown", "publication_unknown"].includes(String(o.progress.state || ""))
    || obj(o.output.observations).execution_outcome === "unknown";
}

export function subagentStatusLabel(o: SubagentObservation): string {
  if (o.output.content_complete === false) return "子任务已结束，结果待核对";
  if (executionUnknown(o)) return "执行结果待核对";
  return ({ created: "待启动", running: "运行中", succeeded: "子任务已完成", failed: "子任务失败", cancelled: "已取消", canceled: "已取消" } as Record<string, string>)[o.status] || "状态未知";
}

export type SubagentState = "running" | "done" | "failed" | "unknown";
export function subagentState(o: SubagentObservation): SubagentState {
  if (o.output.content_complete === false || executionUnknown(o)) return "unknown";
  if (["created", "running"].includes(o.status)) return "running";
  if (o.status === "succeeded") return "done";
  if (["failed", "cancelled", "canceled"].includes(o.status)) return "failed";
  return "unknown";
}

export function subagentRoleLabel(profile: string): string {
  return ({ research_agent: "资料研究", file_agent: "文件处理", data_agent: "数据分析", coding_agent: "代码实现", frontend_agent: "界面实现", qa_agent: "独立验证" } as Record<string, string>)[profile] || "子 Agent";
}

export const SUBAGENT_ACTIVITY: Record<string, string> = { model_started: "等待模型响应", model_completed: "模型已响应", execution_started: "正在执行工具", tool_result: "已取得工具结果" };
export const SUBAGENT_CHECKS: Record<string, string> = { pending: "待验证", passed: "通过", failed: "失败", unknown: "结果待核对" };
