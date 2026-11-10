/**
 * 记忆写入样板（迁自 MemoryPage 的「稳定 id + 回读」）：全站写记忆都走这里。
 * - memory_id 在草稿创建时生成一次并持久化，重复点击不会生成新 id。
 * - 200 后必须回读 GET /api/memory/<id> 才算「已记住」。
 * - 409 execution_unknown：进入专门的未知态，只提供「回读核对」，不再提供写入按钮。
 */
import type { HttpOutcome } from "../contracts/auth";
import { api, bodyOf, enc, stableId } from "../api/client";

export type MemoryWriteState =
  | { kind: "idle" }
  | { kind: "writing" }
  | { kind: "reading_back"; memoryId: string }
  | { kind: "written"; memoryId: string; record: Record<string, unknown> }
  | { kind: "unknown"; memoryId: string; detail: string }
  | { kind: "readback_missing"; memoryId: string }
  | { kind: "failed"; outcome: HttpOutcome };

export function stableMemoryId(scopeKey: string): string {
  const key = `lzcore-next:memory-draft:${scopeKey}`;
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const id = stableId("mem");
    sessionStorage.setItem(key, id);
    return id;
  } catch { return stableId("mem"); }
}

export async function readBackMemory(ws: string, memoryId: string): Promise<MemoryWriteState> {
  const o = await api.get(`/api/memory/${enc(memoryId)}`, { workspace_id: ws });
  if (o.kind === "http" && o.status === 200) {
    const b = bodyOf<{ memory?: Record<string, unknown>; record?: Record<string, unknown> }>(o);
    return { kind: "written", memoryId, record: b?.memory ?? b?.record ?? (b as Record<string, unknown>) ?? {} };
  }
  if (o.kind === "http" && o.status === 404) return { kind: "readback_missing", memoryId };
  return { kind: "unknown", memoryId, detail: "回读失败，结果仍未知。" };
}

export async function writeMemory(ws: string, draft: { memory_id: string; title: string; content: string; session_id?: string; task_id?: string; user_confirmed?: boolean }): Promise<MemoryWriteState> {
  const o = await api.post("/api/memory/write", { workspace_id: ws, ...draft, user_confirmed: draft.user_confirmed ?? true });
  if (o.kind === "network_error") return { kind: "unknown", memoryId: draft.memory_id, detail: "请求发出后连接中断，写入是否生效未知。" };
  if (o.status === 409 && (o.body as { status?: string })?.status === "execution_unknown") {
    return { kind: "unknown", memoryId: String((o.body as { memory_id?: string }).memory_id || draft.memory_id), detail: "服务端返回 execution_unknown：写入结果未知，需要回读。" };
  }
  if (o.status >= 200 && o.status < 300) {
    // 后端去重时会返回已有记录的 memory_id（duplicate_of），回读以服务端返回为准。
    const returned = String((o.body as { memory_id?: string })?.memory_id || draft.memory_id);
    return readBackMemory(ws, returned);
  }
  return { kind: "failed", outcome: o };
}
