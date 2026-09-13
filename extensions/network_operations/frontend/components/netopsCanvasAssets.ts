export function netOpsIconForDeviceType(deviceType: string): string {
  const type = deviceType.trim().toLowerCase();
  if (type.includes("firewall") || type.includes("fw") || type.includes("security")) return "/netops-canvas/icons/icon_firewall_custom.png";
  if (type.includes("router")) return type.includes("core") ? "/netops-canvas/icons/router_core.png" : "/netops-canvas/icons/router.png";
  if (type.includes("server") || type.includes("host")) return "/netops-canvas/icons/server.png";
  if (type.includes("cloud") || type.includes("internet") || type.includes("wan")) return "/netops-canvas/icons/cloud.png";
  if (type.includes("wireless") || type.includes("wifi") || type.includes("ap")) return "/netops-canvas/icons/icon202.png";
  if (type.includes("layer3") || type.includes("l3") || type.includes("core")) return "/netops-canvas/icons/switch_core.png";
  return "/netops-canvas/icons/switch.png";
}
