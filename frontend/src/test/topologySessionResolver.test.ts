import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTopologySession } from "../../../extensions/network_operations/frontend/components/TopologySessionResolver";
import { sessionsApi } from "../api";
import { scopedLocalStorageKey } from "../utils/userScope";

vi.mock("../api", () => ({
  sessionsApi: {
    get: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    rename: vi.fn().mockResolvedValue({}),
  },
}));

describe("TopologySessionResolver", () => {
  const mockTopology = {
    topology_id: "topo_ent_001",
    name: "大型企业网络拓扑",
  };
  const workspaceId = "default";
  const storageKey = scopedLocalStorageKey(`drawing_session_v2:${workspaceId}:${mockTopology.topology_id}`);
  const skillKey = scopedLocalStorageKey("workbench_skill:sess_existing_123");

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("reuses cached session if active on server", async () => {
    localStorage.setItem(storageKey, "sess_existing_123");
    vi.mocked(sessionsApi.get).mockResolvedValueOnce({
      session: { session_id: "sess_existing_123", status: "active" } as never,
    } as never);

    const resolved = await resolveTopologySession(workspaceId, mockTopology);
    expect(resolved).toBe("sess_existing_123");
    expect(sessionsApi.get).toHaveBeenCalledWith("sess_existing_123", workspaceId);
    expect(sessionsApi.list).not.toHaveBeenCalled();
    expect(sessionsApi.create).not.toHaveBeenCalled();

    // Verifies skill was synced to localStorage
    const savedSkill = JSON.parse(localStorage.getItem(skillKey) || "{}");
    expect(savedSkill.skill_key).toBe("network.operations:drawing:topo_ent_001");
    expect(savedSkill.resource_ids).toEqual(["topo_ent_001"]);
  });

  it("finds session on server by metadata.topology_id when localStorage is empty", async () => {
    vi.mocked(sessionsApi.list).mockResolvedValueOnce({
      sessions: [
        {
          session_id: "sess_found_server",
          title: "拓扑 · 大型企业网络拓扑",
          metadata: { topology_id: "topo_ent_001" },
        } as never,
      ],
    } as never);

    const resolved = await resolveTopologySession(workspaceId, mockTopology);
    expect(resolved).toBe("sess_found_server");
    expect(localStorage.getItem(storageKey)).toBe("sess_found_server");
    expect(sessionsApi.create).not.toHaveBeenCalled();
  });

  it("renames stale title if existing session title differs", async () => {
    vi.mocked(sessionsApi.list).mockResolvedValueOnce({
      sessions: [
        {
          session_id: "sess_stale_title",
          title: "拓扑 · 2",
          metadata: { topology_id: "topo_ent_001" },
        } as never,
      ],
    } as never);

    const resolved = await resolveTopologySession(workspaceId, mockTopology);
    expect(resolved).toBe("sess_stale_title");
    expect(sessionsApi.rename).toHaveBeenCalledWith("sess_stale_title", workspaceId, "拓扑 · 大型企业网络拓扑");
  });

  it("returns null when createIfMissing is false and no session exists", async () => {
    vi.mocked(sessionsApi.list).mockResolvedValueOnce({
      sessions: [],
    } as never);

    const resolved = await resolveTopologySession(workspaceId, mockTopology, false);
    expect(resolved).toBeNull();
    expect(sessionsApi.create).not.toHaveBeenCalled();
  });

  it("creates a new session when createIfMissing is true and no session exists", async () => {
    vi.mocked(sessionsApi.list).mockResolvedValueOnce({
      sessions: [],
    } as never);
    vi.mocked(sessionsApi.create).mockResolvedValueOnce({
      session: { session_id: "sess_new_created" } as never,
    } as never);

    const resolved = await resolveTopologySession(workspaceId, mockTopology, true);
    expect(resolved).toBe("sess_new_created");
    expect(sessionsApi.create).toHaveBeenCalledWith(
      workspaceId,
      "拓扑 · 大型企业网络拓扑",
      expect.objectContaining({
        topology_id: "topo_ent_001",
        topology_name: "大型企业网络拓扑",
      })
    );
    expect(localStorage.getItem(storageKey)).toBe("sess_new_created");
  });
});
