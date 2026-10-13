import type { ToolCallResult } from "../types";

type Call = Pick<ToolCallResult,"tool_id"> & Partial<Omit<ToolCallResult,"tool_id">> & {status?: string; tool_name?: string};
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
export interface SubagentObservation {
  id: string;
  status: string;
  revision: number;
  profile: string;
  instruction: string;
  startedAt: string;
  finishedAt: string;
  progress: RecordValue;
  output: RecordValue;
  call: Call;
}
export interface SubagentGroup { id: string; latest: SubagentObservation; observations: SubagentObservation[] }

export function subagentObservations(call: Call): SubagentObservation[] {
  if (call.tool_id !== "agent.manage") return [];
  const result = record(call.result);
  const outputs = Array.isArray(result.observations)
    ? result.observations.map(item => record(record(item).result)) : [result];
  return outputs.flatMap(output => {
    const tracking = record(output.tracking);
    const id = String(output.subtask_id || (tracking.domain === "subagent" ? tracking.task_id : "") || "");
    if (!id) return [];
    // Tool-envelope status='ok' never proves child completion.
    const status = String(output.task_status || tracking.status || "unknown");
    return [{ id, status, revision: Number(output.observation_revision || tracking.observation_token || 0),
      profile: String(output.profile_id || ""), instruction: String(output.instruction || ""),
      startedAt: String(output.started_at || output.created_at || ""), finishedAt: String(output.finished_at || ""),
      progress: record(output.progress || tracking.progress), output, call }];
  });
}

export function partitionSubagentCalls(calls: Call[]) {
  const groups = new Map<string, SubagentGroup>();
  const ordinary: Call[] = [];
  for (const call of calls) {
    const observations = subagentObservations(call);
    if (!observations.length) { ordinary.push(call); continue; }
    for (const observation of observations) {
      const group = groups.get(observation.id);
      if (!group) { groups.set(observation.id, { id: observation.id, latest: observation, observations: [observation] }); continue; }
      group.observations.push(observation);
      if (observation.revision >= group.latest.revision) group.latest = observation;
    }
  }
  return { ordinary, tasks: [...groups.values()] };
}

export function subagentStatusLabel(observation: SubagentObservation): string {
  if (observation.output.content_complete === false) return "子任务已结束，结果待核对";
  const unknown = ["execution_unknown", "publication_unknown"].includes(String(observation.progress.state || ""))
    || record(observation.output.observations).execution_outcome === "unknown";
  if (unknown) return "执行结果待核对";
  return ({created: "待启动", running: "运行中", succeeded: "子任务已完成", failed: "子任务失败", cancelled: "已取消", canceled: "已取消"} as Record<string,string>)[observation.status] || "状态未知";
}

export function subagentEvidenceState(observation: SubagentObservation): "running" | "done" | "failed" | "unknown" {
  if (observation.output.content_complete === false || subagentStatusLabel(observation) === "执行结果待核对") return "unknown";
  if (["created","running"].includes(observation.status)) return "running";
  if (observation.status === "succeeded") return "done";
  if (["failed","cancelled","canceled"].includes(observation.status)) return "failed";
  return "unknown";
}

export function subagentRoleLabel(profile: string): string {
  return ({research_agent:"资料研究",file_agent:"文件处理",data_agent:"数据分析",coding_agent:"代码实现",frontend_agent:"界面实现",qa_agent:"独立验证"} as Record<string,string>)[profile] || "子 Agent";
}
