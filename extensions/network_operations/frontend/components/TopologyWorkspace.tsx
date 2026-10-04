import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TOPOLOGY_API_BASE as base } from "./topologyApi";
import { TopologyCanvasStage } from "./TopologyCanvasStage";
import { TopologyConflictDialog } from "./TopologyConflictDialog";
import { TopologyContextMenu } from "./TopologyContextMenu";
import { TopologyEmptyCreateDialog } from "./TopologyEmptyCreateDialog";
import { nextFreeInterface } from "./topologyInterfaceAllocation";
import { TopologyLibrary } from "./TopologyLibrary";
import { TopologyLinkDialog } from "./TopologyLinkDialog";
import { TopologyManualNodeDialog } from "./TopologyManualNodeDialog";
import { TopologyMetadataDialog } from "./TopologyMetadataDialog";
import { TopologyPresentationToolbar } from "./TopologyPresentationToolbar";
import type { ReferenceLine } from "./TopologyReferenceLines";
import { TopologyRegionDialog } from "./TopologyRegionDialog";
import { regionBounds } from "./topologyRegions";
import { TopologyRevisionDialog } from "./TopologyRevisionDialog";
import { RevisionDiff, TopologyRevision } from "./topologyRevisionModel";
import { TopologyShortcutHelp } from "./TopologyShortcutHelp";
import { useTopologyCollaboration } from "./useTopologyCollaboration";
import { useTopologyDeviceCommands } from "./useTopologyDeviceCommands";
import { useTopologyDocumentState } from "./useTopologyDocumentState";
import { useTopologyExport } from "./useTopologyExport";
import { useTopologyInspector } from "./useTopologyInspector";
import { useTopologyKeyboard } from "./useTopologyKeyboard";
import { useTopologyMetadata } from "./useTopologyMetadata";
import { useTopologyPersistence } from "./useTopologyPersistence";
import { useTopologyPresentation } from "./useTopologyPresentation";
import { useTopologyRegionCommands } from "./useTopologyRegionCommands";
import { useTopologyRevisions } from "./useTopologyRevisions";
import { useTopologySelectionCommands } from "./useTopologySelectionCommands";
import { useTopologyViews } from "./useTopologyViews";
export { ZONE_COLOR_PRESETS } from "./topologyDocument";
export type {
  SelectedElement,
  Topology,
  TopologyCanvasItem,
  TopologyGroup,
  TopologyLink,
  TopologyLinkStyle,
  TopologyNode,
} from "./topologyDocument";
export {
  nextFreeInterface,
  occupiedInterfaces,
} from "./topologyInterfaceAllocation";
export { DeviceTypeIcon } from "./TopologyItemControls";
// 图标全部走平台统一出口 components/Icon.tsx —— 这是全站唯一的 Phosphor
// 门面，直接 import "@phosphor-icons/react" 会让扩展页与平台图标语义脱钩。
import { apiRequest } from "../../../../frontend/src/api/client";
import {
  IconBranch,
  IconPlus,
  IconRefresh,
  IconShield,
} from "../../../../frontend/src/components/Icon";
import { Button } from "../../../../frontend/src/components/ui";
import { useNavigate } from "../../../../frontend/src/router";
import { useSessionStore } from "../../../../frontend/src/stores/session";
import { buildCanvasSelection, type CanvasSelection } from "./canvasSelection";
import { type CanvasApi, type CanvasContextTarget } from "./NetOpsCanvas";
import { type NodeOverlay } from "./nodeOverlay";
import { TopologyAgentPanel } from "./TopologyAgentPanel";
import {
  LAYOUT_PRESETS,
  layoutTopology,
  type LayoutAlgorithm,
} from "./topologyLayout";
import { resolveTopologySession } from "./TopologySessionResolver";
import "./TopologyStudio.css";

import type { Topology } from "./topologyDocument";
export const calculateZoneBounds = regionBounds;

interface TopologyWorkspaceProps {
  workspaceId: string;
  topologies: Topology[];
  loadError: string;
  onReload: () => Promise<void>;
  /** ok 省略或为 true 表示成功提示（绿色）；显式传 false 表示失败（警告黄）。 */
  setNotice: (notice: string, ok?: boolean) => void;
  busy: boolean;
}

export default function TopologyWorkspace({
  workspaceId,
  topologies,
  loadError,
  onReload,
  setNotice,
  busy,
}: TopologyWorkspaceProps) {
  const requestedTopologyId =
    typeof window === "undefined"
      ? ""
      : new URLSearchParams(window.location.search).get("topology_id") || "";
  const [selectedTopologyId, setSelectedTopologyId] = useState<string>(() => {
    if (
      requestedTopologyId &&
      topologies.some((item) => item.topology_id === requestedTopologyId)
    )
      return requestedTopologyId;
    return topologies[0]?.topology_id || "";
  });

  useEffect(() => {
    if (
      requestedTopologyId &&
      topologies.some((item) => item.topology_id === requestedTopologyId)
    ) {
      setSelectedTopologyId(requestedTopologyId);
      return;
    }
    if (!selectedTopologyId && topologies.length > 0) {
      setSelectedTopologyId(topologies[0].topology_id);
    } else if (
      selectedTopologyId &&
      !topologies.some((t) => t.topology_id === selectedTopologyId)
    ) {
      setSelectedTopologyId(topologies[0]?.topology_id || "");
    }
  }, [requestedTopologyId, topologies, selectedTopologyId]);

  const currentTopology = useMemo(() => {
    return topologies.find((t) => t.topology_id === selectedTopologyId) || null;
  }, [topologies, selectedTopologyId]);
  const [nodeOverlays, setNodeOverlays] = useState<NodeOverlay[]>([]);
  const [bindableDevices, setBindableDevices] = useState<
    Array<{ device_id: string; name: string; host: string }>
  >([]);
  const [overlayRevision, setOverlayRevision] = useState(0);
  const [bindChoice, setBindChoice] = useState("");
  const [binding, setBinding] = useState(false);
  const [viewOverlayNodeId, setViewOverlayNodeId] = useState("");

  useEffect(() => {
    const topologyId = currentTopology?.topology_id;
    if (!topologyId) {
      setNodeOverlays([]);
      return;
    }
    let cancelled = false;
    void apiRequest<{ overlays: NodeOverlay[] }>({
      method: "GET",
      url: `${base}/topologies/${topologyId}/overlay`,
      params: { workspace_id: workspaceId },
    })
      .then((overlayResult) => {
        if (cancelled) return;
        setNodeOverlays(overlayResult.overlays || []);
      })
      .catch(() => {
        if (!cancelled) setNodeOverlays([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentTopology?.topology_id, overlayRevision, workspaceId]);

  const {
    setHistory,
    setFuture,
    setDrawingActivities,
    setHighlightedIds,
    activeTopology,
    activeTopologyRef,
    adoptServerTopology,
    highlightedIds,
    revisionRef,
    saveStatusRef,
    saveTimerRef,
    serverTopologyRef,
    serverVersionsRef,
    setActiveTopology,
    setConflict,
    setSaveStatus,
    setShowConflict,
    conflict,
    drawingActivities,
    future,
    history,
    saveChainRef,
    saveFailureRef,
    workspaceIdRef,
    saveStatus,
    showConflict,
  } = useTopologyDocumentState({ currentTopology, setNotice, workspaceId });

  // Inspector & selection
  const canvasApiRef = useRef<CanvasApi | null>(null);
  const {
    setSelectedElement,
    setIsInspectorOpen,
    selectedElement,
    updatePopoverAnchor,
    isPinned,
    setIsPinned,
    setIsDragged,
    isInspectorOpen,
    viewportRef,
    inspectorRef,
    isDragged,
    popoverPlacement,
    isDragging,
    popoverStyle,
    handleHeaderMouseDown,
  } = useTopologyInspector({ canvasApiRef });
  useEffect(() => {
    setHistory([]);
    setFuture([]);
    setDrawingActivities([]);
    setHighlightedIds([]);
    setSelectedElement(null);
  }, [selectedTopologyId, workspaceId]);
  const [showAgent, setShowAgent] = useState(false);
  // The board is primary. The tray opens intentionally instead of consuming
  // canvas width for every user.
  const [showLibrary, setShowLibrary] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const {
    compactMode,
    studioContainerRef,
    isFullscreen,
    handleToggleFullscreen,
    handleToggleWhiteboard,
    setCompactMode,
    whiteboardActive,
    setWhiteboardActive,
  } = useTopologyPresentation({ canvasApiRef });

  const [workspaceMode, setWorkspaceMode] = useState<"view" | "edit">(() => {
    try {
      return (
        (localStorage.getItem("lzcore_topology_workspace_mode") as
          | "view"
          | "edit") || "edit"
      );
    } catch {
      return "edit";
    }
  });

  const handleSetWorkspaceMode = useCallback((mode: "view" | "edit") => {
    setWorkspaceMode(mode);
    try {
      localStorage.setItem("lzcore_topology_workspace_mode", mode);
    } catch {
      // ignore
    }
    if (mode === "view") {
      canvasApiRef.current?.clearSelection();
      setSelectedElement(null);
      setCanvasSelectedElementIds([]);
      setIsInspectorOpen(false);
      setArmedNodeType(null);
      setContextMenu(null);
    }
  }, []);

  useEffect(() => {
    if (workspaceMode !== "edit" || selectedElement?.type !== "node") return;
    let cancelled = false;
    void apiRequest<{
      devices: Array<{ device_id: string; name: string; host: string }>;
    }>({
      method: "GET",
      url: `${base}/devices`,
      params: { workspace_id: workspaceId },
    })
      .then((deviceResult) => {
        if (cancelled) return;
        setBindableDevices(deviceResult.devices || []);
      })
      .catch(() => {
        if (!cancelled) setBindableDevices([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceMode, selectedElement?.type, workspaceId]);

  const navigate = useNavigate();

  const handleOpenWorkbenchChat = useCallback(async () => {
    if (!activeTopology) return;
    try {
      const targetSessionId = await resolveTopologySession(
        workspaceId,
        activeTopology,
      );
      useSessionStore.getState().setCurrentSession(targetSessionId);
    } catch (err) {
      console.error("Failed to resolve topology session", err);
    }
    navigate("/workbench");
  }, [activeTopology, navigate, workspaceId]);

  const [showEditbar, setShowEditbar] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("lzcore_topology_show_editbar");
      return saved !== null ? saved === "true" : true;
    } catch {
      return true;
    }
  });
  const [canvasMode, setCanvasMode] = useState<"select" | "connect">("select");

  useEffect(() => {
    try {
      localStorage.setItem("lzcore_topology_show_editbar", String(showEditbar));
    } catch {
      // ignore
    }
    const timer = window.setTimeout(() => {
      canvasApiRef.current?.resize();
    }, 40);
    return () => window.clearTimeout(timer);
  }, [showEditbar, focusMode, showLibrary, showAgent, workspaceMode]);
  const [gridEnabled, setGridEnabled] = useState(true);
  const [gridSnapEnabled, setGridSnapEnabled] = useState(false);
  const [smartGuidesEnabled, setSmartGuidesEnabled] = useState(true);
  const [alignmentReferenceId, setAlignmentReferenceId] = useState<
    string | null
  >(null);
  const referenceKey = activeTopology
    ? `lzcore_reference_lines:${workspaceId}:${activeTopology.topology_id}`
    : "";
  const [referenceByKey, setReferenceByKey] = useState<
    Record<string, ReferenceLine[]>
  >({});
  useEffect(() => {
    setAlignmentReferenceId(null);
    if (!referenceKey) return;
    try {
      const raw: unknown = JSON.parse(
        localStorage.getItem(referenceKey) || "[]",
      );
      const lines = Array.isArray(raw)
        ? raw
            .filter(
              (line): line is ReferenceLine =>
                line &&
                typeof line.id === "string" &&
                ["x", "y"].includes(line.axis) &&
                Number.isFinite(line.position) &&
                typeof line.locked === "boolean",
            )
            .slice(0, 100)
        : [];
      setReferenceByKey((value) => ({ ...value, [referenceKey]: lines }));
    } catch {
      setReferenceByKey((value) => ({ ...value, [referenceKey]: [] }));
    }
  }, [referenceKey]);
  const referenceLines = referenceByKey[referenceKey] || [];
  const changeReferenceLines = (lines: ReferenceLine[]) => {
    if (!referenceKey) return;
    setReferenceByKey((value) => ({ ...value, [referenceKey]: lines }));
    try {
      localStorage.setItem(referenceKey, JSON.stringify(lines));
    } catch {
      setNotice("参考线已调整，但当前环境无法保存本机编辑偏好", false);
    }
  };
  const [canvasSelectedElementIds, setCanvasSelectedElementIds] = useState<
    string[]
  >([]);
  const [showInterfaces, setShowInterfaces] = useState(true);
  const [showObservation, setShowObservation] = useState(true);
  // Filters dim rather than hide, so the diagram never turns into a different
  // drawing than the one being discussed.
  // Imperative canvas handle (export / focus / viewport) and transient canvas
  // UI: right-click menu and keyboard help.
  const [contextMenu, setContextMenu] = useState<CanvasContextTarget | null>(
    null,
  );
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [layoutBusy, setLayoutBusy] = useState(false);
  /**
   * What the Agent is told the user is looking at. The canvas selection is
   * authoritative: box-selecting five devices and asking about "these" used
   * to send the whole topology, because this came from the inspector alone.
   */
  const canvasSelection: CanvasSelection = useMemo(
    () =>
      buildCanvasSelection(
        activeTopology,
        canvasSelectedElementIds,
        selectedElement,
      ),
    [activeTopology, canvasSelectedElementIds, selectedElement],
  );

  const { integrateRemoteDrawing } = useTopologyCollaboration({
    activeTopologyRef,
    adoptServerTopology,
    highlightedIds,
    revisionRef,
    saveStatusRef,
    saveTimerRef,
    serverTopologyRef,
    serverVersionsRef,
    setActiveTopology,
    setConflict,
    setDrawingActivities,
    setFuture,
    setHighlightedIds,
    setHistory,
    setNotice,
    setSaveStatus,
    setShowConflict,
  });

  // Modals
  const [topologyModalMode, setTopologyModalMode] = useState<
    "create" | "edit" | null
  >(null);
  const [topologyNameInput, setTopologyNameInput] = useState("");
  const [topologyDescInput, setTopologyDescInput] = useState("");

  const [showCreateZoneModal, setShowCreateZoneModal] = useState(false);
  const [zoneNameInput, setZoneNameInput] = useState("");
  const [zoneColorIndex, setZoneColorIndex] = useState(0);
  const [showManualNodeModal, setShowManualNodeModal] = useState(false);
  const [manualNodeName, setManualNodeName] = useState("");
  const [manualNodeType, setManualNodeType] = useState("switch");
  /**
   * A drawing-device type the user has picked and not yet placed.
   *
   * The palette is modal in the way eNSP and HCL are: choosing a type arms the
   * canvas, and the next click on empty sheet puts the device down. Holding it
   * as state rather than as a one-shot event is what lets the canvas show that
   * it is waiting for a click.
   */
  const [armedNodeType, setArmedNodeType] = useState<string | null>(null);

  // Revision history: structural snapshots, never layout-only saves.
  const [showRevisions, setShowRevisions] = useState(false);
  const [revisions, setRevisions] = useState<TopologyRevision[]>([]);
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [revisionDiff, setRevisionDiff] = useState<RevisionDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [restoringId, setRestoringId] = useState("");

  const [pendingConnection, setPendingConnection] = useState<{
    source: string;
    target: string;
  } | null>(null);
  const [linkForm, setLinkForm] = useState({
    source_interface: "GE0/1",
    target_interface: "GE0/0",
    kind: "physical" as "physical" | "logical",
    label: "",
    show_description: false,
    status: "unknown" as "unknown" | "up" | "down",
    speed: "",
    vlan: "",
    medium: "",
    subnet: "",
  });

  const resetLinkForm = useCallback(
    (sourceId?: string, targetId?: string) => {
      const links = activeTopology?.links || [];
      setLinkForm({
        source_interface: nextFreeInterface(links, sourceId),
        target_interface: nextFreeInterface(links, targetId, 0),
        kind: "physical",
        label: "",
        show_description: false,
        status: "unknown",
        speed: "",
        vlan: "",
        medium: "",
        subnet: "",
      });
    },
    [activeTopology?.links],
  );

  const nodeLabelById = useMemo(
    () =>
      new Map(
        (activeTopology?.nodes || []).map((node) => [
          node.node_id,
          node.display_name || node.node_id,
        ]),
      ),
    [activeTopology?.nodes],
  );

  useEffect(() => {
    if (selectedElement && !showAgent) setIsInspectorOpen(true);
  }, [selectedElement, showAgent]);

  /**
   * Someone else saved this drawing while we were editing it.
   *
   * Refusing the save and leaving the canvas dirty is a dead end: the next
   * edit conflicts again and the user has no way forward. Fetch their version,
   * merge it against the last confirmed base, and let the user decide.
   */
  const {
    pushState,
    executeSave,
    handleRedo,
    handleUndo,
    prepareDrawing,
    undoDrawingChange,
    applyConflictChoice,
  } = useTopologyPersistence({
    activeTopology,
    activeTopologyRef,
    adoptServerTopology,
    conflict,
    drawingActivities,
    future,
    history,
    integrateRemoteDrawing,
    onReload,
    revisionRef,
    saveChainRef,
    saveFailureRef,
    saveStatusRef,
    saveTimerRef,
    serverTopologyRef,
    serverVersionsRef,
    setActiveTopology,
    setConflict,
    setDrawingActivities,
    setFuture,
    setHistory,
    setNotice,
    setSaveStatus,
    setShowConflict,
    workspaceId,
    workspaceIdRef,
  });

  const {
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
  } = useTopologyDeviceCommands({
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
  });

  const {
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
  } = useTopologyRegionCommands({
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
  });

  const { exportCanvas } = useTopologyExport({
    activeTopology,
    compactMode,
    setNotice,
    showInterfaces,
  });

  /**
   * Deep link. A diagram that cannot be linked to cannot be shared, attached
   * to a ticket, or restored after a refresh.
   */
  const {
    applyBookmark,
    bookmarks,
    removeBookmark,
    saveBookmark,
    currentBookmarkName,
  } = useTopologyViews({
    activeTopology,
    canvasApiRef,
    selectedElement,
    selectedTopologyId,
    setNotice,
    setSelectedElement,
    setSelectedTopologyId,
    topologies,
    workspaceId,
  });

  // The menu is transient: any gesture outside it dismisses it.
  useEffect(() => {
    if (!contextMenu) return;
    const handleDown = (event: MouseEvent) => {
      if (
        (event.target as HTMLElement | null)?.closest?.(".canvas-context-menu")
      ) {
        return;
      }
      setContextMenu(null);
    };
    window.addEventListener("mousedown", handleDown, true);
    window.addEventListener("wheel", handleDown, {
      capture: true,
      passive: true,
    });
    window.addEventListener("blur", () => setContextMenu(null));
    return () => {
      window.removeEventListener("mousedown", handleDown, true);
      window.removeEventListener("wheel", handleDown, true);
      window.removeEventListener("blur", () => setContextMenu(null));
    };
  }, [contextMenu]);

  const {
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
  } = useTopologySelectionCommands({
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
  });

  /**
   * Grouped menus close outside, on completed actions or Escape; settings
   * and reference editing remain open. Opening a peer menu closes the old one.
   */
  useTopologyKeyboard({
    activeTopologyRef,
    canvasApiRef,
    canvasSelectedElementIds,
    deleteSelection,
    executeSave,
    handleCloneNode,
    handleRedo,
    handleSetWorkspaceMode,
    handleUndo,
    nudgeSelected,
    removeSelectedObjects,
    selectedElement,
    setArmedNodeType,
    setCanvasMode,
    setContextMenu,
    setFocusMode,
    setGridSnapEnabled,
    setIsInspectorOpen,
    setSelectedElement,
    setShowEditbar,
    setShowInterfaces,
    setShowShortcutHelp,
    workspaceMode,
  });

  const handleAutoLayout = useCallback(
    async (algorithm: LayoutAlgorithm = "hierarchy-h") => {
      if (!activeTopology || activeTopology.nodes.length < 2) {
        setNotice("至少需要两台画布设备才可自动排布", false);
        return;
      }
      setLayoutBusy(true);
      try {
        const result = await layoutTopology(activeTopology, algorithm);
        if (activeTopologyRef.current !== activeTopology) {
          setNotice("图纸已变化，请重新排布", false);
          return;
        }
        pushState(result);
        const preset = LAYOUT_PRESETS.find((item) => item.id === algorithm);
        setNotice(
          result.layout_issues?.length
            ? result.layout_issues.join("；")
            : `已按「${preset?.label || "分层"}」排布，区域按绑定成员布局`,
        );
      } catch {
        setNotice("自动排布失败，原图保持不变", false);
      } finally {
        setLayoutBusy(false);
      }
    },
    [activeTopology, pushState, setNotice],
  );

  // Create / Edit topology
  const { handleSaveTopologyMeta, handleDeleteTopology } = useTopologyMetadata({
    activeTopology,
    onReload,
    pushState,
    setNotice,
    setSelectedElement,
    setSelectedTopologyId,
    setTopologyDescInput,
    setTopologyModalMode,
    setTopologyNameInput,
    topologyDescInput,
    topologyModalMode,
    topologyNameInput,
    workspaceId,
  });

  /**
   * Revision history. Only structural edits are stored, so this list reads as
   * "the decisions made on this drawing" rather than every mouse-up.
   */
  const {
    handleOpenRevisions,
    handleAgentCompleted,
    restoreLayout,
    setRestoreLayout,
    handleDiffRevision,
    handleRestoreRevision,
  } = useTopologyRevisions({
    activeTopology,
    activeTopologyRef,
    adoptServerTopology,
    currentTopology,
    integrateRemoteDrawing,
    revisions,
    saveChainRef,
    saveStatusRef,
    selectedTopologyId,
    setDiffLoading,
    setFuture,
    setHistory,
    setNotice,
    setRestoringId,
    setRevisionDiff,
    setRevisions,
    setRevisionsLoading,
    setShowRevisions,
    workspaceId,
    workspaceIdRef,
  });

  // Node selection inspector helpers
  const selectedNode = useMemo(() => {
    if (selectedElement?.type !== "node" || !activeTopology) return null;
    return (
      activeTopology.nodes.find((n) => n.node_id === selectedElement.nodeId) ||
      null
    );
  }, [selectedElement, activeTopology]);
  const selectedNodeId =
    selectedElement?.type === "node" ? selectedElement.nodeId : "";
  const savedBindId =
    nodeOverlays.find((item) => item.node_id === selectedNodeId)
      ?.device_state === "bound"
      ? nodeOverlays.find((item) => item.node_id === selectedNodeId)
          ?.device_id || ""
      : "";
  useEffect(() => {
    setBindChoice(savedBindId);
  }, [savedBindId, selectedNodeId]);

  // Edge selection inspector helpers
  const selectedLink = useMemo(() => {
    if (selectedElement?.type !== "link" || !activeTopology) return null;
    return (
      activeTopology.links.find((l) => l.link_id === selectedElement.linkId) ||
      null
    );
  }, [selectedElement, activeTopology]);

  const selectedCanvasItem = useMemo(() => {
    if (selectedElement?.type !== "canvas_item" || !activeTopology) return null;
    return (
      (activeTopology.canvas_items || []).find(
        (item) => item.item_id === selectedElement.itemId,
      ) || null
    );
  }, [selectedElement, activeTopology]);

  if (loadError) {
    return (
      <div className="topology-empty-state" role="alert">
        <div className="topology-empty-card topology-load-error">
          <div className="topology-empty-icon">
            <IconShield size={36} />
          </div>
          <h3>图纸加载失败</h3>
          <p>{loadError || "无法读取图纸列表。请刷新后重试。"}</p>
          <Button
            variant="primary"
            icon={<IconRefresh size={14} />}
            onClick={() => void onReload()}
          >
            重新加载
          </Button>
        </div>
      </div>
    );
  }

  if (!topologies.length) {
    return (
      <div className="topology-empty-state">
        <div className="topology-empty-card">
          <div className="topology-empty-icon">
            <IconBranch size={36} />
          </div>
          <h3>尚未创建图纸</h3>
          <p>
            用符号、连线、图元和分组绘制网络结构，也可以让绘图 Skill
            帮你完成。图纸不连接真实设备。
          </p>
          <Button
            variant="primary"
            icon={<IconPlus size={14} />}
            onClick={() => {
              setTopologyModalMode("create");
              setTopologyNameInput("");
              setTopologyDescInput("");
            }}
          >
            创建第一张图纸
          </Button>
        </div>

        {topologyModalMode === "create" && (
          <TopologyEmptyCreateDialog
            busy={busy}
            handleSaveTopologyMeta={handleSaveTopologyMeta}
            setTopologyDescInput={setTopologyDescInput}
            setTopologyModalMode={setTopologyModalMode}
            setTopologyNameInput={setTopologyNameInput}
            topologyDescInput={topologyDescInput}
            topologyNameInput={topologyNameInput}
          />
        )}
      </div>
    );
  }

  // A dedicated route mounts before the parallel catalogue request completes.
  // During the one render between `topologies` arriving and the selected
  // topology state synchronising, never hand a null graph to the renderer.
  if (!activeTopology) {
    return (
      <div className="topology-empty-state" role="status" aria-live="polite">
        <div className="topology-empty-card">
          <div className="topology-empty-icon">
            <IconRefresh size={36} />
          </div>
          <h3>正在打开网络拓扑</h3>
          <p>正在加载图纸。</p>
        </div>
      </div>
    );
  }

  const pinButton = (
    <Button
      size="sm"
      variant={isPinned ? "selected" : "ghost"}
      aria-pressed={isPinned}
      title={
        isPinned
          ? "已固定在右上角 (点击切换为跟随设备)"
          : "固定到右上角 (避免遮挡画布设备)"
      }
      aria-label={isPinned ? "已固定在右上角" : "固定到右上角"}
      onClick={() => {
        setIsPinned((prev) => !prev);
        setIsDragged(false);
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill={isPinned ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M9.8 2.2a2 2 0 0 1 2.8 2.8l-1.4 1.4L10 10l-3 3-1.5-1.5L2 15l1.5-3.5L2 10l3-3 3.6-1.4 1.2-1.4z" />
      </svg>
    </Button>
  );

  return (
    <div
      ref={studioContainerRef}
      className={`network-topology-workspace topology-studio ${showLibrary ? "library-open" : ""} ${showAgent ? "agent-open" : ""} ${isInspectorOpen && !showAgent ? "inspector-open" : ""} ${focusMode ? "focus-mode" : ""} ${isFullscreen ? "is-fullscreen" : ""}`}
    >
      {/* 1. Left Panel: Topology selector + Device Palette + Group Palette */}
      <TopologyLibrary
        activeTopology={activeTopology}
        armedNodeType={armedNodeType}
        canvasApiRef={canvasApiRef}
        handleOpenCreateZone={handleOpenCreateZone}
        handleTypeDragStart={handleTypeDragStart}
        saveStatus={saveStatus}
        selectedElement={selectedElement}
        selectedNodes={selectedNodes}
        selectedTopologyId={selectedTopologyId}
        setArmedNodeType={setArmedNodeType}
        setCanvasMode={setCanvasMode}
        setManualNodeName={setManualNodeName}
        setManualNodeType={setManualNodeType}
        setSelectedElement={setSelectedElement}
        setSelectedTopologyId={setSelectedTopologyId}
        setShowManualNodeModal={setShowManualNodeModal}
        setTopologyDescInput={setTopologyDescInput}
        setTopologyModalMode={setTopologyModalMode}
        setTopologyNameInput={setTopologyNameInput}
        topologies={topologies}
      />

      {/* 2. Center: Canvas */}
      <TopologyCanvasStage
        activeTopology={activeTopology}
        activeTopologyRef={activeTopologyRef}
        alignmentReferenceId={alignmentReferenceId}
        applyBookmark={applyBookmark}
        applyDeviceTypeToSelection={applyDeviceTypeToSelection}
        armedNodeType={armedNodeType}
        bindableDevices={bindableDevices}
        bindChoice={bindChoice}
        binding={binding}
        bookmarks={bookmarks}
        canvasApiRef={canvasApiRef}
        canvasMode={canvasMode}
        canvasSelectedElementIds={canvasSelectedElementIds}
        changeReferenceLines={changeReferenceLines}
        compactMode={compactMode}
        disarmNodeType={disarmNodeType}
        distributeSelected={distributeSelected}
        executeSave={executeSave}
        exportCanvas={exportCanvas}
        future={future}
        gridEnabled={gridEnabled}
        gridSnapEnabled={gridSnapEnabled}
        handleAddCanvasItem={handleAddCanvasItem}
        handleAlignSelectedNodes={handleAlignSelectedNodes}
        handleAutoFitCanvasItem={handleAutoFitCanvasItem}
        handleAutoLayout={handleAutoLayout}
        handleBringCanvasItemToFront={handleBringCanvasItemToFront}
        handleCloneNode={handleCloneNode}
        handleDeleteTopology={handleDeleteTopology}
        handleFastConnect={handleFastConnect}
        handleHeaderMouseDown={handleHeaderMouseDown}
        handleJoinZone={handleJoinZone}
        handleLeaveZone={handleLeaveZone}
        handleLockSelectedNodes={handleLockSelectedNodes}
        handleNetOpsMove={handleNetOpsMove}
        handleOpenCreateZone={handleOpenCreateZone}
        handleOpenRevisions={handleOpenRevisions}
        handleOpenWorkbenchChat={handleOpenWorkbenchChat}
        handleRedo={handleRedo}
        handleRemoveCanvasItem={handleRemoveCanvasItem}
        handleRemoveLink={handleRemoveLink}
        handleRemoveNode={handleRemoveNode}
        handleSelectLockGroup={handleSelectLockGroup}
        handleSelectZoneMembers={handleSelectZoneMembers}
        handleSendCanvasItemToBack={handleSendCanvasItemToBack}
        handleSetWorkspaceMode={handleSetWorkspaceMode}
        handleToggleFullscreen={handleToggleFullscreen}
        handleToggleWhiteboard={handleToggleWhiteboard}
        handleUndo={handleUndo}
        handleUnlockNode={handleUnlockNode}
        handleUnlockSelectedNodes={handleUnlockSelectedNodes}
        hasMultiSelection={hasMultiSelection}
        highlightedIds={highlightedIds}
        history={history}
        inspectorRef={inspectorRef}
        isDragged={isDragged}
        isDragging={isDragging}
        isFullscreen={isFullscreen}
        isInspectorOpen={isInspectorOpen}
        layoutBusy={layoutBusy}
        nodeLabelById={nodeLabelById}
        nodeOverlays={nodeOverlays}
        pinButton={pinButton}
        placeDrawingNode={placeDrawingNode}
        popoverPlacement={popoverPlacement}
        popoverStyle={popoverStyle}
        pushState={pushState}
        referenceLines={referenceLines}
        regionMoveMode={regionMoveMode}
        removeBookmark={removeBookmark}
        removeSelectedObjects={removeSelectedObjects}
        revisionsLoading={revisionsLoading}
        saveBookmark={saveBookmark}
        savedBindId={savedBindId}
        saveStatus={saveStatus}
        selectedCanvasItem={selectedCanvasItem}
        selectedCanvasItems={selectedCanvasItems}
        selectedElement={selectedElement}
        selectedLink={selectedLink}
        selectedNode={selectedNode}
        selectedNodes={selectedNodes}
        setAlignmentReferenceId={setAlignmentReferenceId}
        setArmedNodeType={setArmedNodeType}
        setBindChoice={setBindChoice}
        setBinding={setBinding}
        setCanvasMode={setCanvasMode}
        setCanvasSelectedElementIds={setCanvasSelectedElementIds}
        setCompactMode={setCompactMode}
        setContextMenu={setContextMenu}
        setGridEnabled={setGridEnabled}
        setGridSnapEnabled={setGridSnapEnabled}
        setIsInspectorOpen={setIsInspectorOpen}
        setNotice={setNotice}
        setOverlayRevision={setOverlayRevision}
        setRegionMoveMode={setRegionMoveMode}
        setSelectedElement={setSelectedElement}
        setShowAgent={setShowAgent}
        setShowConflict={setShowConflict}
        setShowEditbar={setShowEditbar}
        setShowInterfaces={setShowInterfaces}
        setShowLibrary={setShowLibrary}
        setShowManualNodeModal={setShowManualNodeModal}
        setShowObservation={setShowObservation}
        setSmartGuidesEnabled={setSmartGuidesEnabled}
        setTopologyDescInput={setTopologyDescInput}
        setTopologyModalMode={setTopologyModalMode}
        setTopologyNameInput={setTopologyNameInput}
        setViewOverlayNodeId={setViewOverlayNodeId}
        setWhiteboardActive={setWhiteboardActive}
        showAgent={showAgent}
        showEditbar={showEditbar}
        showInterfaces={showInterfaces}
        showLibrary={showLibrary}
        showObservation={showObservation}
        smartGuidesEnabled={smartGuidesEnabled}
        updatePopoverAnchor={updatePopoverAnchor}
        viewOverlayNodeId={viewOverlayNodeId}
        viewportRef={viewportRef}
        whiteboardActive={whiteboardActive}
        workspaceId={workspaceId}
        workspaceMode={workspaceMode}
      />

      {activeTopology && (
        <aside className="studio-agent-dock" aria-hidden={!showAgent}>
          <TopologyAgentPanel
            key={`${workspaceId}:${activeTopology.topology_id}`}
            workspaceId={workspaceId}
            topology={activeTopology}
            selection={canvasSelection}
            prepareDrawing={prepareDrawing}
            activities={drawingActivities}
            onLocate={(ids) => {
              setHighlightedIds(ids);
              canvasApiRef.current?.focusIds(ids);
            }}
            onUndoChange={undoDrawingChange}
            onCompleted={() => {
              void handleAgentCompleted();
            }}
          />
        </aside>
      )}

      {contextMenu && (
        <TopologyContextMenu
          activeTopology={activeTopology}
          canvasApiRef={canvasApiRef}
          contextMenu={contextMenu}
          handleAddCanvasItem={handleAddCanvasItem}
          handleAutoFitCanvasItem={handleAutoFitCanvasItem}
          handleAutoLayout={handleAutoLayout}
          handleBringCanvasItemToFront={handleBringCanvasItemToFront}
          handleCloneNode={handleCloneNode}
          handleLockSelectedNodes={handleLockSelectedNodes}
          handleOpenCreateZone={handleOpenCreateZone}
          handleRemoveCanvasItem={handleRemoveCanvasItem}
          handleRemoveLink={handleRemoveLink}
          handleRemoveNode={handleRemoveNode}
          handleSelectLockGroup={handleSelectLockGroup}
          handleSendCanvasItemToBack={handleSendCanvasItemToBack}
          handleUnlockNode={handleUnlockNode}
          handleUnlockSelectedNodes={handleUnlockSelectedNodes}
          nodeLabelById={nodeLabelById}
          openLinkComposer={openLinkComposer}
          selectedNodes={selectedNodes}
          setCanvasMode={setCanvasMode}
          setContextMenu={setContextMenu}
          setIsInspectorOpen={setIsInspectorOpen}
          setNotice={setNotice}
          setSelectedElement={setSelectedElement}
          setShowAgent={setShowAgent}
        />
      )}

      {showShortcutHelp && (
        <TopologyShortcutHelp setShowShortcutHelp={setShowShortcutHelp} />
      )}

      {/* MODAL 1: Create / Edit Topology */}
      {topologyModalMode && (
        <TopologyMetadataDialog
          busy={busy}
          handleSaveTopologyMeta={handleSaveTopologyMeta}
          setTopologyDescInput={setTopologyDescInput}
          setTopologyModalMode={setTopologyModalMode}
          setTopologyNameInput={setTopologyNameInput}
          topologyDescInput={topologyDescInput}
          topologyModalMode={topologyModalMode}
          topologyNameInput={topologyNameInput}
        />
      )}

      {/* MODAL 2: Create Link on Connect */}
      {pendingConnection && (
        <TopologyLinkDialog
          activeTopology={activeTopology}
          handleSaveLink={handleSaveLink}
          linkForm={linkForm}
          pendingConnection={pendingConnection}
          setLinkForm={setLinkForm}
          setPendingConnection={setPendingConnection}
        />
      )}

      {/* MODAL: Diagram-only node */}
      {showManualNodeModal && (
        <TopologyManualNodeDialog
          handleAddManualNode={handleAddManualNode}
          manualNodeName={manualNodeName}
          manualNodeType={manualNodeType}
          setManualNodeName={setManualNodeName}
          setManualNodeType={setManualNodeType}
          setShowManualNodeModal={setShowManualNodeModal}
        />
      )}

      {/* MODAL 3: Create Smart Zone */}
      {showCreateZoneModal && (
        <TopologyRegionDialog
          activeTopology={activeTopology}
          canvasSelectedElementIds={canvasSelectedElementIds}
          handleConfirmCreateZone={handleConfirmCreateZone}
          setShowCreateZoneModal={setShowCreateZoneModal}
          setZoneColorIndex={setZoneColorIndex}
          setZoneNameInput={setZoneNameInput}
          zoneColorIndex={zoneColorIndex}
          zoneNameInput={zoneNameInput}
        />
      )}

      {showConflict && conflict && (
        <TopologyConflictDialog
          applyConflictChoice={applyConflictChoice}
          conflict={conflict}
          nodeLabelById={nodeLabelById}
          setShowConflict={setShowConflict}
        />
      )}

      {showRevisions && (
        <TopologyRevisionDialog
          diffLoading={diffLoading}
          handleDiffRevision={handleDiffRevision}
          handleRestoreRevision={handleRestoreRevision}
          restoreLayout={restoreLayout}
          restoringId={restoringId}
          revisionDiff={revisionDiff}
          revisions={revisions}
          revisionsLoading={revisionsLoading}
          setRestoreLayout={setRestoreLayout}
          setShowRevisions={setShowRevisions}
        />
      )}

      {isFullscreen && (
        <TopologyPresentationToolbar
          activeTopology={activeTopology}
          applyBookmark={applyBookmark}
          bookmarks={bookmarks}
          canvasApiRef={canvasApiRef}
          currentBookmarkName={currentBookmarkName}
          handleToggleFullscreen={handleToggleFullscreen}
          handleToggleWhiteboard={handleToggleWhiteboard}
          whiteboardActive={whiteboardActive}
        />
      )}
    </div>
  );
}
