/**
 * 拓扑深链参数统一（方案 P-30）：读写都用 `topology`。
 * 入参兼容旧 `topology_id` 与新壳通用的 `id`，进入画布时规范化成 `topology`（replace，不新增历史）。
 * `tab=topologies` 由外层页面负责；`node` 继续表示选中节点。
 */
export const TOPOLOGY_PARAM = "topology";
const LEGACY_PARAMS = ["topology_id", "id"] as const;

export function readTopologyParam(search: string = typeof window === "undefined" ? "" : window.location.search): string {
  const p = new URLSearchParams(search);
  return p.get(TOPOLOGY_PARAM) || LEGACY_PARAMS.map((k) => p.get(k)).find(Boolean) || "";
}

/** 只写 `topology`，并删掉旧参数。 */
export function writeTopologyParam(url: URL, topologyId: string): URL {
  if (topologyId) url.searchParams.set(TOPOLOGY_PARAM, topologyId); else url.searchParams.delete(TOPOLOGY_PARAM);
  for (const k of LEGACY_PARAMS) url.searchParams.delete(k);
  return url;
}

/** 返回规范化后的 path+search+hash；已经规范则返回 null。 */
export function normalizeTopologyHref(href: string): string | null {
  const url = new URL(href, "http://local.invalid");
  const id = readTopologyParam(url.search);
  if (!LEGACY_PARAMS.some((k) => url.searchParams.has(k))) return null;
  writeTopologyParam(url, id);
  return `${url.pathname}${url.search}${url.hash}`;
}
