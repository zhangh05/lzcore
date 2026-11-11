import { listOf, useApi } from "../../kit/useApi";
import type { Query } from "../../api/client";
import type { HttpOutcome } from "../../contracts/auth";
import { FailureNote, ReceiptNote } from "../../kit/ui";
import { NET_BASE } from "./api";
import { DEVICE_ROLES, VENDORS, type Connection } from "./forms";

export function useNet(path: string | null, ws: string, q?: Query) {
  return useApi(path ? `${NET_BASE}${path}` : null, { workspace_id: ws, ...q });
}
export { listOf };

export type ActionResult = { label: string; o: HttpOutcome } | null;

export function Result({ r }: { r: ActionResult }) {
  if (!r) return null;
  return r.o.kind === "http" && r.o.status < 300 ? <ReceiptNote text={`${r.label}已提交`} /> : <FailureNote outcome={r.o} />;
}

/** 保存后的回读说明：显示服务端回读的关键字段，回读失败如实说「未能回读」。 */
export function SavedNote({ label, text, testId }: { label: string; text: string | null; testId: string }) {
  return <p className="readback-note" role="status" data-testid={testId}>{label}已保存；{text ?? "未能回读，状态以列表刷新为准"}</p>;
}

export const VENDOR_ZH = Object.fromEntries(VENDORS) as Record<string, string>;
export const ROLE_ZH = Object.fromEntries(DEVICE_ROLES) as Record<string, string>;
export const CONN_STATUS: Record<string, string> = { untested: "未测试", connected: "已连通", verified: "已验证", failed: "测试失败", trust_required: "需核对主机指纹", host_key_changed: "主机指纹已变化", unreachable: "不可达" };

export type Health = "ok" | "warn" | "neutral" | "none";
/** 连接状态 → 色调：已连通/已验证为 ok，未测试为中性，其余（失败、不可达、指纹问题）需要关注。 */
export function connHealth(status?: string): Health {
  if (status === "connected" || status === "verified") return "ok";
  if (!status || status === "untested") return "neutral";
  return "warn";
}
/** 设备健康 = 其连接的最差状态；没有连接单独标出（无法操作）。 */
export function deviceHealth(conns: Connection[]): Health {
  if (!conns.length) return "none";
  const tones = conns.map((c) => connHealth(c.status));
  if (tones.includes("warn")) return "warn";
  if (tones.includes("ok")) return "ok";
  return "neutral";
}
export const HEALTH_LABEL: Record<Health, string> = { ok: "可连通", warn: "需关注", neutral: "未测试", none: "无连接" };

export function connReadbackText(c: Connection) {
  return `回读：${String(c.protocol ?? "").toUpperCase()}:${c.port ?? "?"} · 用户 ${c.username || "—"} · 状态 ${CONN_STATUS[c.status ?? ""] ?? c.status ?? "未上报"}${c.last_error ? `（${c.last_error}）` : ""}`;
}
