import type { WorkbenchSelection } from "../contracts/workbench";
import { drawingSessionBinding } from "./network-operations/sessionBinding";
/**
 * 扩展前端模块注册表（新目录，从旧扩展前端迁入的实现放在 src/extension-modules/*）。
 * 核心只通过这里按 `/api/extensions` 返回的 extension_id + 路由挂载；扩展不可用时核心根本不渲染它。
 * 核心不 import 仓库根的 `extensions/**`。
 */
import { lazy, type ComponentType, type ReactNode } from "react";
import { ApprovalCard } from "./approval/ApprovalCard";
import { matchNetworkEvidence, NetworkEvidence } from "./network-operations/NetworkEvidence";

export interface ExtensionPageProps { ws: string; mountPath: string; subPath: string }

export interface EvidenceCall { tool_id: string; call_id?: string; result?: Record<string, unknown> }

export interface EvidenceRenderer {
  /** 返回非空 key 表示由本渲染器接管这条工具结果。 */
  match: (call: EvidenceCall) => string | null;
  render: (ws: string, key: string, call: EvidenceCall) => ReactNode;
}

export interface ExtensionModule {
  extensionId: string;
  pages: Record<string, ComponentType<ExtensionPageProps>>;
  evidence?: EvidenceRenderer[];
  sessionBinding?: (metadata: Record<string, unknown>) => WorkbenchSelection | null;
}

const NetworkOperationsModule = lazy(() => import("./network-operations/NetworkOperationsPage"));

export const EXTENSION_MODULES: Record<string, ExtensionModule> = {
  "network.operations": {
    extensionId: "network.operations",
    sessionBinding: drawingSessionBinding,
    pages: { "/extensions/network.operations/manage": NetworkOperationsModule, "/extensions/network.operations/topology": NetworkOperationsModule, "/extensions/network.operations/skills": NetworkOperationsModule },
    evidence: [{
      match: matchNetworkEvidence,
      render: (ws, _key, call) => <NetworkEvidence ws={ws} toolId={call.tool_id} result={call.result} />,
    }],
  },
  approval: {
    extensionId: "approval",
    pages: {},
    evidence: [{
      match: (call) => {
        const r = call.result ?? {};
        const id = (r.approval_operation_id as string) || ((r.approval as { operation_id?: string } | undefined)?.operation_id ?? "");
        return id || null;
      },
      render: (ws, id) => <ApprovalCard ws={ws} operationId={id} />,
    }],
  },
};

export function moduleFor(extensionId: string, mountPath: string): ComponentType<ExtensionPageProps> | null {
  return EXTENSION_MODULES[extensionId]?.pages[mountPath] ?? null;
}

/** 只对「已安装且可用」的扩展启用其证据渲染器。 */
export function evidenceRenderers(availableExtensionIds: Set<string>): EvidenceRenderer[] {
  return Object.values(EXTENSION_MODULES).filter((m) => availableExtensionIds.has(m.extensionId)).flatMap((m) => m.evidence ?? []);
}

export function boundSessionSelection(metadata?: Record<string, unknown> | null): WorkbenchSelection | null {
  if (!metadata) return null;
  for (const module of Object.values(EXTENSION_MODULES)) {
    const selection = module.sessionBinding?.(metadata);
    if (selection) return selection;
  }
  return null;
}
