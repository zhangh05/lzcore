export type NodeOverlay = {
  node_id: string;
  device_id: string;
  device_state: "bound" | "missing";
  device: { name: string; host?: string } | null;
  connection: { status: string; last_tested_at: string } | null;
  observation: { observed_at: string; completeness: string } | null;
};

export type OverlayBorderStatus = "ok" | "warning" | "error" | "unknown";

const CONNECTION_LABELS: Record<string, string> = {
  connected: "最近连接成功",
  failed: "最近测试失败",
  untested: "尚未测试",
  trust_required: "待确认主机密钥",
};

const COMPLETENESS_LABELS: Record<string, string> = {
  complete: "完整",
  partial: "部分",
  failed: "失败",
  unknown: "未知",
};

export function formatObservationTime(value: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function overlayBorderStatus(item: NodeOverlay | undefined): OverlayBorderStatus {
  if (!item) return "unknown";
  if (item.device_state === "missing") return "error";
  const status = item.connection?.status || "";
  if (status === "failed") return "error";
  if (status === "trust_required") return "warning";
  return "unknown";
}

export function overlayCanvasLine(item: NodeOverlay): string {
  if (item.device_state === "missing") return "设备已不存在";
  if (item.observation?.observed_at) return `观测于 ${formatObservationTime(item.observation.observed_at)}`;
  if (item.connection?.status === "failed") return "最近测试失败";
  if (item.connection?.last_tested_at) return CONNECTION_LABELS[item.connection.status] || "已有测试记录";
  return "尚无观测";
}

export function overlayCaption(item: NodeOverlay): string {
  if (item.device_state === "missing") return "设备已不存在。节点仍是图纸符号。";
  const name = item.device?.name || "已绑定设备";
  if (item.observation?.observed_at) {
    const completeness = COMPLETENESS_LABELS[item.observation.completeness] || "未知";
    return `${name} · 观测于 ${formatObservationTime(item.observation.observed_at)} · ${completeness}。这不是当前正常。`;
  }
  if (item.connection?.last_tested_at) {
    const label = CONNECTION_LABELS[item.connection.status] || "已有测试记录";
    return `${name} · ${label} · ${formatObservationTime(item.connection.last_tested_at)}。这不是当前正常。`;
  }
  return `${name} · 尚无观测。`;
}
