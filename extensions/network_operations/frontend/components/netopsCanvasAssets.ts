export function netOpsIconForDeviceType(deviceType: string): string {
  const type = deviceType.trim().toLowerCase();
  if (type.includes("firewall") || type.includes("fw") || type.includes("security")) return "/netops-canvas/icons/icon_firewall_custom.svg";
  if (type.includes("router")) {
    if (type.includes("core")) return "/netops-canvas/icons/router_core.svg";
    if (type.includes("advanced") || type.includes("border") || type.includes("edge")) return "/netops-canvas/icons/router_advanced.svg";
    return "/netops-canvas/icons/router.svg";
  }
  if (type.includes("switch")) {
    if (type.includes("core") || type.includes("l3") || type.includes("layer3")) return "/netops-canvas/icons/switch_core.svg";
    if (type.includes("access")) return "/netops-canvas/icons/switch_access.svg";
    return "/netops-canvas/icons/switch.svg";
  }
  if (type === "l3_switch" || type.includes("layer3") || type.includes("core_switch")) return "/netops-canvas/icons/switch_core.svg";
  if (type.includes("pc") || type.includes("terminal") || type.includes("client") || type.includes("workstation")) return "/netops-canvas/icons/pc.svg";
  if (type.includes("server") || type.includes("host")) return "/netops-canvas/icons/server.svg";
  if (type.includes("wlc") || type.includes("ac") || type.includes("controller")) return "/netops-canvas/icons/wlc.svg";
  if (type.includes("vpn") || type.includes("ipsec")) return "/netops-canvas/icons/vpn.svg";
  if (type.includes("storage") || type.includes("san") || type.includes("nas")) return "/netops-canvas/icons/storage.svg";
  if (type.includes("isp") || type.includes("carrier") || type.includes("telecom") || type.includes("optical") || type.includes("line")) return "/netops-canvas/icons/isp.svg";
  if (type.includes("database") || type.includes("db") || type.includes("ca")) return "/netops-canvas/icons/icon157.svg";
  if (type.includes("printer") || type.includes("mail")) return "/netops-canvas/icons/icon159.svg";
  if (type.includes("camera") || type.includes("video") || type.includes("file") || type.includes("surveillance")) return "/netops-canvas/icons/icon161.svg";
  if (type.includes("phone") || type.includes("voip") || type.includes("tel")) return "/netops-canvas/icons/icon204.svg";
  if (type.includes("wan") || type.includes("internet") || type.includes("atm")) return "/netops-canvas/icons/icon205.svg";
  if (type.includes("cloud")) return "/netops-canvas/icons/cloud.svg";
  if (type.includes("wireless") || type.includes("wifi") || type.includes("ap")) return "/netops-canvas/icons/icon202.svg";
  return "/netops-canvas/icons/switch.svg";
}

