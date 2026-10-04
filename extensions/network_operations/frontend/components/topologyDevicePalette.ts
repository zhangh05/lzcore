/** topologyDevicePalette responsibilities, independent of the workspace screen. */
import type { TopologyCanvasItem } from "./topologyDocument";

export const DRAWING_DEVICE_TYPES = [
  { value: "router", label: "路由器" },
  { value: "router_core", label: "核心路由器" },
  { value: "switch", label: "交换机" },
  { value: "switch_core", label: "核心交换机" },
  { value: "switch_access", label: "接入交换机" },
  { value: "firewall", label: "防火墙" },
  { value: "server", label: "服务器" },
  { value: "pc", label: "终端 PC" },
  { value: "cloud", label: "云网络" },
  { value: "wireless", label: "无线 AP" },
  { value: "wlc", label: "无线控制器 AC" },
  { value: "storage", label: "存储设备" },
  { value: "vpn", label: "VPN 网关" },
  { value: "isp", label: "运营商专线" },
  { value: "wan", label: "广域网 WAN" },
  { value: "database", label: "数据库" },
  { value: "camera", label: "监控设备" },
  { value: "phone", label: "IP 电话" },
  { value: "printer", label: "打印设备" },
] as const;

export const QUICK_PALETTE_DEVICES = [
  { value: "router", label: "路由器", icon: "/netops-canvas/icons/router.svg" },
  { value: "switch", label: "交换机", icon: "/netops-canvas/icons/switch.svg" },
  {
    value: "firewall",
    label: "防火墙",
    icon: "/netops-canvas/icons/icon_firewall_custom.svg",
  },
  { value: "server", label: "服务器", icon: "/netops-canvas/icons/server.svg" },
  { value: "pc", label: "终端", icon: "/netops-canvas/icons/pc.svg" },
  { value: "cloud", label: "云/WAN", icon: "/netops-canvas/icons/cloud.svg" },
] as const;

export const batchTypeOptions: Array<[string, string]> = [
  ["router", "路由器"],
  ["switch", "二层交换机"],
  ["l3_switch", "三层交换机"],
  ["firewall", "防火墙"],
  ["server", "服务器"],
  ["wireless", "无线设备"],
  ["cloud", "云 / Internet"],
];

export const deviceTypeMap = new Map<string, string>([
  ...DRAWING_DEVICE_TYPES.map((d) => [d.value, d.label] as [string, string]),
  ...batchTypeOptions,
]);

export const canvasItemStylePresets = {
  teal: {
    label: "青绿标注",
    style: { fill: "#dff5f0", border: "#58a99b", color: "#0f5149" },
  },
  blue: {
    label: "蓝色标注",
    style: { fill: "#e3efff", border: "#6d9fe5", color: "#174f96" },
  },
  amber: {
    label: "琥珀标注",
    style: { fill: "#fff3d8", border: "#d69b36", color: "#7d4b00" },
  },
  slate: {
    label: "灰色标注",
    style: { fill: "#edf1f4", border: "#93a3af", color: "#334155" },
  },
} as const;

export function canvasItemStylePreset(
  style?: TopologyCanvasItem["style"],
): keyof typeof canvasItemStylePresets | "custom" {
  const match = Object.entries(canvasItemStylePresets).find(
    ([, preset]) =>
      preset.style.fill === style?.fill &&
      preset.style.border === style?.border &&
      preset.style.color === style?.color,
  );
  return (
    (match?.[0] as keyof typeof canvasItemStylePresets | undefined) || "custom"
  );
}
