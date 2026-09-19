export function netOpsIconForDeviceType(deviceType: string): string {
  const type = deviceType.trim().toLowerCase();
  if (type.includes("firewall") || type.includes("fw") || type.includes("security")) return "/netops-canvas/icons/icon_firewall_custom.png";
  if (type.includes("router")) {
    if (type.includes("core")) return "/netops-canvas/icons/router_core.png";
    if (type.includes("advanced") || type.includes("border") || type.includes("edge")) return "/netops-canvas/icons/router_advanced.png";
    return "/netops-canvas/icons/router.png";
  }
  if (type.includes("switch")) {
    if (type.includes("core") || type.includes("l3") || type.includes("layer3")) return "/netops-canvas/icons/switch_core.png";
    if (type.includes("access")) return "/netops-canvas/icons/switch_access.png";
    return "/netops-canvas/icons/switch.png";
  }
  if (type === "l3_switch" || type.includes("layer3") || type.includes("core_switch")) return "/netops-canvas/icons/switch_core.png";
  if (type.includes("pc") || type.includes("terminal") || type.includes("client") || type.includes("workstation")) return "/netops-canvas/icons/pc.png";
  if (type.includes("server") || type.includes("host")) return "/netops-canvas/icons/server.png";
  if (type.includes("database") || type.includes("db") || type.includes("ca")) return "/netops-canvas/icons/icon157.png";
  if (type.includes("printer") || type.includes("mail")) return "/netops-canvas/icons/icon159.png";
  if (type.includes("camera") || type.includes("video") || type.includes("storage") || type.includes("file") || type.includes("surveillance")) return "/netops-canvas/icons/icon161.png";
  if (type.includes("phone") || type.includes("voip") || type.includes("tel")) return "/netops-canvas/icons/icon204.png";
  if (type.includes("wan") || type.includes("internet") || type.includes("atm")) return "/netops-canvas/icons/icon205.png";
  if (type.includes("cloud")) return "/netops-canvas/icons/cloud.png";
  if (type.includes("wireless") || type.includes("wifi") || type.includes("ap")) return "/netops-canvas/icons/icon202.png";
  return "/netops-canvas/icons/switch.png";
}

