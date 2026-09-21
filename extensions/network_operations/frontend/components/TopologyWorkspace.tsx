import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
// 图标全部走平台统一出口 components/Icon.tsx —— 这是全站唯一的 Phosphor
// 门面，直接 import "@phosphor-icons/react" 会让扩展页与平台图标语义脱钩。
import {
  IconAlert,
  IconArrowsX,
  IconBox,
  IconBranch,
  IconCheck,
  IconClock,
  IconClose,
  IconCloud,
  IconCopy,
  IconEdit,
  IconEye,
  IconFolder,
  IconGrid,
  IconLayers,
  IconLink,
  IconMenu,
  IconPlus,
  IconRedo,
  IconRefresh,
  IconSave,
  IconSearch,
  IconServer,
  IconShield,
  IconSplit,
  IconTrash,
  IconUndo,
  IconWifi,
  IconSparkle,
  IconExpand,
  IconChevronUp,
  IconWrench,
} from "../../../../frontend/src/components/Icon";
import { apiRequest } from "../../../../frontend/src/api/client";
import { confirm } from "../../../../frontend/src/components/ConfirmDialog";
import { Button } from "../../../../frontend/src/components/ui";
import { LAYOUT_PRESETS, layoutTopology, type LayoutAlgorithm } from "./topologyLayout";
import { TopologyAgentPanel } from "./TopologyAgentPanel";
import NetOpsCanvas, { type CanvasApi, type CanvasContextTarget } from "./NetOpsCanvas";
import { buildImagePdf, rgbFromRgba, type RgbImage } from "./topologyPdf";
import { mergeTopologies, type MergeConflict, type MergeStats } from "./topologyMerge";
import { buildCanvasSelection, type CanvasSelection } from "./canvasSelection";
import { netOpsIconForDeviceType } from "./netopsCanvasAssets";
import "./TopologyStudio.css";



export type TopologyNode = {
  node_id: string;
  x: number;
  y: number;
  device_type?: string;
  display_name?: string;
  labels?: string[];
  group_id?: string;
};

export type TopologyLinkStyle = {
  color?: string;
  width?: number;
  line_style?: "solid" | "dashed" | "dotted";
  curve_style?: "bezier" | "straight" | "taxi";
  curve_reverse?: boolean;
};

export type TopologyLink = {
  link_id: string;
  source_node_id: string;
  source_interface: string;
  target_node_id: string;
  target_interface: string;
  kind: "physical" | "logical";
  label?: string;
  metadata?: {
    speed?: string;
    vlan?: string;
    medium?: string;
    subnet?: string;
    address?: string;
    /** Descriptions are inspector data unless the diagram owner opts in. */
    show_description?: boolean;
    [key: string]: unknown;
  };
  source: "manual";
  evidence_refs?: string[];
  status: "unknown" | "up" | "down";
  style?: TopologyLinkStyle;
};

/** User-authored visual context.  It is deliberately separate from devices. */
export type TopologyCanvasItem = {
  item_id: string;
  kind: "rectangle" | "ellipse" | "text";
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  style?: { fill?: string; border?: string; color?: string };
};

export type TopologyGroup = {
  group_id: string;
  name: string;
  kind: "as" | "region" | "datacenter" | "tenant" | "custom";
  x: number;
  y: number;
  width: number;
  height: number;
  style?: Record<string, unknown>;
};

export type Topology = {
  topology_id: string;
  name: string;
  description: string;
  version: number;
  nodes: TopologyNode[];
  links: TopologyLink[];
  groups: TopologyGroup[];
  canvas_items?: TopologyCanvasItem[];
  created_at: string;
  updated_at: string;
};



const base = "/extensions/network.operations";



/**
 * The drawing-device palette.
 *
 * eNSP and HCL both put a *type* palette down the left side, so adding a device
 * is "pick the model, click the canvas" — two gestures and no dialog. This
 * canvas only had the registered-device list (pick an asset, drag it) plus a
 * modal for drawing-only nodes, so putting a firewall on the sheet meant
 * opening a form and typing a name before you could see anything at all.
 *
 * These are the same six types the modal offers. The modal stays for the case
 * where the name matters up front; the palette is for sketching a topology,
 * which is when the name does not.
 */
const DRAWING_DEVICE_TYPES = [
  { value: "router", label: "路由器" },
  { value: "router_core", label: "核心路由器" },
  { value: "switch", label: "交换机" },
  { value: "switch_core", label: "核心交换机" },
  { value: "switch_access", label: "接入交换机" },
  { value: "firewall", label: "防火墙" },
  { value: "server", label: "服务器" },
  { value: "pc", label: "终端 PC" },
  { value: "cloud", label: "云网络" },
  { value: "wireless", label: "无线 AP" },
  { value: "wan", label: "广域网 WAN" },
  { value: "database", label: "数据库" },
  { value: "camera", label: "监控设备" },
  { value: "phone", label: "IP 电话" },
  { value: "printer", label: "打印设备" },
] as const;

export const QUICK_PALETTE_DEVICES = [
  { value: "router", label: "路由器", icon: "/netops-canvas/icons/router.png" },
  { value: "switch", label: "交换机", icon: "/netops-canvas/icons/switch.png" },
  { value: "firewall", label: "防火墙", icon: "/netops-canvas/icons/icon_firewall_custom.png" },
  { value: "server", label: "服务器", icon: "/netops-canvas/icons/server.png" },
  { value: "pc", label: "终端", icon: "/netops-canvas/icons/pc.png" },
  { value: "cloud", label: "云/WAN", icon: "/netops-canvas/icons/cloud.png" },
] as const;




/**
 * Decode the renderer's PNG data URL into the raw pixels the PDF writer needs.
 * Going through a canvas means the browser does the PNG decoding for us.
 */
async function pngToRgbImage(dataUrl: string): Promise<RgbImage> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("png_decode_failed"));
    element.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext("2d");
  if (!context || !canvas.width || !canvas.height) throw new Error("png_decode_failed");
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  return rgbFromRgba(data, canvas.width, canvas.height);
}

/** Show a merged field value the way a person reads it, not as raw JSON. */
/** 一台设备上已经被链路占用了的接口名（无论它在链路的哪一端）。 */
export function occupiedInterfaces(links: TopologyLink[], nodeId?: string): Set<string> {
  const used = new Set<string>();
  if (!nodeId) return used;
  for (const link of links) {
    if (link.source_node_id === nodeId && link.source_interface) used.add(link.source_interface.trim());
    if (link.target_node_id === nodeId && link.target_interface) used.add(link.target_interface.trim());
  }
  return used;
}

/**
 * 这台设备上下一个还没被占用的 `GE0/N`。
 *
 * 链路表单的接口默认值以前是写死的 `GE0/1` / `GE0/0`，从来不看这台设备上哪些
 * 口已经用了。所以同一对设备之间加第二条链路时，两端又拿到同样的默认口，图上
 * 就出现一台设备挂着两个 `GE0/1` —— 看着像渲染错了或者谁填错了，其实是默认值
 * 从头到尾没参与过分配。
 *
 * `startAt` 让源端从 1、对端从 0 起算，保住原来第一条链路的默认值 `GE0/1`
 * 和 `GE0/0`；之后每次都往后找空位。
 */
export function nextFreeInterface(links: TopologyLink[], nodeId?: string, startAt = 1): string {
  const used = occupiedInterfaces(links, nodeId);
  for (let index = startAt; index < startAt + 256; index += 1) {
    const name = `GE0/${index}`;
    if (!used.has(name)) return name;
  }
  return `GE0/${startAt}`;
}

function describeMergeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "空";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** A stored structural snapshot of the canvas. */
type TopologyRevision = {
  revision_id: string;
  version: number;
  saved_at: string;
  name: string;
  summary: { nodes?: number; links?: number; groups?: number; canvas_items?: number };
};

/** What moved between a stored revision and the canvas as it stands now. */
type RevisionDiff = {
  revision_id: string;
  revision_version: number;
  revision_saved_at: string;
  current_version: number;
  nodes_added: Array<{ node_id: string; label: string }>;
  nodes_removed: Array<{ node_id: string; label: string }>;
  nodes_changed: Array<{ node_id: string; label: string; changes: Record<string, { from: string; to: string }> }>;
  links_added: Array<{ link_id: string; label: string }>;
  links_removed: Array<{ link_id: string; label: string }>;
  links_changed: Array<{ link_id: string; label: string; changes: Record<string, { from: string; to: string }> }>;
  groups_added: Array<{ group_id: string; label: string }>;
  groups_removed: Array<{ group_id: string; label: string }>;
  canvas_items_added: Array<{ item_id: string; label: string }>;
  canvas_items_removed: Array<{ item_id: string; label: string }>;
  summary: Record<string, number>;
};

const DIFF_FIELD_LABELS: Record<string, string> = {
  device_type: "设备类型",
  display_name: "显示名",
  group_id: "所属分组",
  source_interface: "本端接口",
  target_interface: "对端接口",
  kind: "链路类型",
  source: "来源",
  status: "状态",
  label: "说明",
};

/** Mirrors the device role options on the registration form. */
const batchTypeOptions: Array<[string, string]> = [
  ["router", "路由器"], ["switch", "二层交换机"], ["l3_switch", "三层交换机"],
  ["firewall", "防火墙"], ["server", "服务器"], ["wireless", "无线设备"], ["cloud", "云 / Internet"],
];
const deviceTypeMap = new Map<string, string>([
  ...DRAWING_DEVICE_TYPES.map((d) => [d.value, d.label] as [string, string]),
  ...batchTypeOptions,
]);

const canvasItemStylePresets = {
  teal: { label: "青绿标注", style: { fill: "#dff5f0", border: "#58a99b", color: "#0f5149" } },
  blue: { label: "蓝色标注", style: { fill: "#e3efff", border: "#6d9fe5", color: "#174f96" } },
  amber: { label: "琥珀标注", style: { fill: "#fff3d8", border: "#d69b36", color: "#7d4b00" } },
  slate: { label: "灰色标注", style: { fill: "#edf1f4", border: "#93a3af", color: "#334155" } },
} as const;

function canvasItemStylePreset(style?: TopologyCanvasItem["style"]): keyof typeof canvasItemStylePresets | "custom" {
  const match = Object.entries(canvasItemStylePresets).find(([, preset]) =>
    preset.style.fill === style?.fill && preset.style.border === style?.border && preset.style.color === style?.color,
  );
  return (match?.[0] as keyof typeof canvasItemStylePresets | undefined) || "custom";
}

/**
 * 设备类型图标。导出给网络运维主页用 —— 设备列表和拓扑画布节点用同一套
 * 类型 → 图标映射，用户从列表切到画布时不会认错设备。
 */
export function DeviceTypeIcon({ deviceType, size = 16 }: { deviceType: string; size?: number }) {
  const netOpsIcon = netOpsIconForDeviceType(deviceType);
  if (netOpsIcon) return <img src={netOpsIcon} alt="" width={size} height={size} style={{ objectFit: "contain" }} />;
  const type = deviceType?.toLowerCase() || "";
  if (type.includes("router")) return <IconSplit size={size} />;
  if (type === "l3_switch" || type.includes("layer3")) return <IconLayers size={size} />;
  if (type.includes("switch")) return <IconArrowsX size={size} />;
  if (type.includes("firewall") || type.includes("fw") || type.includes("sec")) return <IconShield size={size} />;
  if (type.includes("server") || type.includes("host")) return <IconServer size={size} />;
  if (type.includes("wireless") || type.includes("ap") || type.includes("wifi")) return <IconWifi size={size} />;
  if (type.includes("cloud")) return <IconCloud size={size} />;
  return <IconBox size={size} />;
}

interface TopologyWorkspaceProps {
  workspaceId: string;
  topologies: Topology[];
  loadError: string;
  onReload: () => Promise<void>;
  /** ok 省略或为 true 表示成功提示（绿色）；显式传 false 表示失败（警告黄）。 */
  setNotice: (notice: string, ok?: boolean) => void;
  busy: boolean;
}

export type SelectedElement =
  | { type: "node"; nodeId: string }
  | { type: "link"; linkId: string }
  | { type: "group"; groupId: string }
  | { type: "canvas_item"; itemId: string }
  | null;

export default function TopologyWorkspace({
  workspaceId,
  topologies,
  loadError,
  onReload,
  setNotice,
  busy,
}: TopologyWorkspaceProps) {
  const [selectedTopologyId, setSelectedTopologyId] = useState<string>(() => {
    return topologies[0]?.topology_id || "";
  });

  useEffect(() => {
    if (!selectedTopologyId && topologies.length > 0) {
      setSelectedTopologyId(topologies[0].topology_id);
    } else if (selectedTopologyId && !topologies.some((t) => t.topology_id === selectedTopologyId)) {
      setSelectedTopologyId(topologies[0]?.topology_id || "");
    }
  }, [topologies, selectedTopologyId]);

  const currentTopology = useMemo(() => {
    return topologies.find((t) => t.topology_id === selectedTopologyId) || null;
  }, [topologies, selectedTopologyId]);

  const [activeTopology, setActiveTopology] = useState<Topology | null>(currentTopology);
  const saveStatusRef = useRef<"saved" | "saving" | "unsaved" | "conflict">("saved");
  const revisionRef = useRef(0);
  const serverVersionsRef = useRef(new Map<string, number>());
  /**
   * The last version the server confirmed, kept per drawing. A conflict can
   * only be merged against this base: without it we would know that two
   * drawings differ but not which side changed what.
   */
  const serverTopologyRef = useRef(new Map<string, Topology>());
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (saveStatusRef.current !== "saved") return;
    if (currentTopology) {
      // A reload can resolve *after* a later save has already been adopted. The
      // list it carries is older than what is on screen, and adopting it drags
      // every object back to where it was one edit ago — then the next reload
      // drags it forward again. Two jumps an edit apart is what the user
      // reports as a flash, and the guard above does not cover it: it only asks
      // whether a save is in flight, not whether this list is newer than what
      // we already have. `serverVersionsRef` holds exactly the number needed to
      // tell the two apart. Measured before this check: a list reply released
      // one edit late moved a node 74px back to its previous resting place.
      const known = serverVersionsRef.current.get(currentTopology.topology_id);
      if (known !== undefined && currentTopology.version < known) return;
    }
    setActiveTopology(currentTopology);
    if (currentTopology) {
      serverVersionsRef.current.set(currentTopology.topology_id, currentTopology.version);
      serverTopologyRef.current.set(currentTopology.topology_id, currentTopology);
    }
  }, [currentTopology]);

  // Undo / Redo history
  const [history, setHistory] = useState<Topology[]>([]);
  const [future, setFuture] = useState<Topology[]>([]);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "unsaved" | "conflict">("saved");
  // A conflict is a decision, not an error: hold both sides until the user picks.
  const [conflict, setConflict] = useState<{
    base: Topology; mine: Topology; theirs: Topology; merged: Topology;
    conflicts: MergeConflict[]; stats: MergeStats;
  } | null>(null);
  const [showConflict, setShowConflict] = useState(false);
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;
  const saveTimerRef = useRef<number | null>(null);
  useEffect(() => { setHistory([]); setFuture([]); setSelectedElement(null); }, [selectedTopologyId]);

  /**
   * Adopt a drawing the server has already written.
   *
   * Restore, agent write-back and "take the server version" all end with the
   * server holding a newer version than the one this tab remembers. Routing
   * those through `pushState` scheduled another save against the stale
   * version, so the next thing the user saw was a conflict with themselves.
   */
  const adoptServerTopology = useCallback((next: Topology) => {
    revisionRef.current += 1;
    serverVersionsRef.current.set(next.topology_id, next.version);
    serverTopologyRef.current.set(next.topology_id, next);
    setActiveTopology(next);
    saveStatusRef.current = "saved";
    setSaveStatus("saved");
  }, []);

  // Inspector & selection
  const [selectedElement, setSelectedElement] = useState<SelectedElement>(null);
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const [popoverPlacement, setPopoverPlacement] = useState<"left" | "right" | "corner">("right");
  const [popoverCoords, setPopoverCoords] = useState<{ left?: number; right?: number; top?: number }>({ right: 16, top: 16 });
  const [arrowY, setArrowY] = useState<number>(36);
  const [isDragged, setIsDragged] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ startX: number; startY: number; initialLeft: number; initialTop: number } | null>(null);

  // Reset drag position when switching to a different element
  useEffect(() => {
    setIsDragged(false);
  }, [selectedElement]);

  const updatePopoverAnchor = useCallback(() => {
    if (!isInspectorOpen || isDragged) return;
    const viewportEl = viewportRef.current;
    if (!viewportEl) return;

    const vw = viewportEl.clientWidth || 800;
    const vh = viewportEl.clientHeight || 600;
    const bubbleWidth = Math.min(220, vw - 16);

    if (!selectedElement) {
      setPopoverPlacement("corner");
      setPopoverCoords({ right: 12, top: 12 });
      return;
    }

    const api = canvasApiRef.current;
    let pos: { x: number; y: number } | null = null;
    if (api?.getElementPosition) {
      if (selectedElement.type === "node") {
        pos = api.getElementPosition(selectedElement.nodeId, "node");
      } else if (selectedElement.type === "link") {
        pos = api.getElementPosition(selectedElement.linkId, "link");
      } else if (selectedElement.type === "canvas_item") {
        pos = api.getElementPosition(selectedElement.itemId, "canvas_item");
      }
    }

    if (!pos) {
      setPopoverPlacement("corner");
      setPopoverCoords({ right: 12, top: 12 });
      return;
    }

    const rightLeft = pos.x + 24;
    const canFitRight = rightLeft + bubbleWidth + 12 <= vw;
    const leftLeft = pos.x - 24 - bubbleWidth;
    const canFitLeft = leftLeft >= 12;

    if (canFitRight) {
      const top = Math.max(12, Math.min(pos.y - 70, Math.max(12, vh - 290)));
      const arrowPos = Math.max(20, Math.min(pos.y - top, 230));
      setPopoverPlacement("right");
      setPopoverCoords({ left: rightLeft, top });
      setArrowY(arrowPos);
    } else if (canFitLeft) {
      const top = Math.max(12, Math.min(pos.y - 70, Math.max(12, vh - 290)));
      const arrowPos = Math.max(20, Math.min(pos.y - top, 230));
      setPopoverPlacement("left");
      setPopoverCoords({ left: leftLeft, top });
      setArrowY(arrowPos);
    } else {
      const left = Math.max(10, Math.min(pos.x - bubbleWidth / 2, vw - bubbleWidth - 10));
      const top = Math.max(12, Math.min(pos.y - 70, Math.max(12, vh - 250)));
      setPopoverPlacement("corner");
      setPopoverCoords({ left, top });
    }
  }, [isInspectorOpen, isDragged, selectedElement]);

  const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("input") || target.closest("select") || target.closest("a") || target.closest("textarea")) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    const inspectorEl = inspectorRef.current;
    const viewportEl = viewportRef.current;
    if (!inspectorEl || !viewportEl) return;

    const viewportRect = viewportEl.getBoundingClientRect();
    const inspectorRect = inspectorEl.getBoundingClientRect();

    const initialLeft = inspectorRect.left - viewportRect.left;
    const initialTop = inspectorRect.top - viewportRect.top;

    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialLeft,
      initialTop,
    };
    setIsDragging(true);
    setIsDragged(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const onMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current || !viewportRef.current || !inspectorRef.current) return;
      const { startX, startY, initialLeft, initialTop } = dragStartRef.current;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const viewportEl = viewportRef.current;
      const inspectorEl = inspectorRef.current;
      const vw = viewportEl.clientWidth;
      const vh = viewportEl.clientHeight;
      const cardWidth = inspectorEl.offsetWidth;
      const cardHeight = inspectorEl.offsetHeight;

      const rawLeft = initialLeft + dx;
      const rawTop = initialTop + dy;

      const clampedLeft = Math.max(8, Math.min(rawLeft, Math.max(8, vw - cardWidth - 8)));
      const clampedTop = Math.max(8, Math.min(rawTop, Math.max(8, vh - cardHeight - 8)));

      setPopoverCoords({ left: clampedLeft, top: clampedTop });
    };

    const onMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDragging]);

  useEffect(() => {
    if (isInspectorOpen && !isDragged) {
      const id = requestAnimationFrame(() => {
        updatePopoverAnchor();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [isInspectorOpen, isDragged, selectedElement, updatePopoverAnchor]);

  useEffect(() => {
    window.addEventListener("resize", updatePopoverAnchor);
    return () => window.removeEventListener("resize", updatePopoverAnchor);
  }, [updatePopoverAnchor]);

  const popoverStyle: React.CSSProperties = {
    ...(popoverCoords.left !== undefined ? { left: `${popoverCoords.left}px` } : {}),
    ...(popoverCoords.right !== undefined && popoverCoords.left === undefined ? { right: `${popoverCoords.right}px` } : {}),
    ...(popoverCoords.top !== undefined ? { top: `${popoverCoords.top}px` } : {}),
    ...(arrowY ? { ["--arrow-y" as any]: `${arrowY}px` } : {}),
  };
  const [showAgent, setShowAgent] = useState(false);
  // The board is primary. The tray opens intentionally instead of consuming
  // canvas width for every user.
  const [showLibrary, setShowLibrary] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
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
  }, [showEditbar]);
  const [gridEnabled, setGridEnabled] = useState(true);
  const [canvasSelectedElementIds, setCanvasSelectedElementIds] = useState<string[]>([]);
  const [showInterfaces, setShowInterfaces] = useState(true);
  // Filters dim rather than hide, so the diagram never turns into a different
  // drawing than the one being discussed.
  // Imperative canvas handle (export / focus / viewport) and transient canvas
  // UI: right-click menu, keyboard help, and in-canvas search.
  const canvasApiRef = useRef<CanvasApi | null>(null);
  const [contextMenu, setContextMenu] = useState<CanvasContextTarget | null>(null);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [canvasQuery, setCanvasQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  /** The object a locate action is still trying to centre, if any. */
  const pendingFocusRef = useRef<string>("");
  const [layoutBusy, setLayoutBusy] = useState(false);
  const activeTopologyRef = useRef(activeTopology);
  activeTopologyRef.current = activeTopology;
  /**
   * What the Agent is told the user is looking at. The canvas selection is
   * authoritative: box-selecting five devices and asking about "these" used
   * to send the whole topology, because this came from the inspector alone.
   */
  const canvasSelection: CanvasSelection = useMemo(
    () => buildCanvasSelection(activeTopology, canvasSelectedElementIds, selectedElement),
    [activeTopology, canvasSelectedElementIds, selectedElement],
  );



  // Modals
  const [topologyModalMode, setTopologyModalMode] = useState<"create" | "edit" | null>(null);
  const [topologyNameInput, setTopologyNameInput] = useState("");
  const [topologyDescInput, setTopologyDescInput] = useState("");

  const [showGroupModal, setShowGroupModal] = useState(false);
  const [groupNameInput, setGroupNameInput] = useState("");
  const [groupKindInput, setGroupKindInput] = useState<"as" | "region" | "datacenter" | "tenant" | "custom">("datacenter");
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
    [activeTopology?.links]
  );

  const nodeLabelById = useMemo(() => new Map((activeTopology?.nodes || []).map((node) => [node.node_id, node.display_name || node.node_id])), [activeTopology?.nodes]);

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
  const resolveConflict = useCallback(async (mine: Topology) => {
    // Freeze queued saves before the conflict GET, not after it. The user can
    // still edit locally while it loads; those edits must join the resolution.
    saveStatusRef.current = "conflict";
    setSaveStatus("conflict");
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    // Not named `base`: that is the module-level API prefix, and shadowing it
    // silently turned the request URL into "[object Object]/topologies/...".
    const lastConfirmed = serverTopologyRef.current.get(mine.topology_id) || mine;
    try {
      const res = await apiRequest<{ topology: Topology }>({
        method: "GET",
        url: `${base}/topologies/${mine.topology_id}`,
        params: { workspace_id: workspaceId },
      });
      const theirs = res.topology;
      if (!theirs) throw new Error("topology_not_found");
      const latestMine = activeTopologyRef.current?.topology_id === mine.topology_id
        ? activeTopologyRef.current : mine;
      const result = mergeTopologies(lastConfirmed, latestMine, theirs);
      // Any resolution writes on top of their version, so the next save is
      // accepted instead of conflicting again.
      serverVersionsRef.current.set(mine.topology_id, theirs.version);
      setConflict({ base: lastConfirmed, mine: latestMine, theirs, merged: result.topology, conflicts: result.conflicts, stats: result.stats });
      setShowConflict(true);
      saveStatusRef.current = "conflict";
      setSaveStatus("conflict");
      setNotice("这张图纸在你编辑期间被其他人保存过，请选择如何处理", false);
    } catch {
      saveStatusRef.current = "unsaved";
      setSaveStatus("unsaved");
      setNotice("拓扑版本冲突：已被其他操作修改，当前未保存编辑仍保留", false);
    }
  }, [workspaceId, setNotice]);

  // Execute Save
  const executeSave = useCallback(
    (topo: Topology) => {
      const revision = revisionRef.current;
      const work = async () => {
      // A conflict is an explicit decision point. Saves queued before it was
      // detected are stale by definition; sending them would only create more
      // 409s and could replace the snapshot the user is reviewing.
      if (saveStatusRef.current === "conflict") return;
      saveStatusRef.current = "saving"; setSaveStatus("saving");
      try {
        const res = await apiRequest<{ topology: Topology }>({
          method: "PUT",
          url: `${base}/topologies/${topo.topology_id}`,
          data: {
            workspace_id: workspaceId,
            name: topo.name,
            description: topo.description,
            version: serverVersionsRef.current.get(topo.topology_id) ?? topo.version,
            nodes: topo.nodes,
            links: topo.links,
            groups: topo.groups,
            canvas_items: topo.canvas_items || [],
          },
        });
        serverVersionsRef.current.set(topo.topology_id, res.topology.version);
        serverTopologyRef.current.set(topo.topology_id, res.topology);
        if (revision === revisionRef.current) {
          setActiveTopology(res.topology);
          saveStatusRef.current = "saved"; setSaveStatus("saved");
          void onReload();
        } else {
          setActiveTopology((current) => current?.topology_id === topo.topology_id ? { ...current, version: res.topology.version } : current);
          saveStatusRef.current = "unsaved"; setSaveStatus("unsaved");
        }
      } catch (err: unknown) {
        const errMsg = (err as { message?: string })?.message || "自动保存拓扑失败";
        if (errMsg.includes("version_conflict") || errMsg.includes("version conflict")) {
          await resolveConflict(topo);
          return;
        }
        saveStatusRef.current = "unsaved"; setSaveStatus("unsaved");
        setNotice(errMsg, false);
      }
      };
      saveChainRef.current = saveChainRef.current.then(work, work);
      return saveChainRef.current;
    },
    [workspaceId, onReload, setNotice, resolveConflict]
  );

  // Push state with debounced save
  const pushState = useCallback(
    (next: Topology) => {
      if (!activeTopology) return;
      const conflictPending = saveStatusRef.current === "conflict";
      setHistory((prev) => [...prev.slice(-20), activeTopology]);
      setFuture([]);
      revisionRef.current += 1;
      activeTopologyRef.current = next;
      setActiveTopology(next);
      if (conflictPending) {
        // The user may choose “稍后处理” and keep editing. Recompute against
        // the same confirmed base so the eventual decision contains every
        // local edit, not merely the snapshot that first hit the conflict.
        setConflict((pending) => {
          if (!pending) return pending;
          const merged = mergeTopologies(pending.base, next, pending.theirs);
          return { ...pending, mine: next, merged: merged.topology, conflicts: merged.conflicts, stats: merged.stats };
        });
        return;
      }
      saveStatusRef.current = "unsaved";
      setSaveStatus("unsaved");

      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        void executeSave(next);
      }, 800);
    },
    [activeTopology, executeSave]
  );

  /**
   * Resolve a conflict the way the user asked. "Take theirs" is the only
   * branch that discards work, so it is also the only one that says so.
   */
  const applyConflictChoice = useCallback((choice: "merged" | "theirs" | "mine") => {
    if (!conflict) return;
    setShowConflict(false);
    setConflict(null);
    if (choice === "theirs") {
      adoptServerTopology(conflict.theirs);
      setNotice("已采用服务端版本，本地未保存改动已放弃", true);
      return;
    }
    const target = choice === "merged" ? conflict.merged : conflict.mine;
    // `pushState` intentionally does not auto-save while a conflict is open.
    // This choice resolves it, so mark the state writable before scheduling the
    // new versioned save.
    saveStatusRef.current = "unsaved";
    setSaveStatus("unsaved");
    pushState({ ...target, version: conflict.theirs.version });
    setNotice(
      choice === "merged"
        ? `已合并双方改动并保存（自动合并 ${conflict.stats.autoMerged} 处，需人工确认 ${conflict.conflicts.length} 处）`
        : "已用本地版本覆盖服务端改动",
      choice === "merged",
    );
  }, [conflict, pushState, adoptServerTopology, setNotice]);

  const handleUndo = useCallback(() => {
    if (!history.length || !activeTopology || saveStatusRef.current === "conflict") return;
    const previous = history[history.length - 1];
    setHistory((prev) => prev.slice(0, -1));
    setFuture((prev) => [activeTopology, ...prev]);
    setActiveTopology(previous);
    revisionRef.current += 1;
    saveStatusRef.current = "unsaved";
    setSaveStatus("unsaved");
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void executeSave(previous), 800);
  }, [history, activeTopology, executeSave]);

  const handleRedo = useCallback(() => {
    if (!future.length || !activeTopology || saveStatusRef.current === "conflict") return;
    const next = future[0];
    setFuture((prev) => prev.slice(1));
    setHistory((prev) => [...prev, activeTopology]);
    setActiveTopology(next);
    revisionRef.current += 1;
    saveStatusRef.current = "unsaved";
    setSaveStatus("unsaved");
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => void executeSave(next), 800);
  }, [future, activeTopology, executeSave]);

  const saveOnUnmountRef = useRef(executeSave);
  saveOnUnmountRef.current = executeSave;
  useEffect(() => () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    if (saveStatusRef.current === "conflict" && conflictRef.current) {
      saveStatusRef.current = "unsaved";
      void saveOnUnmountRef.current({ ...conflictRef.current.merged, version: conflictRef.current.theirs.version });
      return;
    }
    if (saveStatusRef.current === "unsaved" && activeTopologyRef.current) void saveOnUnmountRef.current(activeTopologyRef.current);
  }, []);


  const openLinkComposer = useCallback(
    (sourceId?: string, targetId?: string) => {
      const availableIds = activeTopology?.nodes.map((node) => node.node_id) || [];
      if (availableIds.length < 2) {
        setNotice("请先将至少两台设备加入画布，再建立链路", false);
        return;
      }
      const source = sourceId && availableIds.includes(sourceId) ? sourceId : availableIds[0];
      const target =
        targetId && targetId !== source && availableIds.includes(targetId)
          ? targetId
          : availableIds.find((id) => id !== source) || "";
      if (!target) return;
      setPendingConnection({ source, target });
      resetLinkForm(source, target);
    },
    [activeTopology, resetLinkForm, setNotice]
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
    if (occupiedInterfaces(activeTopology.links, pendingConnection.source).has(sourceInterface)) {
      clashes.push(`${nodeLabelById.get(pendingConnection.source) || "源端"} 的 ${sourceInterface}`);
    }
    if (occupiedInterfaces(activeTopology.links, pendingConnection.target).has(targetInterface)) {
      clashes.push(`${nodeLabelById.get(pendingConnection.target) || "对端"} 的 ${targetInterface}`);
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
      clashes.length === 0
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

      const nextNodes = activeTopology.nodes.filter((n) => n.node_id !== nodeId);
      const nextLinks = activeTopology.links.filter(
        (l) => l.source_node_id !== nodeId && l.target_node_id !== nodeId
      );

      pushState({
        ...activeTopology,
        nodes: nextNodes,
        links: nextLinks,
      });
      setSelectedElement(null);
      setNotice(`已从图纸移除“${devName}”`);
    },
    [activeTopology, pushState, setNotice]
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

      const nextLinks = activeTopology.links.filter((l) => l.link_id !== linkId);
      pushState({
        ...activeTopology,
        links: nextLinks,
      });
      setSelectedElement(null);
      setNotice("链路已删除");
    },
    [activeTopology, pushState, setNotice]
  );

  // Delete group from topology
  const handleRemoveGroup = useCallback(
    async (groupId: string) => {
      if (!activeTopology) return;
      const confirmed = await confirm({
        title: "删除拓扑分组",
        body: "删除分组后，该分组下的节点将保留在拓扑中，分组标记将被清除。",
        confirmLabel: "删除分组",
        destructive: true,
      });
      if (!confirmed) return;

      const nextGroups = activeTopology.groups.filter((g) => g.group_id !== groupId);
      const nextNodes = activeTopology.nodes.map((n) =>
        n.group_id === groupId ? { ...n, group_id: undefined } : n
      );

      pushState({
        ...activeTopology,
        groups: nextGroups,
        nodes: nextNodes,
      });
      setSelectedElement(null);
      setNotice("分组已删除");
    },
    [activeTopology, pushState, setNotice]
  );



  const handleAddManualNode = useCallback((event: FormEvent) => {
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
  }, [activeTopology, manualNodeName, manualNodeType, pushState, setNotice]);

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
   * Snapping to the grid happens here rather than on the way in, because the
   * grid belongs to the drawing and not to a particular gesture. It used to sit
   * on the drag-and-drop path only, so dragging a type snapped to the grid while
   * clicking the sheet did not — the same action landing two different ways,
   * with the grid visibly on.
   */
  const placeDrawingNode = useCallback((deviceType: string, position: { x: number; y: number }) => {
    if (!activeTopology) return;
    const snap = (value: number) => gridEnabled ? Math.round(value / 32) * 32 : Math.round(value);
    const label = DRAWING_DEVICE_TYPES.find((type) => type.value === deviceType)?.label || "图纸设备";
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
    setNotice(`已放入“${node.display_name}”。可继续点击画布连续放置，按 Esc 或右键退出。`);
  }, [activeTopology, gridEnabled, pushState, setNotice]);

  const handleCloneNode = useCallback((nodeId: string) => {
    if (!activeTopology) return;
    const sourceNode = activeTopology.nodes.find((n) => n.node_id === nodeId);
    if (!sourceNode) return;
    const label = DRAWING_DEVICE_TYPES.find((t) => t.value === sourceNode.device_type)?.label || "设备";
    const taken = new Set(
      activeTopology.nodes
        .map((node) => node.display_name || "")
        .filter((name) => name.startsWith(label))
        .map((name) => Number.parseInt(name.slice(label.length), 10))
        .filter((index) => Number.isFinite(index)),
    );
    let index = 1;
    while (taken.has(index)) index += 1;

    const snap = (v: number) => gridEnabled ? Math.round(v / 32) * 32 : Math.round(v);
    const newNode: TopologyNode = {
      node_id: `node_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      device_type: sourceNode.device_type,
      display_name: `${label}${index}`,
      x: snap(sourceNode.x + 64),
      y: snap(sourceNode.y + 64),
    };
    pushState({ ...activeTopology, nodes: [...activeTopology.nodes, newNode] });
    setSelectedElement({ type: "node", nodeId: newNode.node_id });
    setNotice(`已克隆生成“${newNode.display_name}”`);
  }, [activeTopology, gridEnabled, pushState, setNotice]);

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

      const sLabel = nodeLabelById.get(source) || source;
      const tLabel = nodeLabelById.get(target) || target;
      setNotice(`已连接 ${sLabel}(${sourceInterface}) ↔ ${tLabel}(${targetInterface})。连线笔保持激活，可继续点击设备连线，按 Esc 退出。`);
    },
    [activeTopology, nextFreeInterface, nodeLabelById, pushState, setNotice]
  );

  const disarmNodeType = useCallback(() => setArmedNodeType(null), []);

  const handleAddCanvasItem = useCallback((kind: TopologyCanvasItem["kind"]) => {
    if (!activeTopology) return;
    const itemCount = (activeTopology.canvas_items || []).length;
    const defaults = kind === "text"
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
    pushState({ ...activeTopology, canvas_items: [...(activeTopology.canvas_items || []), item] });
    setSelectedElement({ type: "canvas_item", itemId: item.item_id });
    setIsInspectorOpen(true);
    setCanvasMode("select");
    setNotice(kind === "text" ? "已添加文本框，可在右侧编辑内容并拖动定位" : "已添加图纸形状，可在右侧编辑说明并拖动定位");
  }, [activeTopology, pushState, setNotice]);


  const handleTypeDragStart = useCallback((event: DragEvent<HTMLElement>, deviceType: string) => {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-lzcore-node-type", deviceType);
    event.dataTransfer.setData("text/plain", deviceType);
  }, []);



  const handleNetOpsMove = useCallback((positions: Array<{ element_id: string; x: number; y: number }>) => {
    const current = activeTopologyRef.current;
    if (!current || !positions.length) return;
    const byId = new Map(positions.map((position) => [position.element_id, position]));
    pushState({ ...current, nodes: current.nodes.map((node) => {
      const position = byId.get(node.node_id);
      return position ? { ...node, x: Math.round(position.x), y: Math.round(position.y) } : node;
    }), canvas_items: (current.canvas_items || []).map((item) => {
      const position = byId.get(`canvas-${item.item_id}`);
      return position ? { ...item, x: Math.round(position.x), y: Math.round(position.y) } : item;
    }) });
    requestAnimationFrame(() => updatePopoverAnchor());
  }, [pushState, updatePopoverAnchor]);

  const handleAlignSelectedNodes = useCallback((direction: "left" | "center" | "right" | "top" | "middle" | "bottom") => {
    if (!activeTopology) return;
    const selectedIds = new Set(canvasSelectedElementIds);
    const selected = activeTopology.nodes.filter((node) => selectedIds.has(node.node_id));
    if (selected.length < 2) {
      setNotice("请先框选至少两台设备，再执行对齐", false);
      return;
    }
    const xValues = selected.map((node) => node.x);
    const yValues = selected.map((node) => node.y);
    const x = direction === "left" ? Math.min(...xValues) : direction === "right" ? Math.max(...xValues) : Math.round(xValues.reduce((sum, value) => sum + value, 0) / selected.length);
    const y = direction === "top" ? Math.min(...yValues) : direction === "bottom" ? Math.max(...yValues) : Math.round(yValues.reduce((sum, value) => sum + value, 0) / selected.length);
    pushState({
      ...activeTopology,
      nodes: activeTopology.nodes.map((node) => selectedIds.has(node.node_id)
        ? { ...node, ...(direction === "left" || direction === "center" || direction === "right" ? { x } : { y }) }
        : node),
    });
    setNotice(`已对齐 ${selected.length} 台设备`);
  }, [activeTopology, canvasSelectedElementIds, pushState, setNotice]);

  const handleRemoveCanvasItem = useCallback(async (itemId: string) => {
    if (!activeTopology) return;
    const confirmed = await confirm({ title: "删除图纸图元", body: "确定删除这个图纸图元吗？", confirmLabel: "删除图元", destructive: true });
    if (!confirmed) return;
    pushState({ ...activeTopology, canvas_items: (activeTopology.canvas_items || []).filter((item) => item.item_id !== itemId) });
    setSelectedElement(null);
    setNotice("图纸图元已删除");
  }, [activeTopology, pushState, setNotice]);

  // A diagram that cannot leave the tool ends up as a screenshot in a report.
  // PNG and SVG come straight from the renderer; PDF is wrapped from the
  // rendered pixels, because a PDF page is what a delivery document needs.
  const downloadBlob = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Some browsers start consuming the Object URL after the click handler
    // returns. Revoking it in the same turn can leave a PDF download empty.
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, []);

  const exportCanvas = useCallback(async (format: "png" | "svg" | "pdf") => {
    const api = canvasApiRef.current;
    if (!api) {
      setNotice("画布尚未就绪，请稍后再试", false);
      return;
    }
    const safeName = (activeTopology?.name || "topology").replace(/[\\/:*?"<>|\s]+/g, "_");
    if (format === "pdf") {
      setNotice("正在生成 PDF…");
      try {
        const pixels = await pngToRgbImage(api.exportPNG({ full: true, scale: 2, background: "#ffffff" }));
        const pdf = await buildImagePdf(pixels);
        downloadBlob(new Blob([pdf], { type: "application/pdf" }), `${safeName}.pdf`);
        setNotice(`已导出 ${safeName}.pdf`);
      } catch {
        setNotice("PDF 导出失败，请改用 PNG 或 SVG", false);
      }
      return;
    }
    const anchor = document.createElement("a");
    if (format === "svg") {
      anchor.href = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(api.exportSVG())}`;
      anchor.download = `${safeName}.svg`;
    } else {
      anchor.href = api.exportPNG({ full: true, scale: 2, background: "#ffffff" });
      anchor.download = `${safeName}.png`;
    }
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setNotice(`已导出 ${safeName}.${format}`);
  }, [activeTopology, setNotice, downloadBlob]);

  /**
   * Deep link. A diagram that cannot be linked to cannot be shared, attached
   * to a ticket, or restored after a refresh.
   */
  const deepLinkTopologyRef = useRef(false);
  const deepLinkNodeRef = useRef(false);
  useEffect(() => {
    if (deepLinkTopologyRef.current || !topologies.length) return;
    const wanted = new URLSearchParams(window.location.search).get("topology");
    if (wanted && topologies.some((item) => item.topology_id === wanted)) setSelectedTopologyId(wanted);
    deepLinkTopologyRef.current = true;
  }, [topologies]);
  useEffect(() => {
    const nodeId = new URLSearchParams(window.location.search).get("node");
    if (!nodeId || !activeTopology || deepLinkNodeRef.current) return;
    if (!activeTopology.nodes.some((node) => node.node_id === nodeId)) return;
    deepLinkNodeRef.current = true;
    setSelectedElement({ type: "node", nodeId });
    window.setTimeout(() => canvasApiRef.current?.focusIds([nodeId], 1.1), 400);
  }, [activeTopology]);
  useEffect(() => {
    if (!selectedTopologyId || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("topology", selectedTopologyId);
    if (selectedElement?.type === "node") url.searchParams.set("node", selectedElement.nodeId);
    else url.searchParams.delete("node");
    window.history.replaceState({}, "", url.toString());
  }, [selectedTopologyId, selectedElement]);

  // Named views. On a large diagram, scrolling back to "the core layer" is
  // work people redo every time; a saved viewport costs one click.
  const bookmarkKey = useMemo(() => `lzcore.topology.views.${workspaceId}.${selectedTopologyId}`, [workspaceId, selectedTopologyId]);
  const [bookmarks, setBookmarks] = useState<Array<{ name: string; x: number; y: number; zoom: number }>>([]);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(bookmarkKey);
      setBookmarks(stored ? JSON.parse(stored) : []);
    } catch {
      setBookmarks([]);
    }
  }, [bookmarkKey]);
  const saveBookmark = () => {
    const view = canvasApiRef.current?.getViewport();
    if (!view) return;
    const name = window.prompt("视图名称", `视图 ${bookmarks.length + 1}`);
    if (!name) return;
    const next = [...bookmarks.filter((item) => item.name !== name), { name, ...view }];
    setBookmarks(next);
    window.localStorage.setItem(bookmarkKey, JSON.stringify(next));
    setNotice(`已保存视图「${name}」`);
  };
  const applyBookmark = (bookmark: { name: string; x: number; y: number; zoom: number }) => {
    canvasApiRef.current?.setViewport(bookmark);
    setNotice(`已切换到视图「${bookmark.name}」`);
  };
  const removeBookmark = (name: string) => {
    const next = bookmarks.filter((item) => item.name !== name);
    setBookmarks(next);
    window.localStorage.setItem(bookmarkKey, JSON.stringify(next));
  };



  // The menu is transient: any gesture outside it dismisses it.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("mousedown", close);
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("wheel", close);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);

  const canvasMatches = useMemo(() => {
    const query = canvasQuery.trim().toLowerCase();
    if (!query || !activeTopology) return [];
    const nodes = activeTopology.nodes
      .filter((node) => {
        return [node.display_name, node.device_type].some((value) => String(value || "").toLowerCase().includes(query));
      })
      .map((node) => ({ id: node.node_id, kind: "node" as const, label: node.display_name || node.node_id, detail: "图纸设备" }));
    const items = (activeTopology.canvas_items || [])
      .filter((item) => (item.text || "").toLowerCase().includes(query))
      .map((item) => ({ id: `canvas-${item.item_id}`, kind: "canvas_item" as const, label: item.text || item.kind, detail: "图纸图元" }));
    return [...nodes, ...items].slice(0, 8);
  }, [canvasQuery, activeTopology]);

  const focusCanvasObject = useCallback((id: string, kind: "node" | "canvas_item") => {
    setSelectedElement(kind === "node" ? { type: "node", nodeId: id } : { type: "canvas_item", itemId: id.replace(/^canvas-/, "") });
    setCanvasQuery("");
    // Release focus, otherwise the shortcut guard keeps swallowing keys and
    // the user has to click the canvas before V/M/C work again.
    searchInputRef.current?.blur();
    // Selecting an object opens the inspector, which resizes the canvas. A
    // single centring pass therefore lands the object off-centre: the focus
    // runs first, then the container shrinks underneath it. Centre once so the
    // object is immediately visible, then again after the inspector's
    // transition has finished so it ends up where the user expects — which is
    // also what makes "locate, then click the object" work.
    pendingFocusRef.current = id;
    window.setTimeout(() => {
      if (pendingFocusRef.current === id) canvasApiRef.current?.focusIds([id], 1.1);
    }, 260);
    window.setTimeout(() => {
      if (pendingFocusRef.current === id) canvasApiRef.current?.focusIds([id], 1.1);
    }, 620);
  }, []);

  const nudgeSelected = useCallback((dx: number, dy: number) => {
    const current = activeTopologyRef.current;
    if (!current || !canvasSelectedElementIds.length) return;
    const ids = new Set(canvasSelectedElementIds);
    pushState({
      ...current,
      nodes: current.nodes.map((node) => (ids.has(node.node_id) ? { ...node, x: node.x + dx, y: node.y + dy } : node)),
      canvas_items: (current.canvas_items || []).map((item) => (ids.has(`canvas-${item.item_id}`) ? { ...item, x: item.x + dx, y: item.y + dy } : item)),
    });
  }, [canvasSelectedElementIds, pushState]);

  // Batch editing: selecting ten devices and being able to do nothing with
  // them is the point where people go back to Visio.
  const selectedNodes = useMemo(() => (activeTopology?.nodes || []).filter((node) => canvasSelectedElementIds.includes(node.node_id)), [activeTopology, canvasSelectedElementIds]);
  const selectedCanvasItems = useMemo(() => (activeTopology?.canvas_items || []).filter((item) => canvasSelectedElementIds.includes(`canvas-${item.item_id}`)), [activeTopology, canvasSelectedElementIds]);
  const hasMultiSelection = selectedNodes.length + selectedCanvasItems.length > 1;
  // A marquee or Ctrl+A only changes the canvas selection, so nothing opened
  // the inspector and the batch panel stayed rendered-but-unreachable behind
  // `display: none`. Opening on the transition into a multi-selection keeps a
  // deliberate gesture as the trigger, so closing the panel afterwards holds.
  useEffect(() => {
    if (hasMultiSelection && !showAgent) setIsInspectorOpen(true);
  }, [hasMultiSelection, showAgent]);

  const distributeSelected = useCallback((axis: "horizontal" | "vertical") => {
    if (!activeTopology) return;
    const selected = activeTopology.nodes.filter((node) => canvasSelectedElementIds.includes(node.node_id));
    if (selected.length < 3) {
      setNotice("请先框选至少三台设备，再执行等距分布", false);
      return;
    }
    const sorted = [...selected].sort((left, right) => (axis === "horizontal" ? left.x - right.x : left.y - right.y));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const span = axis === "horizontal" ? last.x - first.x : last.y - first.y;
    const step = span / (sorted.length - 1);
    const updates = new Map<string, number>();
    sorted.forEach((node, index) => {
      if (index === 0 || index === sorted.length - 1) return;
      updates.set(node.node_id, Math.round((axis === "horizontal" ? first.x : first.y) + step * index));
    });
    pushState({
      ...activeTopology,
      nodes: activeTopology.nodes.map((node) => {
        const next = updates.get(node.node_id);
        if (next === undefined) return node;
        return { ...node, ...(axis === "horizontal" ? { x: next } : { y: next }) };
      }),
    });
    setNotice(`已等距分布 ${selected.length} 台设备`);
  }, [activeTopology, canvasSelectedElementIds, pushState, setNotice]);

  const applyDeviceTypeToSelection = useCallback((deviceType: string) => {
    if (!activeTopology) return;
    const ids = new Set(canvasSelectedElementIds.filter((id) => !id.startsWith("canvas-")));
    if (!ids.size) return;
    pushState({ ...activeTopology, nodes: activeTopology.nodes.map((node) => (ids.has(node.node_id) ? { ...node, device_type: deviceType } : node)) });
    setNotice(`已将 ${ids.size} 个节点的类型设为「${deviceType}」`);
  }, [activeTopology, canvasSelectedElementIds, pushState, setNotice]);

  const removeSelectedObjects = useCallback(async () => {
    if (!activeTopology) return;
    const nodeIds = canvasSelectedElementIds.filter((id) => !id.startsWith("canvas-"));
    const itemIds = canvasSelectedElementIds.filter((id) => id.startsWith("canvas-")).map((id) => id.replace(/^canvas-/, ""));
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
    pushState({
      ...activeTopology,
      nodes: activeTopology.nodes.filter((node) => !nodeSet.has(node.node_id)),
      links: activeTopology.links.filter((link) => !nodeSet.has(link.source_node_id) && !nodeSet.has(link.target_node_id)),
      canvas_items: (activeTopology.canvas_items || []).filter((item) => !itemSet.has(item.item_id)),
    });
    setSelectedElement(null);
    canvasApiRef.current?.clearSelection();
    setNotice(`已移除 ${nodeIds.length} 个节点、${itemIds.length} 个图元`);
  }, [activeTopology, canvasSelectedElementIds, pushState, setNotice]);

  const deleteSelection = useCallback(() => {
    if (!selectedElement) return;
    if (selectedElement.type === "node") void handleRemoveNode(selectedElement.nodeId);
    else if (selectedElement.type === "link") void handleRemoveLink(selectedElement.linkId);
    else if (selectedElement.type === "canvas_item") void handleRemoveCanvasItem(selectedElement.itemId);
  }, [selectedElement, handleRemoveNode, handleRemoveLink, handleRemoveCanvasItem]);

  /**
   * Auto-close dropdown menus (.studio-*-menu) on:
   * 1. Clicking outside the menu (anywhere on canvas, toolbar, etc.)
   * 2. Clicking an action button inside the menu (e.g. 矩形区域, 左对齐, 导出 PNG)
   * 3. Opening another menu (mutual exclusion so menus never stack/overlap)
   */
  useEffect(() => {
    const selector =
      ".topology-studio .studio-views-menu[open], .topology-studio .studio-insert-menu[open], .topology-studio .studio-align-menu[open], .topology-studio .studio-layout-menu[open], .topology-studio .studio-more[open]";

    const onPointerDown = (event: PointerEvent | MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const openMenus = document.querySelectorAll<HTMLDetailsElement>(selector);
      if (!openMenus.length) return;

      openMenus.forEach((menu) => {
        // If clicking inside this menu, don't close on pointerdown so clicks on buttons can fire
        if (menu.contains(target)) return;
        menu.removeAttribute("open");
      });
    };

    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const openMenus = document.querySelectorAll<HTMLDetailsElement>(selector);
      if (!openMenus.length) return;

      openMenus.forEach((menu) => {
        const content = menu.querySelector("div");
        if (content && content.contains(target)) {
          if (!target.closest(".view-remove")) {
            window.setTimeout(() => menu.removeAttribute("open"), 0);
          }
        }
      });
    };

    const onToggle = (event: Event) => {
      const target = event.target as HTMLDetailsElement;
      if (!target || target.tagName !== "DETAILS" || !target.open) return;
      if (!target.matches?.(selector)) return;

      const openMenus = document.querySelectorAll<HTMLDetailsElement>(selector);
      openMenus.forEach((other) => {
        if (other !== target) other.removeAttribute("open");
      });
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("toggle", onToggle, true);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("toggle", onToggle, true);
    };
  }, []);

  /**
   * Keyboard shortcuts. Every diagram tool people already know (draw.io,
   * Figma, Visio) is keyboard driven, and the canvas is where an operator
   * spends their time, so the common gestures get single keys.
   */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // A modal owns keyboard input, including when its focused control is a
      // button. Otherwise Delete can replace a confirmation and arrows can
      // change the drawing behind the dialog.
      if (document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]')) return;
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable=true]")) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo(); else handleUndo();
        return;
      }
      if (meta && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handleRedo();
        return;
      }
      if (meta && e.key.toLowerCase() === "a") {
        e.preventDefault();
        canvasApiRef.current?.selectAll();
        return;
      }
      if (meta && e.key.toLowerCase() === "d") {
        e.preventDefault();
        const selectedNodeId = selectedElement?.type === "node" ? selectedElement.nodeId : canvasSelectedElementIds[0];
        if (selectedNodeId) handleCloneNode(selectedNodeId);
        return;
      }
      if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (activeTopologyRef.current) void executeSave(activeTopologyRef.current);
        return;
      }
      if (meta) return;
      switch (e.key) {
        case "Escape":
          setContextMenu(null);
          setShowShortcutHelp(false);
          setFocusMode(false);
          setIsInspectorOpen(false);
          setSelectedElement(null);
          canvasApiRef.current?.clearSelection();
          // Escape cancels palette placement and cancels connect mode
          setArmedNodeType(null);
          setCanvasMode("select");
          document
            .querySelectorAll<HTMLDetailsElement>(
              ".topology-studio .studio-views-menu[open], .topology-studio .studio-insert-menu[open], .topology-studio .studio-align-menu[open], .topology-studio .studio-layout-menu[open], .topology-studio .studio-more[open]"
            )
            .forEach((d) => d.removeAttribute("open"));
          return;
        case "Delete":
        case "Backspace": {
          // Delete removes what is selected, whether that is one object or
          // several. It used to act only on the single inspector selection, so
          // pressing it with a marquee or Ctrl+A selection did nothing at all
          // while the batch panel happily removed the same set.
          e.preventDefault();
          if (canvasSelectedElementIds.length > 0) void removeSelectedObjects();
          else deleteSelection();
          return;
        }
        case "ArrowLeft":
        case "ArrowRight":
        case "ArrowUp":
        case "ArrowDown": {
          if (!canvasSelectedElementIds.length) return;
          e.preventDefault();
          const step = e.shiftKey ? 32 : 8;
          if (e.key === "ArrowLeft") nudgeSelected(-step, 0);
          else if (e.key === "ArrowRight") nudgeSelected(step, 0);
          else if (e.key === "ArrowUp") nudgeSelected(0, -step);
          else nudgeSelected(0, step);
          return;
        }
        case "/":
          e.preventDefault();
          searchInputRef.current?.focus();
          return;
        case "?":
          e.preventDefault();
          setShowShortcutHelp((value) => !value);
          return;
        default:
          break;
      }
      switch (e.key.toLowerCase()) {
        case "v": setCanvasMode("select"); break;
        case "c": setCanvasMode("connect"); break;
        case "t":
          e.preventDefault();
          setShowEditbar((value) => !value);
          break;
        case "g": if (e.shiftKey) setGridEnabled((value) => !value); break;
        case "i": setShowInterfaces((value) => !value); break;
        case "f":
          if (e.shiftKey) canvasApiRef.current?.focusIds(canvasSelectedElementIds, 1.2);
          else canvasApiRef.current?.fit();
          break;
        default: break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleUndo, handleRedo, executeSave, deleteSelection, removeSelectedObjects, nudgeSelected, canvasSelectedElementIds, handleCloneNode, selectedElement]);





  const handleAutoLayout = useCallback(async (algorithm: LayoutAlgorithm = "hierarchy-h") => {
    if (!activeTopology || activeTopology.nodes.length < 2) {
      setNotice("至少需要两台画布设备才可自动排布", false);
      return;
    }
    setLayoutBusy(true);
    try {
      const result = await layoutTopology(activeTopology, algorithm);
      if (activeTopologyRef.current !== activeTopology) { setNotice("图纸已变化，请重新排布", false); return; }
      pushState(result);
      const preset = LAYOUT_PRESETS.find((item) => item.id === algorithm);
      setNotice(`已按「${preset?.label || "分层"}」排布；已有分组随成员调整`);
    } catch { setNotice("自动排布失败，原图保持不变", false); }
    finally { setLayoutBusy(false); }
  }, [activeTopology, pushState, setNotice]);

  // Add group
  const handleCreateGroup = (e: FormEvent) => {
    e.preventDefault();
    if (!activeTopology || !groupNameInput.trim()) return;

    const newGroup: TopologyGroup = {
      group_id: `grp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: groupNameInput.trim(),
      kind: groupKindInput,
      x: 80,
      y: 80,
      width: 420,
      height: 300,
    };

    pushState({
      ...activeTopology,
      groups: [...activeTopology.groups, newGroup],
    });
    setShowGroupModal(false);
    setGroupNameInput("");
    setNotice("拓扑分组已创建");
  };

  // Create / Edit topology
  const handleSaveTopologyMeta = async (e: FormEvent) => {
    e.preventDefault();
    if (!topologyNameInput.trim()) return;

    if (topologyModalMode === "create") {
      try {
        const res = await apiRequest<{ topology: Topology }>({
          method: "POST",
          url: `${base}/topologies`,
          data: {
            workspace_id: workspaceId,
            name: topologyNameInput.trim(),
            description: topologyDescInput.trim(),
            nodes: [],
            links: [],
            groups: [],
          },
        });
        setTopologyModalMode(null);
        setTopologyNameInput("");
        setTopologyDescInput("");
        await onReload();
        setSelectedTopologyId(res.topology.topology_id);
        setNotice(`拓扑“${res.topology.name}”创建成功`);
      } catch (err: unknown) {
        setNotice((err as { message?: string })?.message || "创建拓扑失败", false);
      }
    } else if (topologyModalMode === "edit" && activeTopology) {
      // Renaming is an ordinary canvas edit, so it goes through the same
      // save path. A second hand-rolled PUT here reported a raw
      // "topology_version_conflict" to the user instead of offering the merge.
      const nextName = topologyNameInput.trim();
      setTopologyModalMode(null);
      pushState({ ...activeTopology, name: nextName, description: topologyDescInput.trim() });
      setNotice(`拓扑“${nextName}”信息已更新`);
    }
  };

  // Delete current topology
  const handleDeleteTopology = async () => {
    if (!activeTopology) return;
    const confirmed = await confirm({
      title: "永久删除网络拓扑",
      body: `将永久删除拓扑“${activeTopology.name}”。\n只删除这张图纸及版本历史。此操作不可撤销。`,
      confirmLabel: "永久删除拓扑",
      destructive: true,
    });
    if (!confirmed) return;

    try {
      await apiRequest({
        method: "DELETE",
        url: `${base}/topologies/${activeTopology.topology_id}`,
        data: { workspace_id: workspaceId },
      });
      setSelectedElement(null);
      await onReload();
      setNotice(`拓扑“${activeTopology.name}”已删除`);
    } catch (err: unknown) {
      setNotice((err as { message?: string })?.message || "删除拓扑失败", false);
    }
  };



  /**
   * Revision history. Only structural edits are stored, so this list reads as
   * "the decisions made on this drawing" rather than every mouse-up.
   */
  const handleOpenRevisions = useCallback(async () => {
    if (!activeTopology) return;
    setRevisionsLoading(true);
    setRevisionDiff(null);
    setShowRevisions(true);
    try {
      const res = await apiRequest<{ revisions: TopologyRevision[] }>({
        method: "GET",
        url: `${base}/topologies/${activeTopology.topology_id}/revisions`,
        params: { workspace_id: workspaceId },
      });
      setRevisions(res.revisions || []);
    } catch {
      setNotice("版本历史读取失败，请稍后重试", false);
    } finally {
      setRevisionsLoading(false);
    }
  }, [activeTopology, workspaceId, setNotice]);

  const handleDiffRevision = useCallback(async (revisionId: string) => {
    if (!activeTopology) return;
    setDiffLoading(true);
    try {
      const res = await apiRequest<{ diff: RevisionDiff }>({
        method: "GET",
        url: `${base}/topologies/${activeTopology.topology_id}/revisions/${revisionId}/diff`,
        params: { workspace_id: workspaceId },
      });
      setRevisionDiff(res.diff);
    } catch {
      setNotice("版本差异读取失败，请稍后重试", false);
    } finally {
      setDiffLoading(false);
    }
  }, [activeTopology, workspaceId, setNotice]);

  /**
   * Agent conclusions land on the server, not in the canvas component.  After a
   * turn finishes we reconcile: adopt the server drawing when the local canvas
   * has nothing unsaved, and never silently overwrite pending local edits.
   */
  const handleAgentCompleted = useCallback(async () => {
    if (!activeTopology) return;
    try {
      const res = await apiRequest<{ topology: Topology }>({
        method: "GET",
        url: `${base}/topologies/${activeTopology.topology_id}`,
        params: { workspace_id: workspaceId },
      });
      const remote = res.topology;
      if (!remote || remote.version === activeTopologyRef.current?.version) return;
      if (saveStatusRef.current !== "saved") {
        setNotice("Agent 已更新服务端图纸；本地还有未保存改动，保存后即可看到结论", false);
        return;
      }
      // The agent wrote on the server, so this is a server-confirmed state,
      // not a local edit waiting to be saved.
      adoptServerTopology(remote);
      setNotice(`Agent 已把结论写回画布（版本 ${activeTopology.version} → ${remote.version}）`, true);
    } catch {
      // A failed reconciliation must not disturb the canvas the user is on.
    }
  }, [activeTopology, workspaceId, adoptServerTopology, setNotice]);

  const handleRestoreRevision = useCallback(async (revisionId: string) => {
    if (!activeTopology) return;
    setRestoringId(revisionId);
    try {
      const res = await apiRequest<{ topology: Topology }>({
        method: "POST",
        url: `${base}/topologies/${activeTopology.topology_id}/revisions/${revisionId}/restore`,
        params: { workspace_id: workspaceId },
      });
      if (res.topology) {
        // Keep the pre-restore drawing on the undo stack, but treat the
        // restored one as already saved — it is, the server just wrote it.
        setHistory((prev) => [...prev.slice(-20), activeTopology]);
        setFuture([]);
        adoptServerTopology(res.topology);
        const restoredVersion = revisions.find((item) => item.revision_id === revisionId)?.version;
        setNotice(
          restoredVersion
            ? `已按版本 ${restoredVersion} 的结构恢复，节点位置保持当前布局`
            : "已按所选版本的结构恢复，节点位置保持当前布局",
          true,
        );
      }
      setShowRevisions(false);
      setRevisionDiff(null);
    } catch (err: unknown) {
      setNotice((err as { message?: string })?.message || "恢复失败，请稍后重试", false);
    } finally {
      setRestoringId("");
    }
  }, [activeTopology, workspaceId, adoptServerTopology, setNotice, revisions]);

  // Node selection inspector helpers
  const selectedNode = useMemo(() => {
    if (selectedElement?.type !== "node" || !activeTopology) return null;
    return activeTopology.nodes.find((n) => n.node_id === selectedElement.nodeId) || null;
  }, [selectedElement, activeTopology]);



  // Edge selection inspector helpers
  const selectedLink = useMemo(() => {
    if (selectedElement?.type !== "link" || !activeTopology) return null;
    return activeTopology.links.find((l) => l.link_id === selectedElement.linkId) || null;
  }, [selectedElement, activeTopology]);

  // Group selection inspector helpers
  const selectedGroup = useMemo(() => {
    if (selectedElement?.type !== "group" || !activeTopology) return null;
    return activeTopology.groups.find((g) => g.group_id === selectedElement.groupId) || null;
  }, [selectedElement, activeTopology]);

  const selectedCanvasItem = useMemo(() => {
    if (selectedElement?.type !== "canvas_item" || !activeTopology) return null;
    return (activeTopology.canvas_items || []).find((item) => item.item_id === selectedElement.itemId) || null;
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
          <Button variant="primary" icon={<IconRefresh size={14} />} onClick={() => void onReload()}>
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
          <p>用符号、连线、图元和分组绘制网络结构，也可以让绘图 Skill 帮你完成。图纸不连接真实设备。</p>
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
          <dialog open role="dialog" aria-modal="true" className="network-dialog-modal">
            <form onSubmit={handleSaveTopologyMeta} className="network-panel modal-panel">
              <div className="modal-header">
                <h3>新建网络拓扑</h3>
                <Button size="sm" onClick={() => setTopologyModalMode(null)}>
                  <IconClose size={14} />
                </Button>
              </div>
              <div className="form-grid">
                <label className="full-field">
                  拓扑名称
                  <input
                    required
                    placeholder="如：核心数据中心骨干拓扑"
                    value={topologyNameInput}
                    onChange={(e) => setTopologyNameInput(e.target.value)}
                  />
                </label>
                <label className="full-field">
                  拓扑说明（可选）
                  <textarea
                    placeholder="描述该拓扑覆盖的业务范围、骨干协议或网络边界"
                    value={topologyDescInput}
                    onChange={(e) => setTopologyDescInput(e.target.value)}
                  />
                </label>
              </div>
              <div className="modal-actions">
                <Button type="button" onClick={() => setTopologyModalMode(null)}>
                  取消
                </Button>
                <Button variant="primary" type="submit" disabled={busy}>
                  创建拓扑
                </Button>
              </div>
            </form>
          </dialog>
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
          <div className="topology-empty-icon"><IconRefresh size={36} /></div>
          <h3>正在打开网络拓扑</h3>
          <p>正在加载图纸。</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`network-topology-workspace topology-studio ${showLibrary ? "library-open" : ""} ${showAgent ? "agent-open" : ""} ${isInspectorOpen && !showAgent ? "inspector-open" : ""} ${focusMode ? "focus-mode" : ""}`}>
      {/* 1. Left Panel: Topology selector + Device Palette + Group Palette */}
      <aside className="topology-sidebar">
        <div className="topology-sidebar-section topology-select-section">
          <div className="section-title-row">
            <span className="section-title">网络拓扑 ({topologies.length})</span>
            <Button
              size="sm"
              icon={<IconPlus size={12} />}
              onClick={() => {
                setTopologyModalMode("create");
                setTopologyNameInput("");
                setTopologyDescInput("");
              }}
            >
              新建
            </Button>
          </div>
          <div className="topology-dropdown-wrap">
            <select
              aria-label="选择网络拓扑"
              value={selectedTopologyId}
              disabled={saveStatus !== "saved"}
              onChange={(e) => {
                setSelectedTopologyId(e.target.value);
                setSelectedElement(null);
              }}
              className="topology-select-control"
            >
              {topologies.map((t) => (
                <option key={t.topology_id} value={t.topology_id}>
                  {t.name} ({t.nodes.length} 节点)
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Drawing-device palette. Type first, asset second: eNSP and HCL both
            lead with the model palette, because sketching a topology starts
            from "a firewall goes here", not from "which firewall is it". */}
        <div className="topology-sidebar-section palette-type-section">
          <div className="section-title-row">
            <span className="section-title">图纸设备</span>
            <small className="section-subtitle">{armedNodeType ? "已选中 · 待放置" : "点选后在画布单击"}</small>
          </div>
          <div className="palette-type-grid">
            {DRAWING_DEVICE_TYPES.map((type) => (
              <button
                key={type.value}
                type="button"
                className={`palette-type-item ${armedNodeType === type.value ? "is-armed" : ""}`}
                data-testid={`palette-type-${type.value}`}
                aria-pressed={armedNodeType === type.value}
                draggable
                onDragStart={(event) => handleTypeDragStart(event, type.value)}
                onClick={() => {
                  setCanvasMode("select");
                  setArmedNodeType((current) => (current === type.value ? null : type.value));
                }}
                title={`${type.label}：点选后在画布空白处单击放置，或直接拖到画布上`}
              >
                <DeviceTypeIcon deviceType={type.value} size={16} />
                <span>{type.label}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="palette-type-more"
            onClick={() => { setManualNodeName(""); setManualNodeType("switch"); setShowManualNodeModal(true); }}
          >
            需要先定名称？新建图纸设备…
          </button>
        </div>



        {/* Group Palette */}
        <div className="topology-sidebar-section palette-group-section">
          <div className="section-title-row">
            <span className="section-title">拓扑分组 ({activeTopology?.groups?.length || 0})</span>
            <Button
              size="sm"
              icon={<IconPlus size={12} />}
              onClick={() => {
                setShowGroupModal(true);
                setGroupNameInput("");
              }}
            >
              分组
            </Button>
          </div>
          <div className="palette-group-list">
            {activeTopology?.groups?.length ? (
              activeTopology.groups.map((g) => (
                <div
                  key={g.group_id}
                  className={`palette-group-item ${selectedElement?.type === "group" && selectedElement.groupId === g.group_id ? "active" : ""}`}
                  onClick={() => setSelectedElement({ type: "group", groupId: g.group_id })}
                >
                  <IconGrid size={14} />
                  <span className="palette-group-name">{g.name}</span>
                  <span className="group-kind-tag">{g.kind}</span>
                </div>
              ))
            ) : (
              <div className="palette-empty-groups">尚未创建分组</div>
            )}
          </div>
        </div>
      </aside>

      {/* 2. Center: Canvas */}
      <main className="topology-canvas-area">
        {/* Canvas Toolbar */}
        <div className="topology-canvas-toolbar">
          <div className="toolbar-left">
            <button className="studio-icon-button" title="设备库与拓扑列表" aria-label="设备库与拓扑列表" aria-pressed={showLibrary} onClick={() => setShowLibrary((value) => !value)}><IconLayers size={18} /></button>
            <strong className="topology-canvas-title">{activeTopology?.name}</strong>
            <div className={`topology-save-indicator status-${saveStatus}`}>
              {saveStatus === "saved" ? (
                <>
                  <IconCheck size={12} />
                  <span>已保存</span>
                </>
              ) : saveStatus === "saving" ? (
                <>
                  <IconSave size={12} className="spin-icon" />
                  <span>正在保存...</span>
                </>
              ) : saveStatus === "conflict" ? (
                <button type="button" onClick={() => setShowConflict(true)} title="这张图纸被其他人修改过，点击选择如何处理">
                  <IconAlert size={12} />
                  <span>有冲突待处理</span>
                </button>
              ) : (
                <>
                  <IconSave size={12} />
                  <span>未保存修改</span>
                </>
              )}
            </div>
            {!showEditbar && (
              <div className="studio-mini-mode-switch" role="group" aria-label="快捷绘图模式">
                <button
                  type="button"
                  className={canvasMode === "select" ? "is-active" : ""}
                  aria-pressed={canvasMode === "select"}
                  onClick={() => setCanvasMode("select")}
                  title="选择模式 (快捷键 V)"
                >
                  <IconMenu size={12} />
                  <span>选择</span>
                </button>
                <button
                  type="button"
                  className={canvasMode === "connect" ? "is-active" : ""}
                  aria-pressed={canvasMode === "connect"}
                  onClick={() => setCanvasMode("connect")}
                  title="连线模式 (快捷键 C)"
                >
                  <IconLink size={12} />
                  <span>连线</span>
                </button>
                <button
                  type="button"
                  onClick={() => canvasApiRef.current?.fit()}
                  title="适配视图到画布中央 (快捷键 F)"
                >
                  <IconExpand size={12} />
                  <span>适配</span>
                </button>
              </div>
            )}
          </div>

          <div className="toolbar-right">
            <div className="canvas-search-wrap">
              <IconSearch size={13} />
              <input
                ref={searchInputRef}
                value={canvasQuery}
                placeholder="搜索设备"
                aria-label="在画布中搜索设备"
                onChange={(event) => setCanvasQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setCanvasQuery("");
                    searchInputRef.current?.blur();
                  } else if (event.key === "Enter" && canvasMatches.length > 0) {
                    focusCanvasObject(canvasMatches[0].id, canvasMatches[0].kind);
                    setCanvasQuery("");
                    searchInputRef.current?.blur();
                  }
                }}
                onBlur={() => window.setTimeout(() => setCanvasQuery(""), 180)}
              />
              {canvasQuery && (
                <button
                  type="button"
                  className="canvas-search-clear"
                  aria-label="清空搜索"
                  title="清空搜索"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setCanvasQuery("");
                    searchInputRef.current?.focus();
                  }}
                >
                  ✕
                </button>
              )}
              {canvasQuery && canvasMatches.length > 0 && (
                <div className="canvas-search-results">
                  {canvasMatches.map((match) => (
                    <button key={match.id} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => focusCanvasObject(match.id, match.kind)}>
                      <span>{match.label}</span>
                      <small>{match.detail}</small>
                    </button>
                  ))}
                </div>
              )}
              {canvasQuery && canvasMatches.length === 0 && (
                <div className="canvas-search-results">
                  <div className="canvas-search-empty">未找到匹配设备</div>
                </div>
              )}
            </div>
            <details className="studio-views-menu">
              <summary>视图</summary>
              <div>
                <button type="button" onClick={saveBookmark}>保存当前视图…</button>
                {bookmarks.length === 0 && <small>尚未保存视图</small>}
                {bookmarks.map((bookmark) => (
                  <span key={bookmark.name} className="view-row">
                    <button type="button" onClick={() => applyBookmark(bookmark)}>{bookmark.name}</button>
                    <button type="button" className="view-remove" aria-label={`删除视图 ${bookmark.name}`} onClick={() => removeBookmark(bookmark.name)}>×</button>
                  </span>
                ))}
              </div>
            </details>
            <Button
              size="sm"
              icon={showEditbar ? <IconChevronUp size={13} /> : <IconWrench size={13} />}
              variant={showEditbar ? "default" : "ghost"}
              onClick={() => setShowEditbar((v) => !v)}
              title={showEditbar ? "收起编辑工具条 (快捷键 T)" : "展开编辑工具条 (快捷键 T)"}
              aria-expanded={showEditbar}
            >
              {showEditbar ? "收起工具" : "展开工具"}
            </Button>
            <button className="studio-icon-button" aria-label={focusMode ? "退出专注画布" : "专注画布"} title="专注画布" onClick={() => setFocusMode((value) => !value)}><IconExpand size={18} /></button>
            <Button size="sm" icon={<IconSparkle size={15} />} variant={showAgent ? "primary" : "default"} onClick={() => { setShowAgent((value) => !value); setIsInspectorOpen(false); }}>绘图对话</Button>
          </div>
        </div>
        {showEditbar && (
          <div className="topology-editbar">
          <div className="studio-edit-tools" role="group" aria-label="画布工具">
            <button className="studio-mode-button" aria-label="选择" aria-pressed={canvasMode === "select" && !armedNodeType} onClick={() => { setCanvasMode("select"); setArmedNodeType(null); }} title="选择模式 (快捷键 V)"><IconMenu size={13} />选择</button>
            <button className="studio-mode-button" aria-label="连线" aria-pressed={canvasMode === "connect"} onClick={() => { setCanvasMode("connect"); setArmedNodeType(null); }} title="极速连线模式 (快捷键 C)"><IconLink size={13} />连线</button>
            <div className="studio-device-ribbon" role="toolbar" aria-label="常用设备快速放置">
              <span className="ribbon-label">设备:</span>
              {QUICK_PALETTE_DEVICES.map((dev) => {
                const isActive = armedNodeType === dev.value;
                return (
                  <button
                    key={dev.value}
                    type="button"
                    className={`studio-device-chip ${isActive ? "is-active" : ""}`}
                    title={`连续放置 ${dev.label}（点击后在画布连续点击，Esc或右键退出）`}
                    onClick={() => {
                      if (isActive) {
                        setArmedNodeType(null);
                      } else {
                        setCanvasMode("select");
                        setArmedNodeType(dev.value);
                      }
                    }}
                  >
                    <img src={dev.icon} alt="" className="device-chip-img" />
                    <span>{dev.label}</span>
                  </button>
                );
              })}
            </div>
            <button className="studio-mode-button" type="button" onClick={() => canvasApiRef.current?.fit()} title="适配视图到画布中央 (快捷键 F)"><IconExpand size={13} />适配</button>
            <details className="studio-insert-menu"><summary><IconBox size={13} />插入</summary><div>
              <button type="button" onClick={() => handleAddCanvasItem("rectangle")}>矩形区域</button>
              <button type="button" onClick={() => handleAddCanvasItem("ellipse")}>椭圆标注</button>
              <button type="button" onClick={() => handleAddCanvasItem("text")}>文本框</button>
            </div></details>
            <details className="studio-align-menu"><summary><IconArrowsX size={13} />对齐</summary><div>
              <button onClick={() => handleAlignSelectedNodes("left")}>左对齐</button><button onClick={() => handleAlignSelectedNodes("center")}>水平居中</button><button onClick={() => handleAlignSelectedNodes("right")}>右对齐</button>
              <button onClick={() => handleAlignSelectedNodes("top")}>顶对齐</button><button onClick={() => handleAlignSelectedNodes("middle")}>垂直居中</button><button onClick={() => handleAlignSelectedNodes("bottom")}>底对齐</button>
            </div></details>
          </div>
          <div className="toolbar-right">
            <Button
              size="sm"
              icon={<IconUndo size={13} />}
              disabled={!history.length || saveStatus === "conflict"}
              onClick={handleUndo}
              title="撤销 (Ctrl+Z / Cmd+Z)"
            >
              撤销
            </Button>
            <Button
              size="sm"
              icon={<IconRedo size={13} />}
              disabled={!future.length || saveStatus === "conflict"}
              onClick={handleRedo}
              title="恢复已撤销的操作 (Ctrl+Y / Cmd+Shift+Z)"
            >
              恢复
            </Button>
            <details className="studio-layout-menu">
              <summary className={layoutBusy || (activeTopology?.nodes?.length || 0) < 2 ? "is-disabled" : ""}><IconGrid size={13} />{layoutBusy ? "排布中" : "自动排布"}</summary>
              <div>
                {LAYOUT_PRESETS.map((preset) => (
                  <button key={preset.id} type="button" title={preset.hint} onClick={() => void handleAutoLayout(preset.id)}>
                    <strong>{preset.label}</strong>
                    <small>{preset.hint}</small>
                  </button>
                ))}
              </div>
            </details>

            <Button
              size="sm"
              icon={<IconClock size={13} />}
              onClick={() => void handleOpenRevisions()}
              disabled={revisionsLoading || !activeTopology}
              title="查看图纸的结构变更历史并按需恢复"
            >
              {revisionsLoading ? "读取中…" : "版本历史"}
            </Button>
            <details className="studio-more"><summary>更多</summary><div>
            <Button
              size="sm"
              icon={<IconSave size={13} />}
              onClick={() => exportCanvas("png")}
              title="导出整张拓扑为 PNG"
            >
              导出 PNG
            </Button>
            <Button
              size="sm"
              icon={<IconSave size={13} />}
              onClick={() => exportCanvas("svg")}
              title="导出整张拓扑为矢量 SVG"
            >
              导出 SVG
            </Button>
            <Button
              size="sm"
              icon={<IconSave size={13} />}
              onClick={() => void exportCanvas("pdf")}
              title="导出为可交付的单页 PDF"
            >
              导出 PDF
            </Button>
            <Button
              size="sm"
              icon={<IconEdit size={13} />}
              onClick={() => {
                if (activeTopology) {
                  setTopologyModalMode("edit");
                  setTopologyNameInput(activeTopology.name);
                  setTopologyDescInput(activeTopology.description);
                }
              }}
            >
              编辑信息
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={<IconTrash size={13} />}
              onClick={handleDeleteTopology}
            >
              删除拓扑
            </Button>
            <Button
              size="sm"
              icon={<IconEye size={13} />}
              onClick={() => { setIsInspectorOpen((open) => !open); setShowAgent(false); }}
              aria-pressed={isInspectorOpen}
            >
              {isInspectorOpen ? "收起详情" : "查看详情"}
            </Button>
            </div></details>
          </div>
        </div>
        )}

        {/* NetOps Cytoscape canvas, with LZCore topology persistence and evidence kept outside the renderer. */}
        <div className={`topology-canvas-viewport mode-${canvasMode}`} ref={viewportRef}>
          <div className="studio-canvas-caption"><strong>{activeTopology?.nodes.length || 0} 个节点</strong><span>·</span><span>{activeTopology?.links.length || 0} 条连接</span>{canvasSelectedElementIds.length > 0 && <span className="canvas-selection-count">已选 {canvasSelectedElementIds.length} 个对象</span>}
            <span className="canvas-mode-hint">
              {canvasMode === "connect"
                ? "连线模式：点击或拖拽连接两台设备 (自动配对接口，Esc 退出)"
                : armedNodeType
                  ? "点击空白处连续放置设备 (Esc 或右键退出)"
                  : "空白处左键拖拽直接框选 · 空格+拖拽/中键平移 · C 连线 · ⌘D 克隆"}
            </span><label><input type="checkbox" checked={showInterfaces} onChange={(event) => setShowInterfaces(event.target.checked)} />接口标签</label><label><input type="checkbox" checked={gridEnabled} onChange={(event) => setGridEnabled(event.target.checked)} />网格</label></div>
          {!activeTopology?.nodes?.length && (
            <div className="topology-canvas-onboarding">
              <div className="topology-canvas-onboarding-card">
                <IconBranch size={24} />
                <div>
                  <strong>从符号开始建图</strong>
                  <p>从左侧图形库放入节点，再用连线工具把它们接上。</p>
                </div>
                <Button size="sm" variant="primary" onClick={() => setShowManualNodeModal(true)}>放入节点</Button>
              </div>
            </div>
          )}
          <NetOpsCanvas
            topology={activeTopology}
            mode={canvasMode}
            gridEnabled={gridEnabled}
            showInterfaces={showInterfaces}
            onSelectNode={(nodeId) => { setSelectedElement({ type: "node", nodeId }); setIsInspectorOpen(true); }}
            onSelectCanvasItem={(itemId) => { setSelectedElement({ type: "canvas_item", itemId }); setIsInspectorOpen(true); }}
            onSelectLink={(linkId) => { setSelectedElement({ type: "link", linkId }); setIsInspectorOpen(true); }}
            onClearSelection={() => { setSelectedElement(null); setIsInspectorOpen(false); }}
            onSelectionChange={(ids) => {
              setCanvasSelectedElementIds(ids);
              if (ids.length === 1) {
                const id = ids[0];
                if (id.startsWith("canvas-")) setSelectedElement({ type: "canvas_item", itemId: id.slice(7) });
                else setSelectedElement({ type: "node", nodeId: id });
                setIsInspectorOpen(true);
              } else if (!ids.length) {
                setSelectedElement((prev) => (prev?.type === "link" ? prev : null));
              }
            }}
            onMoveElements={handleNetOpsMove}
            onConnect={handleFastConnect}
            armedNodeType={armedNodeType}
            onPlaceNodeType={placeDrawingNode}
            onDisarmNodeType={disarmNodeType}
            onReady={(api) => { canvasApiRef.current = api; }}
            onContextMenu={setContextMenu}
            onOpenInspector={() => setIsInspectorOpen(true)}
            onViewportChange={updatePopoverAnchor}
          />

          {/* Floating Bubble Popover Inspector */}
          {/* 3. Right: Inspector */}
      <aside
        ref={inspectorRef}
        className={`topology-inspector ${isInspectorOpen ? "is-open" : ""} ${isDragged ? "is-dragged" : (popoverPlacement ? `placement-${popoverPlacement}` : "")} ${isDragging ? "is-dragging" : ""}`}
        style={popoverStyle}
        aria-label="拓扑详情"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {hasMultiSelection ? (
          <div className="inspector-panel">
            <div className="inspector-header" onMouseDown={handleHeaderMouseDown}>
              <div className="inspector-header-left">
                <span className="inspector-drag-grip" title="按住拖拽移动弹窗">⋮⋮</span>
                <div className="inspector-icon-wrap">
                  <IconBox size={16} style={{ color: "var(--accent)" }} />
                </div>
                <div className="inspector-header-titles">
                  <h4>已选 {selectedNodes.length + selectedCanvasItems.length} 个对象</h4>
                  <span className="inspector-badge">{selectedNodes.length} 台设备 · {selectedCanvasItems.length} 个图元</span>
                </div>
              </div>
              <div className="inspector-header-actions">
                <Button size="sm" onClick={() => canvasApiRef.current?.clearSelection()} aria-label="取消选择"><IconClose size={13} /></Button>
              </div>
            </div>
            <div className="inspector-body">
              <div className="inspector-section">
                <span className="inspector-label">对齐</span>
                <div className="batch-grid">
                  {([["left", "左对齐"], ["center", "水平居中"], ["right", "右对齐"], ["top", "顶对齐"], ["middle", "垂直居中"], ["bottom", "底对齐"]] as const).map(([value, label]) => (
                    <Button key={value} size="sm" onClick={() => handleAlignSelectedNodes(value)}>{label}</Button>
                  ))}
                </div>
                <span className="inspector-label">分布</span>
                <div className="batch-grid">
                  <Button size="sm" onClick={() => distributeSelected("horizontal")}>水平等距</Button>
                  <Button size="sm" onClick={() => distributeSelected("vertical")}>垂直等距</Button>
                </div>
                <span className="inspector-label">批量设置设备类型</span>
                <select aria-label="批量设置设备类型" defaultValue="" onChange={(event) => { if (event.target.value) applyDeviceTypeToSelection(event.target.value); event.target.value = ""; }}>
                  <option value="">选择类型…</option>
                  {batchTypeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <span className="inspector-label">危险操作</span>
                <Button size="sm" variant="danger" icon={<IconTrash size={13} />} onClick={() => void removeSelectedObjects()}>移除选中的对象</Button>
              </div>
            </div>
          </div>
        ) : selectedElement?.type === "node" && selectedNode ? (
          <div className="inspector-panel">
            <div className="inspector-header" onMouseDown={handleHeaderMouseDown}>
              <div className="inspector-header-left">
                <span className="inspector-drag-grip" title="按住拖拽移动弹窗">⋮⋮</span>
                <div className="inspector-icon-wrap">
                  <img
                    src={netOpsIconForDeviceType(selectedNode.device_type || "switch")}
                    alt=""
                    className="inspector-header-icon"
                  />
                </div>
                <div className="inspector-header-titles">
                  <h4>{selectedNode.display_name || "图纸设备"}</h4>
                  <div className="inspector-header-meta">
                    <span className="inspector-type-pill">
                      {deviceTypeMap.get(selectedNode.device_type || "") || selectedNode.device_type || "设备"}
                    </span>
                    {selectedNode.labels?.length ? (
                      <span className="inspector-label-tag">{selectedNode.labels.join(", ")}</span>
                    ) : null}
                  </div>
                </div>
              </div>
              <div className="inspector-header-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  title="克隆设备 (⌘D)"
                  aria-label="克隆设备"
                  onClick={() => handleCloneNode(selectedNode.node_id)}
                >
                  <IconCopy size={13} />
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setSelectedElement(null);
                    setIsInspectorOpen(false);
                  }}
                  aria-label="收起节点详情"
                >
                  <IconClose size={13} />
                </Button>
              </div>
            </div>

            <div className="inspector-body">
              <div className="inspector-section">
                <label className="inspector-field">
                  图纸图标
                  <select
                    aria-label="图纸图标"
                    value={selectedNode.device_type || "switch"}
                    onChange={(e) => {
                      if (!activeTopology) return;
                      const type = e.target.value;
                      const updated = activeTopology.nodes.map((n) =>
                        n.node_id === selectedNode.node_id ? { ...n, device_type: type } : n
                      );
                      pushState({ ...activeTopology, nodes: updated });
                    }}
                  >
                    {DRAWING_DEVICE_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </label>

                <label className="inspector-field">
                  拓扑显示名称（可选）
                  <input
                    value={selectedNode.display_name || ""}
                    placeholder={"设备名称"}
                    onChange={(e) => {
                      if (!activeTopology) return;
                      const val = e.target.value;
                      const updated = activeTopology.nodes.map((n) =>
                        n.node_id === selectedNode.node_id ? { ...n, display_name: val || undefined } : n
                      );
                      pushState({ ...activeTopology, nodes: updated });
                    }}
                  />
                </label>

                <label className="inspector-field">
                  业务标签（逗号分隔）
                  <input
                    value={(selectedNode.labels || []).join(", ")}
                    placeholder="如：core, bgp, spine"
                    onChange={(e) => {
                      if (!activeTopology) return;
                      const raw = e.target.value;
                      const labels = raw
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean);
                      const updated = activeTopology.nodes.map((n) =>
                        n.node_id === selectedNode.node_id ? { ...n, labels: labels.length ? labels : undefined } : n
                      );
                      pushState({ ...activeTopology, nodes: updated });
                    }}
                  />
                </label>

                <label className="inspector-field">
                  所属分组
                  <select
                    value={selectedNode.group_id || ""}
                    onChange={(e) => {
                      if (!activeTopology) return;
                      const val = e.target.value || undefined;
                      const updated = activeTopology.nodes.map((n) =>
                        n.node_id === selectedNode.node_id ? { ...n, group_id: val } : n
                      );
                      pushState({ ...activeTopology, nodes: updated });
                    }}
                  >
                    <option value="">未指定分组</option>
                    {(activeTopology?.groups || []).map((g) => (
                      <option key={g.group_id} value={g.group_id}>
                        {g.name} ({g.kind})
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="inspector-section">
                <span className="inspector-label">关联拓扑链路</span>
                <div className="inspector-link-list">
                  {activeTopology?.links
                    ?.filter(
                      (l) =>
                        l.source_node_id === selectedNode.node_id ||
                        l.target_node_id === selectedNode.node_id
                    )
                    .map((l) => {
                      const otherId =
                        l.source_node_id === selectedNode.node_id
                          ? l.target_node_id
                          : l.source_node_id;
                      const otherName = nodeLabelById.get(otherId) || otherId;
                      const isSrc = l.source_node_id === selectedNode.node_id;
                      return (
                        <div
                          key={l.link_id}
                          className="inspector-link-item"
                          onClick={() => setSelectedElement({ type: "link", linkId: l.link_id })}
                        >
                          <span className={`link-kind-dot ${l.kind}`} />
                          <span>
                            {isSrc ? l.source_interface : l.target_interface} ↔ {otherName} (
                            {isSrc ? l.target_interface : l.source_interface})
                          </span>
                        </div>
                      );
                    }) || null}
                </div>
              </div>

              <div className="inspector-actions">
                <Button
                  variant="danger"
                  icon={<IconTrash size={13} />}
                  onClick={() => handleRemoveNode(selectedNode.node_id)}
                >
                  从拓扑中移除节点
                </Button>
              </div>
            </div>
          </div>
        ) : selectedElement?.type === "link" && selectedLink ? (
          <div className="inspector-panel">
            <div className="inspector-header" onMouseDown={handleHeaderMouseDown}>
              <div className="inspector-header-left">
                <span className="inspector-drag-grip" title="按住拖拽移动弹窗">⋮⋮</span>
                <div className="inspector-icon-wrap">
                  <IconBranch size={16} style={{ color: "var(--accent)" }} />
                </div>
                <div className="inspector-header-titles">
                  <h4>链路属性</h4>
                  <span className="inspector-badge">
                    {nodeLabelById.get(selectedLink.source_node_id) || selectedLink.source_node_id} ↔ {nodeLabelById.get(selectedLink.target_node_id) || selectedLink.target_node_id}
                  </span>
                </div>
              </div>
              <div className="inspector-header-actions">
                <Button
                  size="sm"
                  onClick={() => {
                    setSelectedElement(null);
                    setIsInspectorOpen(false);
                  }}
                  aria-label="收起链路详情"
                >
                  <IconClose size={13} />
                </Button>
              </div>
            </div>

            <div className="inspector-body">
              <div className="inspector-section">
              <div className="inspector-endpoints-card">
                <div className="endpoint-col">
                  <small>源端</small>
                  <strong>{nodeLabelById.get(selectedLink.source_node_id) || selectedLink.source_node_id}</strong>
                  <input
                    value={selectedLink.source_interface}
                    aria-label="源端接口"
                    placeholder="源接口"
                    onChange={(e) => {
                      if (!activeTopology) return;
                      const val = e.target.value;
                      const updated = activeTopology.links.map((l) =>
                        l.link_id === selectedLink.link_id ? { ...l, source_interface: val } : l
                      );
                      pushState({ ...activeTopology, links: updated });
                    }}
                  />
                </div>
                <div className="endpoint-divider">↔</div>
                <div className="endpoint-col">
                  <small>对端</small>
                  <strong>{nodeLabelById.get(selectedLink.target_node_id) || selectedLink.target_node_id}</strong>
                  <input
                    value={selectedLink.target_interface}
                    aria-label="对端接口"
                    placeholder="对端接口"
                    onChange={(e) => {
                      if (!activeTopology) return;
                      const val = e.target.value;
                      const updated = activeTopology.links.map((l) =>
                        l.link_id === selectedLink.link_id ? { ...l, target_interface: val } : l
                      );
                      pushState({ ...activeTopology, links: updated });
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="inspector-section">
              <label className="inspector-field">
                链路状态
                <select
                  value={selectedLink.status}
                  onChange={(e) => {
                    if (!activeTopology) return;
                    const val = e.target.value as "unknown" | "up" | "down";
                    const updated = activeTopology.links.map((l) =>
                      l.link_id === selectedLink.link_id ? { ...l, status: val } : l
                    );
                    pushState({ ...activeTopology, links: updated });
                  }}
                >
                  <option value="unknown">未知 (缺少证据)</option>
                  <option value="up">图纸标注：UP（非运行结论）</option>
                  <option value="down">图纸标注：DOWN（非运行结论）</option>
                </select>
              </label>

              <div className="inspector-label" style={{ marginTop: "4px" }}>连线外观与形态</div>

              <div className="inspector-field">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span>走线形态</span>
                  {selectedLink.style?.curve_style === "bezier" && (
                    <button
                      type="button"
                      className="curve-reverse-btn"
                      onClick={() => {
                        if (!activeTopology) return;
                        const isRev = !selectedLink.style?.curve_reverse;
                        const updated = activeTopology.links.map((l) =>
                          l.link_id === selectedLink.link_id
                            ? { ...l, style: { ...l.style, curve_reverse: isRev } }
                            : l
                        );
                        pushState({ ...activeTopology, links: updated });
                      }}
                      title="翻转圆弧弯曲朝向"
                    >
                      {selectedLink.style?.curve_reverse ? "⤹ 弧向(下)" : "⤥ 弧向(上)"}
                    </button>
                  )}
                </div>
                <div className="curve-style-chips">
                  {[
                    {
                      id: "auto",
                      name: "自动避让",
                      tip: "默认：智能避让·并行链路自动分流",
                      icon: (
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                          <path d="M2 11C6 11 10 5 14 5" />
                          <path d="M2 14C7 14 9 8 14 8" strokeDasharray="2 2" />
                        </svg>
                      ),
                    },
                    {
                      id: "taxi",
                      name: "正交折线",
                      tip: "正交折线·机柜机房规范布线",
                      icon: (
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                          <path d="M2 13H8V4H14" />
                        </svg>
                      ),
                    },
                    {
                      id: "bezier",
                      name: "圆弧曲线",
                      tip: "平滑弧线·跨区域美观弧线",
                      icon: (
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                          <path d="M2 13C6 4 10 4 14 13" />
                        </svg>
                      ),
                    },
                    {
                      id: "straight",
                      name: "直线直达",
                      tip: "最短直达·两点直接相连",
                      icon: (
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                          <line x1="2" y1="13" x2="14" y2="3" />
                        </svg>
                      ),
                    },
                  ].map((option) => {
                    const currentStyle = selectedLink.style?.curve_style || "auto";
                    const isActive = currentStyle === option.id;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        className={`curve-chip ${isActive ? "is-active" : ""}`}
                        onClick={() => {
                          if (!activeTopology) return;
                          const val = option.id as "auto" | "bezier" | "straight" | "taxi";
                          const updated = activeTopology.links.map((l) =>
                            l.link_id === selectedLink.link_id
                              ? { ...l, style: { ...l.style, curve_style: val === "auto" ? undefined : val } }
                              : l
                          );
                          pushState({ ...activeTopology, links: updated });
                        }}
                        title={option.tip}
                      >
                        {option.icon}
                        <span>{option.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="inspector-field">
                <span>线型风格</span>
                <div className="line-style-chips">
                  {[
                    {
                      id: "solid",
                      name: "实线",
                      icon: (
                        <svg width="28" height="6" viewBox="0 0 28 6" fill="none">
                          <line x1="0" y1="3" x2="28" y2="3" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                        </svg>
                      ),
                    },
                    {
                      id: "dashed",
                      name: "虚线",
                      icon: (
                        <svg width="28" height="6" viewBox="0 0 28 6" fill="none">
                          <line x1="0" y1="3" x2="28" y2="3" stroke="currentColor" strokeWidth="2.5" strokeDasharray="5 3" />
                        </svg>
                      ),
                    },
                    {
                      id: "dotted",
                      name: "点线",
                      icon: (
                        <svg width="28" height="6" viewBox="0 0 28 6" fill="none">
                          <line x1="1" y1="3" x2="27" y2="3" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="0.1 4" />
                        </svg>
                      ),
                    },
                  ].map((preset) => {
                    const currentLineStyle = selectedLink.style?.line_style || (selectedLink.kind === "logical" ? "dashed" : "solid");
                    const isActive = currentLineStyle === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        className={`line-chip ${isActive ? "is-active" : ""}`}
                        onClick={() => {
                          if (!activeTopology) return;
                          const val = preset.id as "solid" | "dashed" | "dotted";
                          const updated = activeTopology.links.map((l) =>
                            l.link_id === selectedLink.link_id
                              ? {
                                  ...l,
                                  kind: (val === "dashed" ? "logical" : "physical") as "physical" | "logical",
                                  style: { ...l.style, line_style: val },
                                }
                              : l
                          );
                          pushState({ ...activeTopology, links: updated });
                        }}
                        title={`${preset.name}样式`}
                      >
                        {preset.icon}
                        <span>{preset.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="inspector-field">
                <span>线宽粗细 ({selectedLink.style?.width ? `${selectedLink.style.width}px` : "标准 2.5px"})</span>
                <div className="link-width-chips">
                  {[
                    { label: "细 1.5", value: 1.5 },
                    { label: "标准 2.5", value: 2.5 },
                    { label: "粗 4", value: 4 },
                    { label: "特粗 6", value: 6 },
                  ].map((preset) => {
                    const currentWidth = selectedLink.style?.width ?? 2.5;
                    const isActive = currentWidth === preset.value;
                    return (
                      <button
                        key={preset.value}
                        type="button"
                        className={`link-width-chip ${isActive ? "active" : ""}`}
                        onClick={() => {
                          if (!activeTopology) return;
                          const updated = activeTopology.links.map((l) =>
                            l.link_id === selectedLink.link_id
                              ? { ...l, style: { ...l.style, width: preset.value } }
                              : l
                          );
                          pushState({ ...activeTopology, links: updated });
                        }}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="inspector-field">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>连线颜色</span>
                  {selectedLink.style?.color && (
                    <button
                      type="button"
                      className="link-style-reset-btn"
                      onClick={() => {
                        if (!activeTopology) return;
                        const updated = activeTopology.links.map((l) => {
                          if (l.link_id !== selectedLink.link_id) return l;
                          const nextStyle = { ...l.style };
                          delete nextStyle.color;
                          return { ...l, style: Object.keys(nextStyle).length ? nextStyle : undefined };
                        });
                        pushState({ ...activeTopology, links: updated });
                      }}
                    >
                      恢复状态色
                    </button>
                  )}
                </div>
                <div className="link-color-grid">
                  {[
                    { label: "Cisco蓝", color: "#1262aa" },
                    { label: "科技蓝", color: "#2563eb" },
                    { label: "运行绿", color: "#10b981" },
                    { label: "告警橙", color: "#f59e0b" },
                    { label: "故障红", color: "#ef4444" },
                    { label: "深石灰", color: "#64748b" },
                    { label: "关键紫", color: "#8b5cf6" },
                    { label: "专网青", color: "#06b6d4" },
                  ].map((preset) => {
                    const isSelected = selectedLink.style?.color?.toLowerCase() === preset.color.toLowerCase();
                    return (
                      <button
                        key={preset.color}
                        type="button"
                        className={`link-color-swatch ${isSelected ? "active" : ""}`}
                        style={{ backgroundColor: preset.color }}
                        title={`${preset.label} (${preset.color})`}
                        aria-label={preset.label}
                        onClick={() => {
                          if (!activeTopology) return;
                          const updated = activeTopology.links.map((l) =>
                            l.link_id === selectedLink.link_id
                              ? { ...l, style: { ...l.style, color: preset.color } }
                              : l
                          );
                          pushState({ ...activeTopology, links: updated });
                        }}
                      />
                    );
                  })}
                </div>
                <div className="link-custom-color-row">
                  <input
                    type="color"
                    className="link-color-picker"
                    value={selectedLink.style?.color || "#1262aa"}
                    aria-label="自定义拾色器"
                    onChange={(e) => {
                      if (!activeTopology) return;
                      const val = e.target.value;
                      const updated = activeTopology.links.map((l) =>
                        l.link_id === selectedLink.link_id
                          ? { ...l, style: { ...l.style, color: val } }
                          : l
                      );
                      pushState({ ...activeTopology, links: updated });
                    }}
                  />
                  <input
                    type="text"
                    className="link-color-text"
                    placeholder="Hex 颜色如 #2563eb"
                    value={selectedLink.style?.color || ""}
                    onChange={(e) => {
                      if (!activeTopology) return;
                      const val = e.target.value.trim();
                      const updated = activeTopology.links.map((l) =>
                        l.link_id === selectedLink.link_id
                          ? { ...l, style: { ...l.style, color: val || undefined } }
                          : l
                      );
                      pushState({ ...activeTopology, links: updated });
                    }}
                  />
                </div>
              </div>

              {(selectedLink.style?.color || selectedLink.style?.width || selectedLink.style?.line_style || selectedLink.style?.curve_style) && (
                <button
                  type="button"
                  className="link-full-reset-btn"
                  onClick={() => {
                    if (!activeTopology) return;
                    const updated = activeTopology.links.map((l) =>
                      l.link_id === selectedLink.link_id ? { ...l, style: undefined } : l
                    );
                    pushState({ ...activeTopology, links: updated });
                  }}
                >
                  ↺ 恢复系统默认样式与走线
                </button>
              )}

              <label className="inspector-field">
                链路描述（可选）
                <input
                  value={selectedLink.label || ""}
                  placeholder="如：CE1 接入线路、主干 Trunk"
                  onChange={(e) => {
                    if (!activeTopology) return;
                    const val = e.target.value;
                    const updated = activeTopology.links.map((l) =>
                      l.link_id === selectedLink.link_id ? { ...l, label: val || undefined } : l
                    );
                    pushState({ ...activeTopology, links: updated });
                  }}
                />
              </label>

              <label className="inspector-check">
                <input
                  type="checkbox"
                  checked={Boolean(selectedLink.metadata?.show_description)}
                  onChange={(e) => {
                    if (!activeTopology) return;
                    const show_description = e.target.checked;
                    const updated = activeTopology.links.map((l) =>
                      l.link_id === selectedLink.link_id
                        ? { ...l, metadata: { ...l.metadata, show_description: show_description || undefined } }
                        : l
                    );
                    pushState({ ...activeTopology, links: updated });
                  }}
                />
                <span>在画布显示此描述</span>
              </label>

              <label className="inspector-field">
                速率 (Speed)
                <input
                  value={(selectedLink.metadata?.speed as string) || ""}
                  placeholder="如：10Gbps"
                  onChange={(e) => {
                    if (!activeTopology) return;
                    const val = e.target.value;
                    const updated = activeTopology.links.map((l) =>
                      l.link_id === selectedLink.link_id
                        ? { ...l, metadata: { ...l.metadata, speed: val || undefined } }
                        : l
                    );
                    pushState({ ...activeTopology, links: updated });
                  }}
                />
              </label>

              <label className="inspector-field">
                VLAN / 业务网段
                <input
                  value={(selectedLink.metadata?.vlan as string) || ""}
                  placeholder="如：VLAN 100 / 192.168.1.0/30"
                  onChange={(e) => {
                    if (!activeTopology) return;
                    const val = e.target.value;
                    const updated = activeTopology.links.map((l) =>
                      l.link_id === selectedLink.link_id
                        ? { ...l, metadata: { ...l.metadata, vlan: val || undefined } }
                        : l
                    );
                    pushState({ ...activeTopology, links: updated });
                  }}
                />
              </label>
            </div>

            <div className="inspector-actions">
              <Button
                variant="danger"
                icon={<IconTrash size={13} />}
                onClick={() => handleRemoveLink(selectedLink.link_id)}
              >
                删除此链路
              </Button>
            </div>
            </div>
          </div>
        ) : selectedElement?.type === "canvas_item" && selectedCanvasItem ? (
          <div className="inspector-panel">
            <div className="inspector-header" onMouseDown={handleHeaderMouseDown}>
              <div className="inspector-header-left">
                <span className="inspector-drag-grip" title="按住拖拽移动弹窗">⋮⋮</span>
                <div className="inspector-icon-wrap">
                  <IconBox size={16} style={{ color: "var(--accent)" }} />
                </div>
                <div className="inspector-header-titles">
                  <h4>图纸图元 · {selectedCanvasItem.text || "未命名图元"}</h4>
                  <span className="inspector-badge">
                    {selectedCanvasItem.kind === "text" ? "文本标签" : selectedCanvasItem.kind === "ellipse" ? "椭圆区域" : "矩形区域"}
                  </span>
                </div>
              </div>
              <div className="inspector-header-actions">
                <Button
                  size="sm"
                  onClick={() => {
                    setSelectedElement(null);
                    setIsInspectorOpen(false);
                  }}
                  aria-label="收起图元详情"
                >
                  <IconClose size={13} />
                </Button>
              </div>
            </div>

            <div className="inspector-body">
              <div className="inspector-section">
                <label className="inspector-field">
                  图元类型
                  <select
                    aria-label="图元类型"
                    value={selectedCanvasItem.kind}
                    onChange={(e) => {
                      if (!activeTopology) return;
                      const kind = e.target.value as TopologyCanvasItem["kind"];
                      pushState({
                        ...activeTopology,
                        canvas_items: (activeTopology.canvas_items || []).map((item) =>
                          item.item_id === selectedCanvasItem.item_id ? { ...item, kind } : item
                        ),
                      });
                    }}
                  >
                    <option value="rectangle">矩形区域</option>
                    <option value="ellipse">椭圆标注</option>
                    <option value="text">文本框</option>
                  </select>
                </label>

                <label className="inspector-field">
                  文本内容
                  <textarea
                    value={selectedCanvasItem.text}
                    rows={2}
                    maxLength={240}
                    placeholder={selectedCanvasItem.kind === "text" ? "输入说明文字" : "如：核心业务区"}
                    onChange={(e) => {
                      if (!activeTopology) return;
                      const text = e.target.value;
                      pushState({ ...activeTopology, canvas_items: (activeTopology.canvas_items || []).map((item) => item.item_id === selectedCanvasItem.item_id ? { ...item, text } : item) });
                    }}
                  />
                </label>

                <label className="inspector-field">
                  图元样式
                  <select
                    value={canvasItemStylePreset(selectedCanvasItem.style)}
                    onChange={(e) => {
                      if (!activeTopology || e.target.value === "custom") return;
                      const preset = canvasItemStylePresets[e.target.value as keyof typeof canvasItemStylePresets];
                      pushState({ ...activeTopology, canvas_items: (activeTopology.canvas_items || []).map((item) => item.item_id === selectedCanvasItem.item_id ? { ...item, style: { ...preset.style } } : item) });
                    }}
                  >
                    <option value="custom">自定义（保留当前）</option>
                    {Object.entries(canvasItemStylePresets).map(([key, preset]) => <option key={key} value={key}>{preset.label}</option>)}
                  </select>
                </label>

                <div className="inspector-dimension-section">
                  <div className="inspector-dimension-grid">
                    <label className="inspector-field">宽度
                      <input type="number" min="40" max="1600" value={Math.round(selectedCanvasItem.width)} onChange={(e) => {
                        if (!activeTopology) return;
                        const width = Math.min(1600, Math.max(40, Number(e.target.value) || 40));
                        pushState({ ...activeTopology, canvas_items: (activeTopology.canvas_items || []).map((item) => item.item_id === selectedCanvasItem.item_id ? { ...item, width } : item) });
                      }} />
                    </label>
                    <label className="inspector-field">高度
                      <input type="number" min="24" max="1200" value={Math.round(selectedCanvasItem.height)} onChange={(e) => {
                        if (!activeTopology) return;
                        const height = Math.min(1200, Math.max(24, Number(e.target.value) || 24));
                        pushState({ ...activeTopology, canvas_items: (activeTopology.canvas_items || []).map((item) => item.item_id === selectedCanvasItem.item_id ? { ...item, height } : item) });
                      }} />
                    </label>
                  </div>
                  <div className="dimension-presets">
                    {(selectedCanvasItem.kind === "text"
                      ? [
                          { label: "单行", w: 180, h: 36 },
                          { label: "双行", w: 220, h: 56 },
                          { label: "段落", w: 280, h: 90 },
                        ]
                      : [
                          { label: "紧凑", w: 180, h: 90 },
                          { label: "标准", w: 260, h: 140 },
                          { label: "广域", w: 380, h: 220 },
                        ]
                    ).map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        className="dimension-chip"
                        onClick={() => {
                          if (!activeTopology) return;
                          pushState({
                            ...activeTopology,
                            canvas_items: (activeTopology.canvas_items || []).map((item) =>
                              item.item_id === selectedCanvasItem.item_id ? { ...item, width: preset.w, height: preset.h } : item
                            ),
                          });
                        }}
                        title={`快捷设置为 ${preset.w} × ${preset.h} 像素`}
                      >
                        {preset.label} ({preset.w}×{preset.h})
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="inspector-actions">
                <Button variant="danger" icon={<IconTrash size={13} />} onClick={() => void handleRemoveCanvasItem(selectedCanvasItem.item_id)}>
                  删除图纸图元
                </Button>
              </div>
            </div>
          </div>
        ) : selectedElement?.type === "group" && selectedGroup ? (
          <div className="inspector-panel">
            <div className="inspector-header" onMouseDown={handleHeaderMouseDown}>
              <div className="inspector-header-left">
                <span className="inspector-drag-grip" title="按住拖拽移动弹窗">⋮⋮</span>
                <div className="inspector-icon-wrap">
                  <IconFolder size={16} style={{ color: "var(--accent)" }} />
                </div>
                <div className="inspector-header-titles">
                  <h4>分组属性</h4>
                  <span className="inspector-badge">{selectedGroup.name}</span>
                </div>
              </div>
              <div className="inspector-header-actions">
                <Button
                  size="sm"
                  onClick={() => {
                    setSelectedElement(null);
                    setIsInspectorOpen(false);
                  }}
                  aria-label="收起分组详情"
                >
                  <IconClose size={13} />
                </Button>
              </div>
            </div>

            <div className="inspector-body">
              <div className="inspector-section">
                <label className="inspector-field">
                  分组名称
                  <input
                    value={selectedGroup.name}
                    onChange={(e) => {
                      if (!activeTopology) return;
                      const val = e.target.value;
                      const updated = activeTopology.groups.map((g) =>
                        g.group_id === selectedGroup.group_id ? { ...g, name: val } : g
                      );
                      pushState({ ...activeTopology, groups: updated });
                    }}
                  />
                </label>

                <label className="inspector-field">
                  分组类型
                  <select
                    value={selectedGroup.kind}
                    onChange={(e) => {
                      if (!activeTopology) return;
                      const val = e.target.value as "as" | "region" | "datacenter" | "tenant" | "custom";
                      const updated = activeTopology.groups.map((g) =>
                        g.group_id === selectedGroup.group_id ? { ...g, kind: val } : g
                      );
                      pushState({ ...activeTopology, groups: updated });
                    }}
                  >
                    <option value="as">自治系统 (AS)</option>
                    <option value="region">地理区域 (Region)</option>
                    <option value="datacenter">数据中心 (Datacenter)</option>
                    <option value="tenant">业务租户 (Tenant)</option>
                    <option value="custom">自定义分组</option>
                  </select>
                </label>
              </div>

              <div className="inspector-section">
                <span className="inspector-label">属于此分组的节点</span>
                <div className="inspector-group-members">
                  {activeTopology?.nodes
                    ?.filter((n) => n.group_id === selectedGroup.group_id)
                    .map((n) => (
                      <div key={n.node_id} className="group-member-item">
                        {n.display_name || n.node_id}
                      </div>
                    )) || null}
                </div>
              </div>

              <div className="inspector-actions">
                <Button
                  variant="danger"
                  icon={<IconTrash size={13} />}
                  onClick={() => handleRemoveGroup(selectedGroup.group_id)}
                >
                  删除此分组
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="inspector-panel">
            <div className="inspector-header" onMouseDown={handleHeaderMouseDown}>
              <div className="inspector-header-left">
                <span className="inspector-drag-grip" title="按住拖拽移动弹窗">⋮⋮</span>
                <div className="inspector-icon-wrap">
                  <IconEye size={16} style={{ color: "var(--accent)" }} />
                </div>
                <div className="inspector-header-titles">
                  <h4>拓扑概览</h4>
                  <span className="inspector-badge">{activeTopology?.name || "未命名拓扑"}</span>
                </div>
              </div>
              <div className="inspector-header-actions">
                <Button size="sm" onClick={() => setIsInspectorOpen(false)} aria-label="收起拓扑详情">
                  <IconClose size={13} />
                </Button>
              </div>
            </div>

            <div className="inspector-body">
              <div className="inspector-section">
                <strong>{activeTopology?.name}</strong>
                <p className="inspector-desc">{activeTopology?.description || "未提供拓扑说明"}</p>
              </div>

              <div className="inspector-section stats-grid">
                <div className="stat-card">
                  <span className="stat-num">{activeTopology?.nodes?.length || 0}</span>
                  <span className="stat-lbl">拓扑节点</span>
                </div>
                <div className="stat-card">
                  <span className="stat-num">{activeTopology?.links?.length || 0}</span>
                  <span className="stat-lbl">拓扑链路</span>
                </div>
                <div className="stat-card">
                  <span className="stat-num">{activeTopology?.groups?.length || 0}</span>
                  <span className="stat-lbl">拓扑分组</span>
                </div>
              </div>

              <div className="inspector-section">
                <span className="inspector-label">快捷操作</span>
                <div className="quick-actions-col">
                  <Button
                    size="sm"
                    icon={<IconEdit size={13} />}
                    onClick={() => {
                      if (activeTopology) {
                        setTopologyModalMode("edit");
                        setTopologyNameInput(activeTopology.name);
                        setTopologyDescInput(activeTopology.description);
                      }
                    }}
                  >
                    修改拓扑基本信息
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </aside>
        </div>
        <footer className="studio-statusbar"><span>独立图纸</span><span>空白拖拽框选 · 空格/中键平移 · 连续点放 · C 极速连线 · ⌘D 克隆</span></footer>
      </main>

      {activeTopology && <aside className="studio-agent-dock" aria-hidden={!showAgent}><TopologyAgentPanel key={`${workspaceId}:${activeTopology.topology_id}`} workspaceId={workspaceId} topology={activeTopology} selection={canvasSelection} onCompleted={() => { void handleAgentCompleted(); }} /></aside>}

      {contextMenu && (
        <div className="canvas-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseDown={(event) => event.stopPropagation()}>
          {contextMenu.kind === "node" && (
            <>
              <button type="button" onClick={() => {
                setCanvasMode("connect");
                canvasApiRef.current?.startConnectFrom?.(contextMenu.id);
                setContextMenu(null);
                const sLabel = nodeLabelById.get(contextMenu.id) || contextMenu.id;
                setNotice(`已选择起点设备“${sLabel}”，请点击目标设备完成连线 (Esc 取消)`);
              }}>从此处连线 (C)</button>
              <button type="button" onClick={() => {
                openLinkComposer(contextMenu.id);
                setContextMenu(null);
              }}>高级连线 (指定端口)...</button>
              <button type="button" onClick={() => {
                handleCloneNode(contextMenu.id);
                setContextMenu(null);
              }}>克隆设备 (⌘D)</button>
              <button type="button" onClick={() => { setSelectedElement({ type: "node", nodeId: contextMenu.id }); setIsInspectorOpen(true); setContextMenu(null); }}>打开设备详情</button>
              <button type="button" className="danger" onClick={() => { void handleRemoveNode(contextMenu.id); setContextMenu(null); }}>从拓扑移除</button>
            </>
          )}
          {contextMenu.kind === "link" && (
            <>
              <button type="button" onClick={() => { setSelectedElement({ type: "link", linkId: contextMenu.id }); setIsInspectorOpen(true); setContextMenu(null); }}>编辑链路</button>
              <button type="button" className="danger" onClick={() => { void handleRemoveLink(contextMenu.id); setContextMenu(null); }}>删除链路</button>
            </>
          )}
          {contextMenu.kind === "canvas_item" && (
            <>
              <button type="button" onClick={() => { setSelectedElement({ type: "canvas_item", itemId: contextMenu.id.replace(/^canvas-/, "") }); setIsInspectorOpen(true); setContextMenu(null); }}>编辑图元</button>
              <button type="button" className="danger" onClick={() => { void handleRemoveCanvasItem(contextMenu.id.replace(/^canvas-/, "")); setContextMenu(null); }}>删除图元</button>
            </>
          )}
          {contextMenu.kind === "canvas" && (
            <>
              <button type="button" onClick={() => { canvasApiRef.current?.selectAll(); setContextMenu(null); }}>全选对象</button>
              <button type="button" onClick={() => { canvasApiRef.current?.fit(); setContextMenu(null); }}>适配视图</button>
              <button type="button" onClick={() => { void handleAutoLayout(); setContextMenu(null); }}>自动排布</button>
              <hr />
              <button type="button" onClick={() => { handleAddCanvasItem("rectangle"); setContextMenu(null); }}>插入矩形区域</button>
              {/* All three shapes were reachable from the inspector's type
                  selector, but only two could be created here — an ellipse had
                  to be drawn as a rectangle first and then retyped. */}
              <button type="button" onClick={() => { handleAddCanvasItem("ellipse"); setContextMenu(null); }}>插入椭圆标注</button>
              <button type="button" onClick={() => { handleAddCanvasItem("text"); setContextMenu(null); }}>插入文本框</button>
            </>
          )}
        </div>
      )}

      {showShortcutHelp && (
        <div className="shortcut-help-backdrop" onClick={() => setShowShortcutHelp(false)}>
          <div className="shortcut-help" onClick={(event) => event.stopPropagation()}>
            <header><strong>画布快捷键</strong><button type="button" onClick={() => setShowShortcutHelp(false)} aria-label="关闭"><IconClose size={13} /></button></header>
            <dl>
              <div><dt>V / C</dt><dd>选择 / 连线笔模式</dd></div>
              <div><dt>连线模式 (C)</dt><dd>极速直连两台设备，自动配对接口</dd></div>
              <div><dt>空白处左键拖拽</dt><dd>直接拉框多选设备与链路</dd></div>
              <div><dt>空格 + 拖拽 / 中键拖拽</dt><dd>平移画布（随时随地抓手拖动）</dd></div>
              <div><dt>Ctrl/⌘ + D</dt><dd>克隆复制选中设备</dd></div>
              <div><dt>设备快捷栏</dt><dd>点击设备后在画布连续点击批量放置</dd></div>
              <div><dt>Ctrl/⌘ + 单击</dt><dd>加选设备；再点一次移出选区</dd></div>
              <div><dt>Shift + 单击</dt><dd>加选设备</dd></div>
              <div><dt>拖动已选对象</dt><dd>整组一起移动并磁吸对齐网格</dd></div>
              <div><dt>Delete / Backspace</dt><dd>删除选中对象</dd></div>
              <div><dt>Ctrl/⌘ + A</dt><dd>全选</dd></div>
              <div><dt>方向键</dt><dd>微移选中对象（Shift 加速）</dd></div>
              <div><dt>F / Shift + F</dt><dd>适配全部 / 缩放至选中对象</dd></div>
              <div><dt>/</dt><dd>搜索设备并定位</dd></div>
              <div><dt>I</dt><dd>切换接口标签</dd></div>
              <div><dt>T</dt><dd>展开 / 收起编辑工具条</dd></div>
              <div><dt>Shift + G</dt><dd>切换网格吸附</dd></div>
              <div><dt>Ctrl/⌘ + Z / Y</dt><dd>撤销 / 恢复</dd></div>
              <div><dt>Ctrl/⌘ + S</dt><dd>立即保存</dd></div>
              <div><dt>滚轮</dt><dd>缩放视图</dd></div>
              <div><dt>Esc / 右键</dt><dd>退出放置/退出连线/关闭面板</dd></div>
              <div><dt>?</dt><dd>显示本帮助</dd></div>
            </dl>
          </div>
        </div>
      )}

      
      {/* MODAL 1: Create / Edit Topology */}
      {topologyModalMode && (
        <dialog open role="dialog" aria-modal="true" className="network-dialog-modal">
          <form onSubmit={handleSaveTopologyMeta} className="network-panel modal-panel">
            <div className="modal-header">
              <h3>{topologyModalMode === "create" ? "新建网络拓扑" : "编辑拓扑信息"}</h3>
              <Button size="sm" onClick={() => setTopologyModalMode(null)}>
                <IconClose size={14} />
              </Button>
            </div>
            <div className="form-grid">
              <label className="full-field">
                拓扑名称
                <input
                  required
                  placeholder="如：核心数据中心骨干拓扑"
                  value={topologyNameInput}
                  onChange={(e) => setTopologyNameInput(e.target.value)}
                />
              </label>
              <label className="full-field">
                拓扑说明（可选）
                <textarea
                  placeholder="描述该拓扑覆盖的业务范围、骨干协议或网络边界"
                  value={topologyDescInput}
                  onChange={(e) => setTopologyDescInput(e.target.value)}
                />
              </label>
            </div>
            <div className="modal-actions">
              <Button type="button" onClick={() => setTopologyModalMode(null)}>
                取消
              </Button>
              <Button variant="primary" type="submit" disabled={busy}>
                保存
              </Button>
            </div>
          </form>
        </dialog>
      )}

      {/* MODAL 2: Create Link on Connect */}
      {pendingConnection && (
        <dialog open role="dialog" aria-modal="true" className="network-dialog-modal">
          <form onSubmit={handleSaveLink} className="network-panel modal-panel">
            <div className="modal-header">
              <h3>新建拓扑链路</h3>
              <Button size="sm" onClick={() => setPendingConnection(null)}>
                <IconClose size={14} />
              </Button>
            </div>
            <div className="form-grid">
              <label>
                源端设备
                <select
                  aria-label="源端设备"
                  value={pendingConnection.source}
                  onChange={(event) => {
                    const source = event.target.value;
                    const target =
                      pendingConnection.target === source
                        ? (activeTopology?.nodes || []).find((node) => node.node_id !== source)?.node_id || ""
                        : pendingConnection.target;
                    if (!target) return;
                    setPendingConnection({ source, target });
                    // 换了设备就要重新挑口：沿用上一台的口名会撞上这一台已占用的。
                    const links = activeTopology?.links || [];
                    setLinkForm((prev) => ({
                      ...prev,
                      source_interface: nextFreeInterface(links, source),
                      target_interface: nextFreeInterface(links, target, 0),
                    }));
                  }}
                >
                  {(activeTopology?.nodes || []).map((node) => (
                    <option key={node.node_id} value={node.node_id}>
                      {node.display_name || node.node_id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                源端接口
                <input
                  required
                  placeholder="如：GE0/1"
                  value={linkForm.source_interface}
                  onChange={(e) => setLinkForm({ ...linkForm, source_interface: e.target.value })}
                />
              </label>
              <label>
                对端设备
                <select
                  aria-label="对端设备"
                  value={pendingConnection.target}
                  onChange={(event) => {
                    const target = event.target.value;
                    setPendingConnection({ ...pendingConnection, target });
                    setLinkForm((prev) => ({
                      ...prev,
                      target_interface: nextFreeInterface(activeTopology?.links || [], target, 0),
                    }));
                  }}
                >
                  {(activeTopology?.nodes || [])
                    .filter((node) => node.node_id !== pendingConnection.source)
                    .map((node) => (
                      <option key={node.node_id} value={node.node_id}>
                        {node.display_name || node.node_id}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                对端接口
                <input
                  required
                  placeholder="如：GE0/0"
                  value={linkForm.target_interface}
                  onChange={(e) => setLinkForm({ ...linkForm, target_interface: e.target.value })}
                />
              </label>
              <label>
                链路性质
                <select
                  value={linkForm.kind}
                  onChange={(e) =>
                    setLinkForm({ ...linkForm, kind: e.target.value as "physical" | "logical" })
                  }
                >
                  <option value="physical">物理链路 (实线)</option>
                  <option value="logical">逻辑链路 (虚线)</option>
                </select>
              </label>
              <label>
                链路状态
                <select
                  value={linkForm.status}
                  onChange={(e) =>
                    setLinkForm({ ...linkForm, status: e.target.value as "unknown" | "up" | "down" })
                  }
                >
                  <option value="unknown">未知（尚无运行证据）</option>
                  <option value="up">图纸标注：UP（非运行结论）</option>
                  <option value="down">图纸标注：DOWN（非运行结论）</option>
                </select>
              </label>
              <label className="full-field">
                链路描述（可选）
                <input
                  placeholder="如：CE1 接入线路、主干 Trunk"
                  value={linkForm.label}
                  onChange={(e) => setLinkForm({ ...linkForm, label: e.target.value })}
                />
              </label>
              <label className="check full-field">
                <input type="checkbox" checked={linkForm.show_description} onChange={(e) => setLinkForm({ ...linkForm, show_description: e.target.checked })} />
                <span>在画布显示这条描述（默认仅在链路详情中保留）</span>
              </label>
              <label>
                速率 (Speed)
                <input
                  placeholder="如：10Gbps"
                  value={linkForm.speed}
                  onChange={(e) => setLinkForm({ ...linkForm, speed: e.target.value })}
                />
              </label>
              <label>
                VLAN / 子网
                <input
                  placeholder="如：VLAN 100"
                  value={linkForm.vlan}
                  onChange={(e) => setLinkForm({ ...linkForm, vlan: e.target.value })}
                />
              </label>
            </div>
            <div className="modal-actions">
              <Button type="button" onClick={() => setPendingConnection(null)}>
                取消
              </Button>
              <Button variant="primary" type="submit">
                创建链路
              </Button>
            </div>
          </form>
        </dialog>
      )}

      {/* MODAL: Diagram-only node */}
      {showManualNodeModal && (
        <dialog open role="dialog" aria-modal="true" className="network-dialog-modal" aria-label="新建图纸设备">
          <form onSubmit={handleAddManualNode} className="network-panel modal-panel">
            <div className="modal-header"><div><h3>新建图纸设备</h3><p>创建独立图纸设备，不关联登记资产。</p></div><Button size="sm" type="button" onClick={() => setShowManualNodeModal(false)}><IconClose size={14} /></Button></div>
            <div className="form-grid">
              <label className="full-field">显示名称<input required autoFocus placeholder="如：Internet、核心交换机、第三方系统" value={manualNodeName} onChange={(event) => setManualNodeName(event.target.value)} /></label>
              <label className="full-field">图标类型<select value={manualNodeType} onChange={(event) => setManualNodeType(event.target.value)}>{DRAWING_DEVICE_TYPES.map((t) => (<option key={t.value} value={t.value}>{t.label}</option>))}</select></label>

            </div>
            <div className="modal-actions"><Button type="button" onClick={() => setShowManualNodeModal(false)}>取消</Button><Button variant="primary" type="submit">放入画布</Button></div>
          </form>
        </dialog>
      )}

      {/* MODAL 3: Create Group */}
      {showGroupModal && (
        <dialog open role="dialog" aria-modal="true" className="network-dialog-modal">
          <form onSubmit={handleCreateGroup} className="network-panel modal-panel">
            <div className="modal-header">
              <h3>新建拓扑分组</h3>
              <Button size="sm" onClick={() => setShowGroupModal(false)}>
                <IconClose size={14} />
              </Button>
            </div>
            <div className="form-grid">
              <label className="full-field">
                分组名称
                <input
                  required
                  placeholder="如：AS65001 或 华东数据中心"
                  value={groupNameInput}
                  onChange={(e) => setGroupNameInput(e.target.value)}
                />
              </label>
              <label className="full-field">
                分组性质
                <select
                  value={groupKindInput}
                  onChange={(e) =>
                    setGroupKindInput(e.target.value as "as" | "region" | "datacenter" | "tenant" | "custom")
                  }
                >
                  <option value="as">自治系统 (AS)</option>
                  <option value="region">区域 (Region)</option>
                  <option value="datacenter">数据中心 (Datacenter)</option>
                  <option value="tenant">业务租户 (Tenant)</option>
                  <option value="custom">自定义分组</option>
                </select>
              </label>
            </div>
            <div className="modal-actions">
              <Button type="button" onClick={() => setShowGroupModal(false)}>
                取消
              </Button>
              <Button variant="primary" type="submit">
                创建分组
              </Button>
            </div>
          </form>
        </dialog>
      )}



      {showConflict && conflict && (
        <dialog open role="dialog" aria-modal="true" className="network-dialog-modal compare-modal" aria-label="编辑冲突">
          <div className="network-panel modal-panel compare-panel">
            <div className="modal-header">
              <div>
                <h3>这张图纸被其他人修改过</h3>
                <p>你编辑的是版本 {conflict.base.version} 的图纸，服务端已是版本 {conflict.theirs.version}</p>
              </div>
              <Button aria-label="关闭冲突处理" onClick={() => setShowConflict(false)}><IconClose size={14} /></Button>
            </div>
            <div className="compare-notice-banner">
              系统已按对象 id 做了三方合并：双方各自新增或修改、对方没动的部分都会保留；
              同一字段双方都改了、或删除与编辑撞在一起时，保留服务端值并列在下面，请人工确认。
            </div>
            <div className="compare-metrics-row">
              <div className="metric-box"><span className="metric-val">{conflict.stats.autoMerged}</span><span className="metric-lbl">自动合并</span></div>
              <div className="metric-box"><span className="metric-val">{conflict.stats.added}</span><span className="metric-lbl">新增对象</span></div>
              <div className="metric-box"><span className="metric-val">{conflict.stats.removed}</span><span className="metric-lbl">删除对象</span></div>
              <div className="metric-box"><span className="metric-val">{conflict.conflicts.length}</span><span className="metric-lbl">需人工确认</span></div>
            </div>
            {conflict.stats.orphanedLinks > 0 && (
              <p className="conflict-note">另有 {conflict.stats.orphanedLinks} 条链路的端点已不存在，合并时一并移除（服务端不接受悬空链路）。</p>
            )}
            <div className="compare-details-area">
              {conflict.conflicts.slice(0, 12).map((item, index) => (
                <div className="compare-item" key={`conflict-${item.collection}-${item.id}-${item.field}-${index}`}>
                  <span className="compare-status-tag warn">需确认</span>
                  <span>{item.collection} {nodeLabelById.get(item.id) || item.id} · {DIFF_FIELD_LABELS[item.field] || item.field}</span>
                  <small>{item.field === "删除" ? "一方删除、另一方编辑；已按删除处理" : `保留服务端值 ${describeMergeValue(item.theirs)}`}</small>
                </div>
              ))}
              {conflict.conflicts.length > 12 && <p>还有 {conflict.conflicts.length - 12} 处未列出。</p>}
              {!conflict.conflicts.length && <p>没有需要人工确认的冲突。</p>}
            </div>
            <div className="modal-actions">
              <Button variant="primary" onClick={() => applyConflictChoice("merged")}>合并双方改动并保存</Button>
              <Button onClick={() => applyConflictChoice("theirs")}>用服务端版本（放弃我的改动）</Button>
              <Button onClick={() => applyConflictChoice("mine")}>保留我的（覆盖对方）</Button>
              <Button onClick={() => setShowConflict(false)}>稍后处理</Button>
            </div>
          </div>
        </dialog>
      )}

      {showRevisions && (
        <dialog open role="dialog" aria-modal="true" className="network-dialog-modal compare-modal" aria-label="版本历史">
          <div className="network-panel modal-panel compare-panel">
            <div className="modal-header"><div><h3>版本历史 · {revisions.length} 个结构版本</h3><p>只记录结构变化；拖动位置、缩放不产生版本</p></div><Button aria-label="关闭版本历史" onClick={() => setShowRevisions(false)}><IconClose size={14} /></Button></div>
            <div className="compare-notice-banner">恢复会把旧结构写成新版本，不会抹掉当前历史；节点位置沿用现在的布局。</div>
            <div className="compare-details-area">
              {revisions.map((revision) => (
                <div className="compare-item revision-item" key={revision.revision_id}>
                  <span className="compare-status-tag unknown">v{revision.version}</span>
                  <span>{new Date(revision.saved_at).toLocaleString("zh-CN", { hour12: false })}</span>
                  <small>{revision.summary.nodes ?? 0} 节点 · {revision.summary.links ?? 0} 链路 · {revision.summary.groups ?? 0} 分组 · {revision.summary.canvas_items ?? 0} 图元</small>
                  <div className="revision-actions">
                    <Button size="sm" onClick={() => void handleDiffRevision(revision.revision_id)}>{diffLoading ? "对比中…" : "与当前对比"}</Button>
                    <Button size="sm" disabled={restoringId === revision.revision_id} onClick={() => void handleRestoreRevision(revision.revision_id)}>{restoringId === revision.revision_id ? "恢复中…" : "恢复到此版本"}</Button>
                  </div>
                </div>
              ))}
              {!revisions.length && !revisionsLoading && <p>还没有结构变更记录。改动节点、链路或图元后会自动出现版本。</p>}
              {revisionsLoading && <p>读取中…</p>}
            </div>
            {revisionDiff && (
              <div className="revision-diff">
                <h4>版本 {revisionDiff.revision_version} → 当前 {revisionDiff.current_version} 的差异</h4>
                {!revisionDiff.summary.total_changes && <p>与当前图纸一致，没有差异。</p>}
                <ul>
                  {revisionDiff.nodes_added.map((item) => <li key={`na-${item.node_id}`} className="diff-add">新增节点 {item.label}</li>)}
                  {revisionDiff.nodes_removed.map((item) => <li key={`nr-${item.node_id}`} className="diff-remove">删除节点 {item.label}</li>)}
                  {revisionDiff.nodes_changed.map((item) => (
                    <li key={`nc-${item.node_id}`} className="diff-change">
                      节点 {item.label}：{Object.entries(item.changes).map(([field, change]) => `${DIFF_FIELD_LABELS[field] || field} ${change.from || "空"} → ${change.to || "空"}`).join("；")}
                    </li>
                  ))}
                  {revisionDiff.links_added.map((item) => <li key={`la-${item.link_id}`} className="diff-add">新增链路 {item.label}</li>)}
                  {revisionDiff.links_removed.map((item) => <li key={`lr-${item.link_id}`} className="diff-remove">删除链路 {item.label}</li>)}
                  {revisionDiff.links_changed.map((item) => (
                    <li key={`lc-${item.link_id}`} className="diff-change">
                      链路 {item.label}：{Object.entries(item.changes).map(([field, change]) => `${DIFF_FIELD_LABELS[field] || field} ${change.from || "空"} → ${change.to || "空"}`).join("；")}
                    </li>
                  ))}
                  {revisionDiff.groups_added.map((group) => <li key={`ga-${group.group_id}`} className="diff-add">新增分组 {group.label}</li>)}
                  {revisionDiff.groups_removed.map((group) => <li key={`gr-${group.group_id}`} className="diff-remove">删除分组 {group.label}</li>)}
                  {revisionDiff.canvas_items_added.map((item) => <li key={`ia-${item.item_id}`} className="diff-add">新增图元 {item.label}</li>)}
                  {revisionDiff.canvas_items_removed.map((item) => <li key={`ir-${item.item_id}`} className="diff-remove">删除图元 {item.label}</li>)}
                </ul>
              </div>
            )}
            <div className="modal-actions">
              <Button onClick={() => setShowRevisions(false)}>关闭</Button>
            </div>
          </div>
        </dialog>
      )}


    </div>
  );
}
