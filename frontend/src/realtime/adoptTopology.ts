export type TopologySaveStatus = "saved" | "saving" | "unsaved" | "conflict";

export type RemoteTopologyRef = {
  topology_id?: string;
  version?: number;
};

export function shouldAdoptRemoteTopology(input: {
  requestedWorkspaceId: string;
  requestedTopologyId: string;
  currentWorkspaceId: string;
  currentTopologyId: string | null;
  saveStatus: TopologySaveStatus;
  currentVersion: number | null;
  remote: RemoteTopologyRef | null;
}): boolean {
  const remote = input.remote;
  if (!remote) return false;
  if (input.requestedWorkspaceId !== input.currentWorkspaceId) return false;
  if (!input.currentTopologyId || input.requestedTopologyId !== input.currentTopologyId) return false;
  if (remote.topology_id !== input.currentTopologyId) return false;
  if (input.saveStatus !== "saved") return false;
  const remoteVersion = typeof remote.version === "number" ? remote.version : Number(remote.version);
  if (!Number.isFinite(remoteVersion) || input.currentVersion == null) return false;
  return remoteVersion > input.currentVersion;
}
