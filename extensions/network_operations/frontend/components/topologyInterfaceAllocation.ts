/** topologyInterfaceAllocation responsibilities, independent of the workspace screen. */
import type { TopologyLink } from "./topologyDocument";

export function occupiedInterfaces(
  links: TopologyLink[],
  nodeId?: string,
): Set<string> {
  const used = new Set<string>();
  if (!nodeId) return used;
  for (const link of links) {
    if (link.source_node_id === nodeId && link.source_interface)
      used.add(link.source_interface.trim());
    if (link.target_node_id === nodeId && link.target_interface)
      used.add(link.target_interface.trim());
  }
  return used;
}

export function nextFreeInterface(
  links: TopologyLink[],
  nodeId?: string,
  startAt = 1,
): string {
  const used = occupiedInterfaces(links, nodeId);
  for (let index = startAt; index < startAt + 256; index += 1) {
    const name = `GE0/${index}`;
    if (!used.has(name)) return name;
  }
  return `GE0/${startAt}`;
}
