/** Public selection proposal. The server resolves scope and permissions. */
export interface WorkbenchSelection {
  extension_id: string;
  skill_id: string;
  skill_name: string;
  resource_ids: string[];
  allow_edit: boolean;
}
export function readWorkbenchSelection(raw: unknown): WorkbenchSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.extension_id !== "string" || !value.extension_id || typeof value.skill_id !== "string" || !value.skill_id || !Array.isArray(value.resource_ids) || !value.resource_ids.every((id) => typeof id === "string")) return null;
  return { extension_id: value.extension_id, skill_id: value.skill_id, skill_name: typeof value.skill_name === "string" ? value.skill_name : value.skill_id, resource_ids: value.resource_ids as string[], allow_edit: value.allow_edit === true };
}
