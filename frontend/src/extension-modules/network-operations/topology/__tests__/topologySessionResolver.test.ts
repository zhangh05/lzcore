import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTopologySession } from "../components/TopologySessionResolver";
import { sessionsApi } from "../platform/api";
import { scopedLocalStorageKey } from "../platform/utils/userScope";

vi.mock("../platform/api", () => ({
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


it("reconciles a cached drawing session name and keeps user-authored titles", async () => {
  vi.clearAllMocks();
  localStorage.clear();
  const topology = {topology_id: "title-sheet", name: "新图名"};
  localStorage.setItem(scopedLocalStorageKey("drawing_session_v2:default:title-sheet"), "cached-title");
  vi.mocked(sessionsApi.get).mockResolvedValueOnce({session: {session_id: "cached-title", status: "active", title: "拓扑 · 旧图名"}} as never);
  await resolveTopologySession("default", topology);
  expect(sessionsApi.rename).toHaveBeenCalledWith("cached-title", "default", "拓扑 · 新图名");
  vi.mocked(sessionsApi.rename).mockClear();
  vi.mocked(sessionsApi.get).mockResolvedValueOnce({session: {session_id: "cached-title", status: "active", title: "用户的分析会话"}} as never);
  await resolveTopologySession("default", topology);
  expect(sessionsApi.rename).not.toHaveBeenCalled();
});


it("keeps a valid cached session when title reconciliation is temporarily unavailable", async () => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem(scopedLocalStorageKey("drawing_session_v2:default:retry-title"), "valid-session");
  vi.mocked(sessionsApi.get).mockResolvedValueOnce({session: {session_id: "valid-session", status: "active", title: "拓扑 · old"}} as never);
  vi.mocked(sessionsApi.rename).mockRejectedValueOnce(new Error("network interruption"));
  const resolved = await resolveTopologySession("default", {topology_id: "retry-title", name: "new"});
  expect(resolved).toBe("valid-session");
  expect(sessionsApi.create).not.toHaveBeenCalled();
});

describe("TopologySessionResolver · 资源身份优先于标题", () => {
  const topology = { topology_id: "topo_B", name: "同名图纸" };
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

  it("同名标题但明确绑定了另一张图的会话不复用", async () => {
    vi.mocked(sessionsApi.list).mockResolvedValueOnce({ sessions: [
      { session_id: "sess_for_A", status: "active", title: "拓扑 · 同名图纸", metadata: { topology_id: "topo_A" } },
    ] } as never);
    vi.mocked(sessionsApi.create).mockResolvedValueOnce({ session: { session_id: "sess_new" } } as never);
    expect(await resolveTopologySession("default", topology)).not.toBe("sess_for_A");
  });

  it("没有绑定的历史会话仍按标题兜底", async () => {
    vi.mocked(sessionsApi.list).mockResolvedValueOnce({ sessions: [
      { session_id: "sess_legacy", status: "active", title: "拓扑 · 同名图纸", metadata: {} },
    ] } as never);
    expect(await resolveTopologySession("default", topology)).toBe("sess_legacy");
  });

  it("缓存的会话若绑定了另一张图则作废，改用明确绑定本图的会话", async () => {
    localStorage.setItem(scopedLocalStorageKey("drawing_session_v2:default:topo_B"), "sess_other");
    vi.mocked(sessionsApi.get).mockResolvedValueOnce({ session: { session_id: "sess_other", status: "active", metadata: { topology_id: "topo_A" } } } as never);
    vi.mocked(sessionsApi.list).mockResolvedValueOnce({ sessions: [
      { session_id: "sess_mine", status: "active", title: "随便", metadata: { workbench_selection: { skill_id: "drawing:topo_B" } } },
    ] } as never);
    expect(await resolveTopologySession("default", topology)).toBe("sess_mine");
  });
});
