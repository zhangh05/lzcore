import { readWorkbenchSelection, type WorkbenchSelection } from "../../contracts/workbench";

/** Interpret the existing extension-owned session metadata; never infer from a title. */
export function drawingSessionBinding(metadata: Record<string, unknown>): WorkbenchSelection | null {
  const saved = readWorkbenchSelection(metadata.workbench_selection);
  const topologyId = typeof metadata.topology_id === "string" ? metadata.topology_id : "";
  if (saved?.extension_id === "network.operations" && saved.skill_id.startsWith("drawing:")) return saved;
  if (!topologyId) return null;
  return { extension_id: "network.operations", skill_id: `drawing:${topologyId}`, skill_name: typeof metadata.topology_name === "string" ? metadata.topology_name : "绘图", resource_ids: [topologyId], allow_edit: metadata.allow_edit === true };
}
