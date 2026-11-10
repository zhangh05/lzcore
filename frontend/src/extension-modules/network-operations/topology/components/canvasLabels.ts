/** canvasLabels is a renderer port independent of React screen state. */
import type { TopologyLink } from "./topologyDocument";

export function compactInterfaceLabel(value: string): string {
  return String(value || "")
    .trim()
    .replace(/hundred\s*-?\s*gig(?:abit)?ethernet/gi, "100GE")
    .replace(/forty\s*-?\s*gig(?:abit)?ethernet/gi, "40GE")
    .replace(/twenty\s*-?\s*five\s*-?\s*gig(?:abit)?ethernet/gi, "25GE")
    .replace(/(?:ten|10)\s*-?\s*gig(?:abit)?ethernet/gi, "XGE")
    .replace(/gigabit\s*ethernet/gi, "GE")
    .replace(/bridge\s*-?\s*aggregation/gi, "BAGG")
    .replace(/port\s*-?\s*channel/gi, "Po")
    .replace(/vlan\s*-?\s*interface/gi, "Vlanif")
    .replace(/loopback/gi, "Lo")
    .replace(/ethernet/gi, "Eth")
    .replace(/\s+/g, "");
}

export function canvasLinkDescription(
  link: Pick<TopologyLink, "label" | "metadata">,
): string {
  return link.metadata?.show_description ? String(link.label || "") : "";
}
