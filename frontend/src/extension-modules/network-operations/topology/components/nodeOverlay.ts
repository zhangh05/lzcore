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

function recentEvidence(item: NodeOverlay) {
  const test = item.connection?.last_tested_at && Number.isFinite(Date.parse(item.connection.last_tested_at)) ? item.connection : null;
  const observation = item.observation?.observed_at && Number.isFinite(Date.parse(item.observation.observed_at)) ? item.observation : null;
  if (item.connection?.status === "trust_required") return { status: "warning" as const, label: CONNECTION_LABELS.trust_required, time: item.connection.last_tested_at };
  if (observation?.observed_at && (!test?.last_tested_at || test.status === "untested"
    || Date.parse(observation.observed_at) >= Date.parse(test.last_tested_at))) {
    const state = observation.completeness;
    return { status: (state === "complete" ? "ok" : state === "partial" ? "warning" : state === "failed" ? "error" : "unknown") as OverlayBorderStatus,
      label: `最近观测${COMPLETENESS_LABELS[state] || "结果无法确认"}`, time: observation.observed_at };
  }
  if (test?.last_tested_at && test.status !== "untested") {
    return { status: (test.status === "connected" ? "ok" : test.status === "failed" ? "error" : "unknown") as OverlayBorderStatus,
      label: CONNECTION_LABELS[test.status] || "测试结果无法确认", time: test.last_tested_at };
  }
  return null;
}

/** A recent evidence marker, never the drawing border or current device health. */
export function overlayObservationStatus(item: NodeOverlay | undefined): OverlayBorderStatus | null {
  if (!item) return null;
  if (item.device_state === "missing") return "warning";
  return recentEvidence(item)?.status || null;
}

export function overlayCanvasLine(item: NodeOverlay): string {
  if (item.device_state === "missing") return "绑定设备已不存在";
  const evidence = recentEvidence(item);
  if (!evidence) return "尚无观测";
  const time = formatObservationTime(evidence.time);
  return `${evidence.label}${time ? ` · ${time}` : ""}`;
}

export function overlayCaption(item: NodeOverlay): string {
  if (item.device_state === "missing") return "绑定设备已不存在。节点仍是图纸符号，不代表设备故障。";
  const name = item.device?.name || "已绑定设备";
  return `${name} · ${overlayCanvasLine(item)}。${recentEvidence(item) ? "这是最近记录，不表示当前健康。" : ""}`;
}
