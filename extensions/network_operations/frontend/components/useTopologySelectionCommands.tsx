import { useCallback, useMemo } from "react";
import { confirm } from "../../../../frontend/src/components/ConfirmDialog";
import { type CanvasApi } from "./NetOpsCanvas";
import type { SelectedElement, Topology } from "./topologyDocument";
import { moveRegionElements } from "./topologyRegions";

export type useTopologySelectionCommandsPorts = {
  activeTopology: Topology | null;
  activeTopologyRef: import("react").MutableRefObject<Topology | null>;
  canvasApiRef: import("react").MutableRefObject<CanvasApi | null>;
  canvasSelectedElementIds: string[];
  handleRemoveCanvasItem: (itemId: string) => Promise<void>;
  handleRemoveLink: (linkId: string) => Promise<void>;
  handleRemoveNode: (nodeId: string) => Promise<void>;
  pushState: (next: Topology) => void;
  regionMoveMode: "region" | "frame";
  selectedElement: SelectedElement;
  setNotice: (notice: string, ok?: boolean) => void;
  setSelectedElement: import("react").Dispatch<
    import("react").SetStateAction<SelectedElement>
  >;
};

export function useTopologySelectionCommands({
  activeTopology,
  activeTopologyRef,
  canvasApiRef,
  canvasSelectedElementIds,
  handleRemoveCanvasItem,
  handleRemoveLink,
  handleRemoveNode,
  pushState,
  regionMoveMode,
  selectedElement,
  setNotice,
  setSelectedElement,
}: useTopologySelectionCommandsPorts) {
  const nudgeSelected = useCallback(
    (dx: number, dy: number) => {
      const current = activeTopologyRef.current;
      if (!current || !canvasSelectedElementIds.length) return;
      const ids = new Set(canvasSelectedElementIds);
      const lockGroups = new Set<string>();
      for (const node of current.nodes) {
        if (ids.has(node.node_id) && node.lock_group) {
          lockGroups.add(node.lock_group);
        }
      }
      if (lockGroups.size > 0) {
        for (const node of current.nodes) {
          if (node.lock_group && lockGroups.has(node.lock_group)) {
            ids.add(node.node_id);
          }
        }
      }
      const positions = [
        ...current.nodes
          .filter((node) => ids.has(node.node_id))
          .map((node) => ({
            element_id: node.node_id,
            x: node.x + dx,
            y: node.y + dy,
          })),
        ...(current.canvas_items || [])
          .filter((item) => ids.has(`canvas-${item.item_id}`))
          .map((item) => ({
            element_id: `canvas-${item.item_id}`,
            x: item.x + dx,
            y: item.y + dy,
          })),
      ];
      pushState(
        moveRegionElements(current, positions, regionMoveMode === "region"),
      );
    },
    [canvasSelectedElementIds, pushState, regionMoveMode],
  );

  const handleLockSelectedNodes = useCallback(() => {
    const current = activeTopologyRef.current;
    if (!current) return;
    const selectedIds = new Set(canvasSelectedElementIds);
    const selected = current.nodes.filter((node) =>
      selectedIds.has(node.node_id),
    );
    if (selected.length < 2) {
      setNotice("请先框选至少两台设备，再执行固定", false);
      return;
    }
    const lockGroupId = `lg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const nextNodes = current.nodes.map((node) =>
      selectedIds.has(node.node_id)
        ? { ...node, lock_group: lockGroupId }
        : node,
    );
    pushState({ ...current, nodes: nextNodes });
    setNotice(
      `已将选中的 ${selected.length} 台设备固定相对位置 (拖动其中一台时其他设备同步联动)`,
    );
  }, [canvasSelectedElementIds, pushState, setNotice]);

  const handleUnlockSelectedNodes = useCallback(() => {
    const current = activeTopologyRef.current;
    if (!current) return;
    const selectedIds = new Set(canvasSelectedElementIds);
    const uncleanedNodes = current.nodes.map((node) =>
      selectedIds.has(node.node_id) ? { ...node, lock_group: undefined } : node,
    );
    // Clean up any lock groups that have fewer than 2 nodes remaining
    const groupCounts = new Map<string, number>();
    for (const node of uncleanedNodes) {
      if (node.lock_group)
        groupCounts.set(
          node.lock_group,
          (groupCounts.get(node.lock_group) || 0) + 1,
        );
    }
    const nextNodes = uncleanedNodes.map((node) =>
      node.lock_group && (groupCounts.get(node.lock_group) || 0) < 2
        ? { ...node, lock_group: undefined }
        : node,
    );
    pushState({ ...current, nodes: nextNodes });
    setNotice("已解除选中设备的固定联动");
  }, [canvasSelectedElementIds, pushState, setNotice]);

  const handleUnlockNode = useCallback(
    (nodeId: string) => {
      const current = activeTopologyRef.current;
      if (!current) return;
      const uncleanedNodes = current.nodes.map((node) =>
        node.node_id === nodeId ? { ...node, lock_group: undefined } : node,
      );
      const groupCounts = new Map<string, number>();
      for (const node of uncleanedNodes) {
        if (node.lock_group)
          groupCounts.set(
            node.lock_group,
            (groupCounts.get(node.lock_group) || 0) + 1,
          );
      }
      const nextNodes = uncleanedNodes.map((node) =>
        node.lock_group && (groupCounts.get(node.lock_group) || 0) < 2
          ? { ...node, lock_group: undefined }
          : node,
      );
      pushState({ ...current, nodes: nextNodes });
      setNotice("已解除设备固定联动");
    },
    [pushState, setNotice],
  );

  const handleSelectLockGroup = useCallback(
    (nodeId: string) => {
      const current = activeTopologyRef.current;
      if (!current) return;
      const targetNode = current.nodes.find((n) => n.node_id === nodeId);
      if (!targetNode?.lock_group) return;
      const peerIds = current.nodes
        .filter((n) => n.lock_group === targetNode.lock_group)
        .map((n) => n.node_id);
      canvasApiRef.current?.selectElements?.(peerIds);
      setNotice(`已选中同组固定的 ${peerIds.length} 台设备`);
    },
    [setNotice],
  );

  // Batch editing: selecting ten devices and being able to do nothing with
  // them is the point where people go back to Visio.
  const selectedNodes = useMemo(
    () =>
      (activeTopology?.nodes || []).filter((node) =>
        canvasSelectedElementIds.includes(node.node_id),
      ),
    [activeTopology, canvasSelectedElementIds],
  );
  const selectedCanvasItems = useMemo(
    () =>
      (activeTopology?.canvas_items || []).filter((item) =>
        canvasSelectedElementIds.includes(`canvas-${item.item_id}`),
      ),
    [activeTopology, canvasSelectedElementIds],
  );
  const hasMultiSelection =
    selectedNodes.length + selectedCanvasItems.length > 1;
  // Batch actions (alignment, distribution, batch type) are accessible via the
  // toolbar and the selection chip in the caption without popping up automatically over nodes.

  const distributeSelected = useCallback(
    (axis: "horizontal" | "vertical") => {
      if (!activeTopology) return;
      const selected = activeTopology.nodes.filter((node) =>
        canvasSelectedElementIds.includes(node.node_id),
      );
      if (selected.length < 3) {
        setNotice("请先框选至少三台设备，再执行等距分布", false);
        return;
      }
      const sorted = [...selected].sort((left, right) =>
        axis === "horizontal" ? left.x - right.x : left.y - right.y,
      );
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const span = axis === "horizontal" ? last.x - first.x : last.y - first.y;
      const step = span / (sorted.length - 1);
      const updates = new Map<string, number>();
      sorted.forEach((node, index) => {
        if (index === 0 || index === sorted.length - 1) return;
        updates.set(
          node.node_id,
          Math.round(
            (axis === "horizontal" ? first.x : first.y) + step * index,
          ),
        );
      });
      pushState({
        ...activeTopology,
        nodes: activeTopology.nodes.map((node) => {
          const next = updates.get(node.node_id);
          if (next === undefined) return node;
          return {
            ...node,
            ...(axis === "horizontal" ? { x: next } : { y: next }),
          };
        }),
      });
      setNotice(`已等距分布 ${selected.length} 台设备`);
    },
    [activeTopology, canvasSelectedElementIds, pushState, setNotice],
  );

  const applyDeviceTypeToSelection = useCallback(
    (deviceType: string) => {
      if (!activeTopology) return;
      const ids = new Set(
        canvasSelectedElementIds.filter((id) => !id.startsWith("canvas-")),
      );
      if (!ids.size) return;
      pushState({
        ...activeTopology,
        nodes: activeTopology.nodes.map((node) =>
          ids.has(node.node_id) ? { ...node, device_type: deviceType } : node,
        ),
      });
      setNotice(`已将 ${ids.size} 个节点的类型设为「${deviceType}」`);
    },
    [activeTopology, canvasSelectedElementIds, pushState, setNotice],
  );

  const removeSelectedObjects = useCallback(async () => {
    if (!activeTopology) return;
    const nodeIds = canvasSelectedElementIds.filter(
      (id) => !id.startsWith("canvas-"),
    );
    const itemIds = canvasSelectedElementIds
      .filter((id) => id.startsWith("canvas-"))
      .map((id) => id.replace(/^canvas-/, ""));
    if (!nodeIds.length && !itemIds.length) return;
    const confirmed = await confirm({
      title: "移除选中的对象",
      body: `将从图纸中移除 ${nodeIds.length} 个节点、${itemIds.length} 个图元及其关联链路。`,
      confirmLabel: "移除",
      destructive: true,
    });
    if (!confirmed) return;
    const nodeSet = new Set(nodeIds);
    const itemSet = new Set(itemIds);
    const remainingNodes = activeTopology.nodes.filter(
      (node) => !nodeSet.has(node.node_id),
    );
    const groupCounts = new Map<string, number>();
    for (const n of remainingNodes) {
      if (n.lock_group)
        groupCounts.set(n.lock_group, (groupCounts.get(n.lock_group) || 0) + 1);
    }
    const cleanedNodes = remainingNodes.map((n) =>
      n.lock_group && (groupCounts.get(n.lock_group) || 0) < 2
        ? { ...n, lock_group: undefined }
        : n,
    );
    pushState({
      ...activeTopology,
      nodes: cleanedNodes.map((n) =>
        n.region_id && itemSet.has(n.region_id) ? { ...n, region_id: null } : n,
      ),
      links: activeTopology.links.filter(
        (link) =>
          !nodeSet.has(link.source_node_id) &&
          !nodeSet.has(link.target_node_id),
      ),
      canvas_items: (activeTopology.canvas_items || []).filter(
        (item) => !itemSet.has(item.item_id),
      ),
    });
    setSelectedElement(null);
    canvasApiRef.current?.clearSelection();
    setNotice(`已移除 ${nodeIds.length} 个节点、${itemIds.length} 个图元`);
  }, [activeTopology, canvasSelectedElementIds, pushState, setNotice]);

  const deleteSelection = useCallback(() => {
    if (!selectedElement) return;
    if (selectedElement.type === "node")
      void handleRemoveNode(selectedElement.nodeId);
    else if (selectedElement.type === "link")
      void handleRemoveLink(selectedElement.linkId);
    else if (selectedElement.type === "canvas_item")
      void handleRemoveCanvasItem(selectedElement.itemId);
  }, [
    selectedElement,
    handleRemoveNode,
    handleRemoveLink,
    handleRemoveCanvasItem,
  ]);
  return {
    deleteSelection,
    nudgeSelected,
    removeSelectedObjects,
    selectedNodes,
    handleLockSelectedNodes,
    handleUnlockSelectedNodes,
    hasMultiSelection,
    applyDeviceTypeToSelection,
    distributeSelected,
    selectedCanvasItems,
    handleSelectLockGroup,
    handleUnlockNode,
  };
}
