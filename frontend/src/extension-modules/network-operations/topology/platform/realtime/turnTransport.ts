/**
 * 旧 turnTransport 只给画布提供两个订阅：拓扑被 Agent 更新、传输恢复。
 * 新工作台的 TurnTransport 目前不向画布推送这两类事件，这里是本地事件总线；
 * 画布在聚焦 / 手动刷新时仍会回读服务端版本（旧逻辑不变）。
 */
export type TopologyUpdate = { workspace_id?: string; topology_id?: string; version?: number; [k: string]: unknown };
type TopologyListener = (data: TopologyUpdate) => void;
const topologyListeners = new Set<TopologyListener>();
const resumedListeners = new Set<() => void>();

export function onTopologyUpdated(listener: TopologyListener): () => void {
  topologyListeners.add(listener);
  return () => { topologyListeners.delete(listener); };
}
export function onTransportResumed(listener: () => void): () => void {
  resumedListeners.add(listener);
  return () => { resumedListeners.delete(listener); };
}
export function emitTopologyUpdated(data: TopologyUpdate) { topologyListeners.forEach((l) => l(data)); }
export function emitTransportResumed() { resumedListeners.forEach((l) => l()); }
