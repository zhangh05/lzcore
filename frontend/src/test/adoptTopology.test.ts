import { describe, expect, it } from "vitest";
import { shouldAdoptRemoteTopology } from "../realtime/adoptTopology";

const base = {
  requestedWorkspaceId: "ws-1",
  requestedTopologyId: "topo-1",
  currentWorkspaceId: "ws-1",
  currentTopologyId: "topo-1",
  saveStatus: "saved" as const,
  currentVersion: 3,
  remote: { topology_id: "topo-1", version: 4 },
};

describe("remote topology adoption", () => {
  it("adopts only a newer saved drawing for the same workspace and canvas", () => {
    expect(shouldAdoptRemoteTopology(base)).toBe(true);
  });

  it("rejects a stale response, another drawing, and unsaved local edits", () => {
    expect(shouldAdoptRemoteTopology({ ...base, remote: { topology_id: "topo-1", version: 3 } })).toBe(false);
    expect(shouldAdoptRemoteTopology({ ...base, remote: { topology_id: "topo-1", version: 2 } })).toBe(false);
    expect(shouldAdoptRemoteTopology({ ...base, currentTopologyId: "topo-2" })).toBe(false);
    expect(shouldAdoptRemoteTopology({ ...base, requestedWorkspaceId: "ws-2" })).toBe(false);
    expect(shouldAdoptRemoteTopology({ ...base, saveStatus: "unsaved" })).toBe(false);
    expect(shouldAdoptRemoteTopology({ ...base, saveStatus: "saving" })).toBe(false);
  });
});
