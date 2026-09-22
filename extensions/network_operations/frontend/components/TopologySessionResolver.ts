import { sessionsApi } from "../../../../frontend/src/api";
import { scopedLocalStorageKey } from "../../../../frontend/src/utils/userScope";
import { useSessionStore } from "../../../../frontend/src/stores/session";

export interface TopologyIdentity {
  topology_id: string;
  name: string;
}

/**
 * 拓扑专属会话解析器：
 * 保证 1 个拓扑图纸全局严格对应 1 个会话，杜绝重复创建或丢失历史上下文。
 */
export async function resolveTopologySession(
  workspaceId: string,
  topology: TopologyIdentity,
  createIfMissing = true,
): Promise<string | null> {
  const topoId = topology.topology_id;
  const storageKey = scopedLocalStorageKey(`drawing_session_v2:${workspaceId}:${topoId}`);

  // 1. 优先校验本地记录的会话在服务端是否仍然有效
  try {
    const cachedId = localStorage.getItem(storageKey);
    if (cachedId) {
      const res = await sessionsApi.get(cachedId, workspaceId);
      if (res?.session && res.session.status === "active") {
        syncLocalStorageSkill(cachedId, topoId);
        return cachedId;
      }
    }
  } catch {
    // 缓存无效或网络抖动，降级走服务端列表全量检索
  }

  // 2. 服务端查找属于当前拓扑的已有历史会话
  try {
    const res = await sessionsApi.list(workspaceId);
    const sessions = res.sessions || [];

    const matched = sessions.find((s) => {
      const meta = (s.metadata || {}) as Record<string, unknown>;
      if (meta.topology_id === topoId) return true;
      const sel = meta.workbench_selection as { skill_id?: string; resource_ids?: string[] } | undefined;
      if (sel?.resource_ids?.includes(topoId)) return true;
      if (sel?.skill_id === `drawing:${topoId}` || sel?.skill_id === `drawing:${topoId}:ro`) return true;
      if (s.title === `拓扑 · ${topology.name}` || s.title === `拓扑 · ${topoId}`) return true;
      return false;
    });

    if (matched) {
      const existingId = matched.session_id;
      try {
        localStorage.setItem(storageKey, existingId);
      } catch { /* noop */ }
      syncLocalStorageSkill(existingId, topoId);

      // 若历史会话标题陈旧（如“拓扑 · 2”），自动同步最新图纸名
      const expectedTitle = `拓扑 · ${topology.name}`;
      if (matched.title !== expectedTitle) {
        void sessionsApi.rename(existingId, workspaceId, expectedTitle).catch(() => {});
        useSessionStore.getState().bumpSessionList();
      }
      return existingId;
    }
  } catch (err) {
    console.warn("Failed to query existing topology session from server", err);
  }

  if (!createIfMissing) {
    return null;
  }

  // 3. 服务端若确实无任何该拓扑历史会话，新建专属会话
  const created = await sessionsApi.create(workspaceId, `拓扑 · ${topology.name}`, {
    topology_id: topoId,
    topology_name: topology.name,
    allow_edit: true,
    workbench_selection: {
      extension_id: "network.operations",
      skill_id: `drawing:${topoId}`,
      skill_name: `拓扑绘图 · ${topology.name}`,
      resource_ids: [topoId],
      allow_edit: true,
    },
  });

  const newId = created.session.session_id;
  try {
    localStorage.setItem(storageKey, newId);
  } catch { /* noop */ }
  syncLocalStorageSkill(newId, topoId);
  useSessionStore.getState().bumpSessionList();
  return newId;
}

function syncLocalStorageSkill(sessionId: string, topologyId: string) {
  try {
    localStorage.setItem(
      scopedLocalStorageKey(`workbench_skill:${sessionId}`),
      JSON.stringify({
        skill_key: `network.operations:drawing:${topologyId}`,
        resource_ids: [topologyId],
      }),
    );
  } catch { /* noop */ }
}
