import { useCallback, type DragEvent, type FormEvent } from "react";
import { confirm } from "../../../../frontend/src/components/ConfirmDialog";
import { type CanvasApi } from "./NetOpsCanvas";
import {
  canvasItemStylePresets,
  DRAWING_DEVICE_TYPES,
} from "./topologyDevicePalette";
import type {
  SelectedElement,
  Topology,
  TopologyCanvasItem,
  TopologyLink,
  TopologyNode,
} from "./topologyDocument";
import { resolveDragAxis } from "./topologyDragSnap";
import {
  nextFreeInterface,
  occupiedInterfaces,
} from "./topologyInterfaceAllocation";

export type useTopologyDeviceCommandsPorts = {
  activeTopology: Topology | null;
  canvasApiRef: import("react").MutableRefObject<CanvasApi | null>;
  gridSnapEnabled: boolean;
  linkForm: {
    source_interface: string;
    target_interface: string;
    kind: "physical" | "logical";
    label: string;
    show_description: boolean;
    status: "unknown" | "up" | "down";
    speed: string;
    vlan: string;
    medium: string;
    subnet: string;
  };
  manualNodeName: string;
  manualNodeType: string;
  nodeLabelById: Map<string, string>;
  pendingConnection: { source: string; target: string } | null;
  pushState: (next: Topology) => void;
  resetLinkForm: (sourceId?: string, targetId?: string) => void;
  setArmedNodeType: import("react").Dispatch<
    import("react").SetStateAction<string | null>
  >;
  setCanvasMode: import("react").Dispatch<
    import("react").SetStateAction<"select" | "connect">
  >;
  setIsInspectorOpen: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setManualNodeName: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setNotice: (notice: string, ok?: boolean) => void;
  setPendingConnection: import("react").Dispatch<
    import("react").SetStateAction<{ source: string; target: string } | null>
  >;
  setSelectedElement: import("react").Dispatch<
    import("react").SetStateAction<SelectedElement>
  >;
  setShowManualNodeModal: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
};

export function useTopologyDeviceCommands({
  activeTopology,
  canvasApiRef,
  gridSnapEnabled,
  linkForm,
  manualNodeName,
  manualNodeType,
  nodeLabelById,
  pendingConnection,
  pushState,
  resetLinkForm,
  setArmedNodeType,
  setCanvasMode,
  setIsInspectorOpen,
  setManualNodeName,
  setNotice,
  setPendingConnection,
  setSelectedElement,
  setShowManualNodeModal,
}: useTopologyDeviceCommandsPorts) {
  const openLinkComposer = useCallback(
    (sourceId?: string, targetId?: string) => {
      const availableIds =
        activeTopology?.nodes.map((node) => node.node_id) || [];
      if (availableIds.length < 2) {
        setNotice("请先将至少两台设备加入画布，再建立链路", false);
        return;
      }
      const source =
        sourceId && availableIds.includes(sourceId)
          ? sourceId
          : availableIds[0];
      const target =
        targetId && targetId !== source && availableIds.includes(targetId)
          ? targetId
          : availableIds.find((id) => id !== source) || "";
      if (!target) return;
      setPendingConnection({ source, target });
      resetLinkForm(source, target);
    },
    [activeTopology, resetLinkForm, setNotice],
  );

  // Save new link from pending connection
  const handleSaveLink = (e: FormEvent) => {
    e.preventDefault();
    if (!activeTopology || !pendingConnection) return;

    // 留空时也不能退回写死的默认口 —— 那样第二条链路又会拿到同一个口。
    const sourceInterface =
      linkForm.source_interface.trim() ||
      nextFreeInterface(activeTopology.links, pendingConnection.source);
    const targetInterface =
      linkForm.target_interface.trim() ||
      nextFreeInterface(activeTopology.links, pendingConnection.target, 0);
    // 自动分配只能管住默认值，管不住手填。一台设备同一个口挂两条链路，物理上
    // 说不通，而且正是图上那两个一模一样的标签的来源 —— 提示，但不拦。
    const clashes: string[] = [];
    if (
      occupiedInterfaces(activeTopology.links, pendingConnection.source).has(
        sourceInterface,
      )
    ) {
      clashes.push(
        `${nodeLabelById.get(pendingConnection.source) || "源端"} 的 ${sourceInterface}`,
      );
    }
    if (
      occupiedInterfaces(activeTopology.links, pendingConnection.target).has(
        targetInterface,
      )
    ) {
      clashes.push(
        `${nodeLabelById.get(pendingConnection.target) || "对端"} 的 ${targetInterface}`,
      );
    }

    const newLink: TopologyLink = {
      link_id: `link-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      source_node_id: pendingConnection.source,
      source_interface: sourceInterface,
      target_node_id: pendingConnection.target,
      target_interface: targetInterface,
      kind: linkForm.kind,
      label: linkForm.label.trim() || undefined,
      metadata: {
        speed: linkForm.speed.trim() || undefined,
        vlan: linkForm.vlan.trim() || undefined,
        medium: linkForm.medium.trim() || undefined,
        subnet: linkForm.subnet.trim() || undefined,
        show_description: linkForm.show_description || undefined,
      },
      source: "manual",
      status: linkForm.status,
    };

    pushState({
      ...activeTopology,
      links: [...activeTopology.links, newLink],
    });
    setPendingConnection(null);
    setNotice(
      clashes.length
        ? `拓扑链路已创建，但 ${clashes.join("、")} 已经被其他链路占用，请确认接口是否填重了`
        : "拓扑链路已创建",
      clashes.length === 0,
    );
  };

  // Delete node from topology
  const handleRemoveNode = useCallback(
    async (nodeId: string) => {
      if (!activeTopology) return;
      const node = activeTopology.nodes.find((item) => item.node_id === nodeId);
      const devName = node?.display_name || nodeId;

      const confirmed = await confirm({
        title: "从拓扑中移除节点",
        body: `将删除图纸设备“${devName}”及其连线。`,
        confirmLabel: "从拓扑移除",
        destructive: true,
      });
      if (!confirmed) return;

      const nextNodes = activeTopology.nodes.filter(
        (n) => n.node_id !== nodeId,
      );
      const groupCounts = new Map<string, number>();
      for (const n of nextNodes) {
        if (n.lock_group)
          groupCounts.set(
            n.lock_group,
            (groupCounts.get(n.lock_group) || 0) + 1,
          );
      }
      const cleanedNodes = nextNodes.map((n) =>
        n.lock_group && (groupCounts.get(n.lock_group) || 0) < 2
          ? { ...n, lock_group: undefined }
          : n,
      );
      const nextLinks = activeTopology.links.filter(
        (l) => l.source_node_id !== nodeId && l.target_node_id !== nodeId,
      );

      pushState({
        ...activeTopology,
        nodes: cleanedNodes,
        links: nextLinks,
      });
      setSelectedElement(null);
      setNotice(`已从图纸移除“${devName}”`);
    },
    [activeTopology, pushState, setNotice],
  );

  // Delete link from topology
  const handleRemoveLink = useCallback(
    async (linkId: string) => {
      if (!activeTopology) return;
      const confirmed = await confirm({
        title: "删除拓扑链路",
        body: "确定要从当前拓扑中删除该链路吗？",
        confirmLabel: "删除链路",
        destructive: true,
      });
      if (!confirmed) return;

      const nextLinks = activeTopology.links.filter(
        (l) => l.link_id !== linkId,
      );
      pushState({
        ...activeTopology,
        links: nextLinks,
      });
      setSelectedElement(null);
      setNotice("链路已删除");
    },
    [activeTopology, pushState, setNotice],
  );

  const handleAddManualNode = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (!activeTopology) return;
      const name = manualNodeName.trim();
      if (!name) return;
      const nodeCount = activeTopology.nodes.length;
      const node: TopologyNode = {
        node_id: `node_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        device_type: manualNodeType,
        display_name: name,
        x: 160 + (nodeCount % 4) * 200,
        y: 140 + Math.floor(nodeCount / 4) * 160,
      };
      pushState({ ...activeTopology, nodes: [...activeTopology.nodes, node] });
      setShowManualNodeModal(false);
      setManualNodeName("");
      setNotice(`已在画布创建图纸设备“${name}”。可继续连线或添加标注。`);
    },
    [activeTopology, manualNodeName, manualNodeType, pushState, setNotice],
  );

  /**
   * Put a drawing device down at a point the user chose.
   *
   * The name is generated rather than asked for. In eNSP and HCL a freshly
   * dropped router is `Router1` and stays that way until you rename it, which
   * is the right default for sketching: the cost of a wrong name is one edit,
   * whereas the cost of a mandatory dialog is that you cannot see the topology
   * you are building. Renaming and linking a registered asset both live in the
   * node inspector, which opens on placement.
   *
   * Placement uses the same opt-in gentle grid attraction as dragging.
   * Showing the grid alone never changes the pointer's landing coordinates.
   */
  const placeDrawingNode = useCallback(
    (deviceType: string, position: { x: number; y: number }) => {
      if (!activeTopology) return;
      const snap = (value: number) =>
        resolveDragAxis(
          value,
          canvasApiRef.current?.getViewport().zoom || 1,
          [],
          null,
          gridSnapEnabled,
        ).position;
      const label =
        DRAWING_DEVICE_TYPES.find((type) => type.value === deviceType)?.label ||
        "图纸设备";
      // Highest existing index + 1, so deleting 路由器2 and adding another does
      // not produce a second 路由器2.
      const taken = new Set(
        activeTopology.nodes
          .map((node) => node.display_name || "")
          .filter((name) => name.startsWith(label))
          .map((name) => Number.parseInt(name.slice(label.length), 10))
          .filter((index) => Number.isFinite(index)),
      );
      let index = 1;
      while (taken.has(index)) index += 1;

      const node: TopologyNode = {
        node_id: `node_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        device_type: deviceType,
        display_name: `${label}${index}`,
        x: snap(position.x),
        y: snap(position.y),
      };
      pushState({ ...activeTopology, nodes: [...activeTopology.nodes, node] });
      setSelectedElement({ type: "node", nodeId: node.node_id });
      setNotice(
        `已放入“${node.display_name}”。可继续点击画布连续放置，按 Esc 或右键退出。`,
      );
    },
    [activeTopology, gridSnapEnabled, pushState, setNotice],
  );

  const handleCloneNode = useCallback(
    (nodeId: string) => {
      if (!activeTopology) return;
      const sourceNode = activeTopology.nodes.find((n) => n.node_id === nodeId);
      if (!sourceNode) return;
      const label =
        DRAWING_DEVICE_TYPES.find((t) => t.value === sourceNode.device_type)
          ?.label || "设备";
      const taken = new Set(
        activeTopology.nodes
          .map((node) => node.display_name || "")
          .filter((name) => name.startsWith(label))
          .map((name) => Number.parseInt(name.slice(label.length), 10))
          .filter((index) => Number.isFinite(index)),
      );
      let index = 1;
      while (taken.has(index)) index += 1;

      const snap = (v: number) =>
        resolveDragAxis(
          v,
          canvasApiRef.current?.getViewport().zoom || 1,
          [],
          null,
          gridSnapEnabled,
        ).position;
      const newNode: TopologyNode = {
        node_id: `node_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        device_type: sourceNode.device_type,
        display_name: `${label}${index}`,
        x: snap(sourceNode.x + 64),
        y: snap(sourceNode.y + 64),
      };
      pushState({
        ...activeTopology,
        nodes: [...activeTopology.nodes, newNode],
      });
      setSelectedElement({ type: "node", nodeId: newNode.node_id });
      setNotice(`已克隆生成“${newNode.display_name}”`);
    },
    [activeTopology, gridSnapEnabled, pushState, setNotice],
  );

  const handleFastConnect = useCallback(
    (source: string, target: string) => {
      if (!activeTopology) return;
      if (source === target) return;
      const links = activeTopology.links || [];
      const sourceInterface = nextFreeInterface(links, source);
      const targetInterface = nextFreeInterface(links, target, 0);

      const newLink: TopologyLink = {
        link_id: `link-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        source_node_id: source,
        source_interface: sourceInterface,
        target_node_id: target,
        target_interface: targetInterface,
        kind: "physical",
        source: "manual",
        status: "unknown",
      };

      const nextLinks = [...links, newLink];
      pushState({ ...activeTopology, links: nextLinks });
      setSelectedElement({ type: "link", linkId: newLink.link_id });
      setCanvasMode("select");

      const sLabel = nodeLabelById.get(source) || source;
      const tLabel = nodeLabelById.get(target) || target;
      setNotice(
        `已连接 ${sLabel}(${sourceInterface}) ↔ ${tLabel}(${targetInterface})，已自动切换回选择模式`,
      );
    },
    [activeTopology, nextFreeInterface, nodeLabelById, pushState, setNotice],
  );

  const disarmNodeType = useCallback(() => setArmedNodeType(null), []);

  const handleAddCanvasItem = useCallback(
    (kind: TopologyCanvasItem["kind"]) => {
      if (!activeTopology) return;
      const itemCount = (activeTopology.canvas_items || []).length;
      const defaults =
        kind === "text"
          ? { text: "文本说明", width: 180, height: 36 }
          : kind === "ellipse"
            ? { text: "业务域", width: 200, height: 110 }
            : { text: "区域说明", width: 240, height: 130 };
      const item: TopologyCanvasItem = {
        item_id: `canvas_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        kind,
        ...defaults,
        style: { ...canvasItemStylePresets.teal.style },
        x: 180 + (itemCount % 3) * 120,
        y: 100 + (itemCount % 3) * 80,
      };
      pushState({
        ...activeTopology,
        canvas_items: [...(activeTopology.canvas_items || []), item],
      });
      setSelectedElement({ type: "canvas_item", itemId: item.item_id });
      setIsInspectorOpen(true);
      setCanvasMode("select");
      setNotice(
        kind === "text"
          ? "已添加文本框，可在右侧编辑内容并拖动定位"
          : "已添加图纸形状，可在右侧编辑说明并拖动定位",
      );
    },
    [activeTopology, pushState, setNotice],
  );

  const handleTypeDragStart = useCallback(
    (event: DragEvent<HTMLElement>, deviceType: string) => {
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("application/x-lzcore-node-type", deviceType);
      event.dataTransfer.setData("text/plain", deviceType);
    },
    [],
  );
  return {
    handleRemoveLink,
    handleRemoveNode,
    handleCloneNode,
    handleTypeDragStart,
    handleAddCanvasItem,
    handleFastConnect,
    placeDrawingNode,
    disarmNodeType,
    openLinkComposer,
    handleSaveLink,
    handleAddManualNode,
  };
}
