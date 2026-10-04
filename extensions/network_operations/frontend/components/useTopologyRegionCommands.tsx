import { useCallback, useState } from "react";
import { confirm } from "../../../../frontend/src/components/ConfirmDialog";
import { type CanvasApi } from "./NetOpsCanvas";
import { alignBodies } from "./topologyAlignment";
import type {
  SelectedElement,
  Topology,
  TopologyCanvasItem,
} from "./topologyDocument";
import { ZONE_COLOR_PRESETS } from "./topologyDocument";
import { moveRegionElements, regionBounds } from "./topologyRegions";

export type useTopologyRegionCommandsPorts = {
  activeTopology: Topology | null;
  activeTopologyRef: import("react").MutableRefObject<Topology | null>;
  canvasApiRef: import("react").MutableRefObject<CanvasApi | null>;
  canvasSelectedElementIds: string[];
  pushState: (next: Topology) => void;
  setNotice: (notice: string, ok?: boolean) => void;
  setSelectedElement: import("react").Dispatch<
    import("react").SetStateAction<SelectedElement>
  >;
  setShowCreateZoneModal: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setZoneColorIndex: import("react").Dispatch<
    import("react").SetStateAction<number>
  >;
  setZoneNameInput: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  updatePopoverAnchor: () => void;
  zoneColorIndex: number;
  zoneNameInput: string;
};

export function useTopologyRegionCommands({
  activeTopology,
  activeTopologyRef,
  canvasApiRef,
  canvasSelectedElementIds,
  pushState,
  setNotice,
  setSelectedElement,
  setShowCreateZoneModal,
  setZoneColorIndex,
  setZoneNameInput,
  updatePopoverAnchor,
  zoneColorIndex,
  zoneNameInput,
}: useTopologyRegionCommandsPorts) {
  const [regionMoveMode, setRegionMoveMode] = useState<"region" | "frame">(
    "region",
  );
  const handleNetOpsMove = useCallback(
    (positions: Array<{ element_id: string; x: number; y: number }>) => {
      const current = activeTopologyRef.current;
      if (!current || !positions.length) return;
      pushState(
        moveRegionElements(current, positions, regionMoveMode === "region"),
      );
      requestAnimationFrame(() => updatePopoverAnchor());
    },
    [pushState, updatePopoverAnchor, regionMoveMode],
  );

  const handleAlignSelectedNodes = useCallback(
    (direction: "left" | "center" | "right" | "top" | "middle" | "bottom") => {
      if (!activeTopology) return;
      const selectedIds = new Set(canvasSelectedElementIds);
      const selected = activeTopology.nodes.filter((node) =>
        selectedIds.has(node.node_id),
      );
      if (selected.length < 2) {
        setNotice("请先框选至少两台设备，再执行对齐", false);
        return;
      }
      const bodies =
        canvasApiRef.current?.getBodies(selected.map((node) => node.node_id)) ||
        [];
      if (bodies.length !== selected.length) return;
      const positions = alignBodies(bodies, direction);
      pushState(moveRegionElements(activeTopology, positions, false));
      setNotice(`已对齐 ${selected.length} 台设备`);
    },
    [activeTopology, canvasSelectedElementIds, pushState, setNotice],
  );

  const handleRemoveCanvasItem = useCallback(
    async (itemId: string) => {
      if (!activeTopology) return;
      const confirmed = await confirm({
        title: "删除图纸图元",
        body: "确定删除这个图纸图元吗？",
        confirmLabel: "删除图元",
        destructive: true,
      });
      if (!confirmed) return;
      pushState({
        ...activeTopology,
        nodes: activeTopology.nodes.map((n) =>
          n.region_id === itemId ? { ...n, region_id: null } : n,
        ),
        canvas_items: (activeTopology.canvas_items || []).filter(
          (item) => item.item_id !== itemId,
        ),
      });
      setSelectedElement(null);
      setNotice("图纸图元已删除");
    },
    [activeTopology, pushState, setNotice],
  );

  const handleAutoFitCanvasItem = useCallback(
    (itemId: string) => {
      if (!activeTopology || !activeTopology.canvas_items) return;
      const item = activeTopology.canvas_items.find(
        (i) => i.item_id === itemId,
      );
      if (!item) return;

      const memberNodes = activeTopology.nodes.filter(
        (n) => n.region_id === itemId,
      );
      if (memberNodes.length === 0) {
        setNotice("未检测到关联设备节点，请先将设备加入此区域", false);
        return;
      }

      const bounds = regionBounds(memberNodes, item.kind);
      const memberIds = new Set(memberNodes.map((n) => n.node_id));

      const nextNodes = activeTopology.nodes.map((n) =>
        memberIds.has(n.node_id) ? { ...n, region_id: itemId } : n,
      );

      pushState({
        ...activeTopology,
        nodes: nextNodes,
        canvas_items: activeTopology.canvas_items.map((ci) =>
          ci.item_id === itemId
            ? {
                ...ci,
                auto_fit: true,
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
              }
            : ci,
        ),
      });
      setNotice(
        `已按绑定成员调整【${item.text || "区域"}】，包含 ${memberNodes.length} 台设备`,
      );
    },
    [activeTopology, canvasSelectedElementIds, pushState, setNotice],
  );

  const handleOpenCreateZone = useCallback(() => {
    if (!activeTopology) return;
    const selected = activeTopology.nodes.filter((n) =>
      canvasSelectedElementIds.includes(n.node_id),
    );
    if (selected.length === 0) {
      setNotice("请先框选或多选至少一台设备后再创建区域", false);
      return;
    }
    const first = selected[0];
    const defaultName =
      first.role === "core"
        ? "核心骨干区"
        : first.role === "aggregation"
          ? "汇聚区域"
          : first.role === "access"
            ? "接入区域"
            : "业务功能区";
    setZoneNameInput(defaultName);
    setZoneColorIndex(
      (activeTopology.canvas_items || []).length % ZONE_COLOR_PRESETS.length,
    );
    setShowCreateZoneModal(true);
  }, [activeTopology, canvasSelectedElementIds, setNotice]);

  const handleConfirmCreateZone = useCallback(
    (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      if (!activeTopology) return;
      const selectedIds = new Set(canvasSelectedElementIds);
      const selected = activeTopology.nodes.filter((n) =>
        selectedIds.has(n.node_id),
      );
      if (!selected.length) return;

      const bounds = regionBounds(selected);
      const preset =
        ZONE_COLOR_PRESETS[zoneColorIndex % ZONE_COLOR_PRESETS.length];
      const zoneName = zoneNameInput.trim() || "未命名区域";
      const zoneId = `zone-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      const newZoneItem: TopologyCanvasItem = {
        item_id: zoneId,
        auto_fit: true,
        kind: "rectangle",
        text: zoneName,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        style: {
          fill: preset.fill,
          border: preset.border,
          color: preset.color,
          borderWidth: 2,
        },
      };

      const nextNodes = activeTopology.nodes.map((n) =>
        selectedIds.has(n.node_id) ? { ...n, region_id: zoneId } : n,
      );

      pushState({
        ...activeTopology,
        nodes: nextNodes,
        canvas_items: [newZoneItem, ...(activeTopology.canvas_items || [])],
      });

      setShowCreateZoneModal(false);
      setNotice(
        `已生成智能区域【${zoneName}】，自适应包裹 ${selected.length} 台设备`,
      );
    },
    [
      activeTopology,
      canvasSelectedElementIds,
      pushState,
      setNotice,
      zoneColorIndex,
      zoneNameInput,
    ],
  );

  const handleSelectZoneMembers = useCallback(
    (nodeId: string) => {
      if (!activeTopology) return;
      const target = activeTopology.nodes.find((n) => n.node_id === nodeId);
      if (!target) return;
      const zoneKey = target.region_id;
      if (!zoneKey) return;
      const peers = activeTopology.nodes
        .filter((n) => n.region_id === zoneKey)
        .map((n) => n.node_id);
      if (peers.length > 0) {
        canvasApiRef.current?.selectElements?.(peers);
        setNotice(
          `已选中同区域【${activeTopology.canvas_items?.find((item) => item.item_id === zoneKey)?.text || "未命名区域"}】的 ${peers.length} 台设备`,
        );
      }
    },
    [activeTopology, setNotice],
  );

  const handleLeaveZone = useCallback(
    (nodeId: string) => {
      if (!activeTopology) return;
      const nextNodes = activeTopology.nodes.map((n) =>
        n.node_id === nodeId ? { ...n, region_id: null } : n,
      );
      pushState({ ...activeTopology, nodes: nextNodes });
      setNotice("已将设备移出所属区域");
    },
    [activeTopology, pushState, setNotice],
  );

  const handleJoinZone = useCallback(
    (nodeId: string, zoneItemId: string) => {
      if (!activeTopology) return;
      const zoneItem = (activeTopology.canvas_items || []).find(
        (ci) => ci.item_id === zoneItemId,
      );
      const zoneName = zoneItem?.text || "区域";
      const nextNodes = activeTopology.nodes.map((n) =>
        n.node_id === nodeId ? { ...n, region_id: zoneItemId } : n,
      );
      pushState({ ...activeTopology, nodes: nextNodes });
      setNotice(`已将设备加入区域【${zoneName}】`);
    },
    [activeTopology, pushState, setNotice],
  );

  const handleSendCanvasItemToBack = useCallback(
    (itemId: string) => {
      if (!activeTopology || !activeTopology.canvas_items) return;
      const item = activeTopology.canvas_items.find(
        (i) => i.item_id === itemId,
      );
      if (!item) return;
      const others = activeTopology.canvas_items.filter(
        (i) => i.item_id !== itemId,
      );
      pushState({ ...activeTopology, canvas_items: [item, ...others] });
      setNotice("图元已置于最底层");
    },
    [activeTopology, pushState, setNotice],
  );

  const handleBringCanvasItemToFront = useCallback(
    (itemId: string) => {
      if (!activeTopology || !activeTopology.canvas_items) return;
      const item = activeTopology.canvas_items.find(
        (i) => i.item_id === itemId,
      );
      if (!item) return;
      const others = activeTopology.canvas_items.filter(
        (i) => i.item_id !== itemId,
      );
      pushState({ ...activeTopology, canvas_items: [...others, item] });
      setNotice("图元已置于最顶层");
    },
    [activeTopology, pushState, setNotice],
  );
  return {
    handleRemoveCanvasItem,
    regionMoveMode,
    handleOpenCreateZone,
    handleAlignSelectedNodes,
    handleNetOpsMove,
    handleJoinZone,
    handleLeaveZone,
    handleSelectZoneMembers,
    handleAutoFitCanvasItem,
    handleBringCanvasItemToFront,
    handleSendCanvasItemToBack,
    setRegionMoveMode,
    handleConfirmCreateZone,
  };
}
