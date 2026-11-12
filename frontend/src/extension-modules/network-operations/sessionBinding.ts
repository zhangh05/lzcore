import { readWorkbenchSelection, type WorkbenchSelection } from "../../contracts/workbench";

/** Interpret the existing extension-owned session metadata; never infer from a title. */
export function drawingSessionBinding(metadata: Record<string, unknown>): WorkbenchSelection | null {
  const saved = readWorkbenchSelection(metadata.workbench_selection);
  const topologyId = typeof metadata.topology_id === "string" ? metadata.topology_id : "";
  if (saved?.extension_id === "network.operations" && saved.skill_id.startsWith("drawing:")) return saved;
  if (!topologyId) return null;
  return { extension_id: "network.operations", skill_id: `drawing:${topologyId}`, skill_name: typeof metadata.topology_name === "string" ? metadata.topology_name : "绘图", resource_ids: [topologyId], // 与 backend/core/agent_contract.py 一致：历史会话未写 allow_edit 时视为可编辑，显式 false 才只读。
    allow_edit: metadata.allow_edit !== false };
}
