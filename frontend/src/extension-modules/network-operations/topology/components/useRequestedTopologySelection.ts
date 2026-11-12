import { useEffect, useRef, useState } from "react";
import { readTopologyParam } from "../topologyParams";

/**
 * 当前图纸选择：URL 里的 `?topology=` 只是「请求」，每个请求值只应用一次。
 *
 * 选中的图纸会被回写到 URL（useTopologyViews，replaceState），回写和下一次渲染之间
 * URL 仍是旧值。以前每次渲染都按 URL 强制改回去，新建 / 切换图纸后两处互相覆盖，
 * 选中在两张图之间无限翻转：overlay、版本记录、会话列表被反复请求直到 429，
 * 对话面板的会话和图纸也跟着来回跳。
 */
export function useRequestedTopologySelection(topologies: Array<{ topology_id: string }>) {
  const requested = typeof window === "undefined" ? "" : readTopologyParam();
  const has = (id: string) => topologies.some((t) => t.topology_id === id);
  const appliedRef = useRef(requested && has(requested) ? requested : "");
  const [selectedTopologyId, setSelectedTopologyId] = useState<string>(
    () => appliedRef.current || topologies[0]?.topology_id || "",
  );

  useEffect(() => {
    if (requested && requested !== appliedRef.current && has(requested)) {
      appliedRef.current = requested;
      setSelectedTopologyId(requested);
      return;
    }
    if (!selectedTopologyId && topologies.length > 0) {
      setSelectedTopologyId(topologies[0].topology_id);
    } else if (selectedTopologyId && !has(selectedTopologyId)) {
      setSelectedTopologyId(topologies[0]?.topology_id || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested, topologies, selectedTopologyId]);

  return [selectedTopologyId, setSelectedTopologyId] as const;
}
