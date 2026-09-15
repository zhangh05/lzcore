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
  IconEdit,
  IconEye,
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
} from "../../../../frontend/src/components/Icon";
import { apiRequest } from "../../../../frontend/src/api/client";
import { confirm } from "../../../../frontend/src/components/ConfirmDialog";
import { Button } from "../../../../frontend/src/components/ui";
import { LAYOUT_PRESETS, layoutTopology, type LayoutAlgorithm } from "./topologyLayout";
import { TopologyAgentPanel } from "./TopologyAgentPanel";
import NetOpsCanvas, { type CanvasApi, type CanvasContextTarget, type NodeRuntimeStatus } from "./NetOpsCanvas";
import { buildImagePdf, rgbFromRgba, type RgbImage } from "./topologyPdf";
import { mergeTopologies, type MergeConflict, type MergeStats } from "./topologyMerge";
import { buildCanvasSelection, type CanvasSelection } from "./canvasSelection";
import { netOpsIconForDeviceType } from "./netopsCanvasAssets";
import "./TopologyStudio.css";

export type Device = {
  device_id: string;
  name: string;
  host: string;
  vendor: string;
  device_type: string;
  device_model?: string;
  region_id: string;
};

export type Connection = {
  connection_id: string;
  device_id: string;
  name?: string;
  protocol: "ssh" | "telnet";
  port: number;
  status: string;
  verified: boolean;
  credential_configured?: boolean;
  driver_id?: string;
  detected_vendor?: string;
  os_family?: string;
  last_tested_at?: string;
};

type TopologyState = {
  topology_id: string; version: number; refreshed_at: string;
  nodes: Array<{ node_id: string; device_id: string; connections: Connection[]; observation: { observed_at: string; completeness: string; source_id: string; artifact_id: string } | null }>;
};

const formatObservedTime = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚未采集";

export type Region = { region_id: string; name: string };
export type Skill = {
  skill_id: string;
  name: string;
  description: string;
  topology_id?: string;
};

export type TopologyNode = {
  node_id: string;
  /** Optional connection to an independently registered asset. */
  linked_device_id?: string | null;
  x: number;
  y: number;
  device_type?: string;
  display_name?: string;
  labels?: string[];
  group_id?: string;
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
  source: "manual" | "discovered";
  evidence_refs?: string[];
  status: "unknown" | "up" | "down";
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

export type TopologyCompareResult = {
  topology_id: string; topology_name: string;
  topology_devices_not_in_scope: string[];
  devices_in_scope_not_in_topology: string[];
  link_comparisons: Array<{
    link_id: string; source_device_id: string; source_interface: string;
    target_device_id: string; target_interface: string;
    comparison_status: string; recorded_status: string; note: string;
  }>;
  summary: { total_nodes: number; total_links: number; matched_links: number; mismatched_links: number; unknown_evidence_links: number; available_devices_missing_from_topology: number };
};

const base = "/extensions/network.operations";

/** A neighbour seen on the wire that is not on the drawing yet. */
type DiscoveryCandidate = {
  source_node_id: string;
  target_node_id: string;
  source_interface: string;
  target_interface: string;
  source_device_id: string;
  target_device_id: string;
  remote_name: string;
  evidence_artifact_id: string;
};

/**
 * Legend swatches are DOM, so they read the product tokens directly and follow
 * the theme automatically. The canvas cannot do this (Cytoscape paints to a
 * bitmap), which is why the literals are mirrored in NetOpsCanvas — but the two
 * must never disagree, so neither side keeps its own idea of the colours.
 */
const NODE_STATUS_ORDER: NodeRuntimeStatus[] = ["ok", "warning", "error", "unknown"];
const NODE_STATUS_SWATCH: Record<NodeRuntimeStatus, string> = {
  ok: "var(--ok)",
  warning: "var(--warn)",
  error: "var(--danger)",
  unknown: "var(--text-4)",
};

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
  linked_device_id: "关联设备",
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
  devices: Device[];
  connections: Connection[];
  regions: Region[];
  skills: Skill[];
  topologies: Topology[];
  loadError: string;
  onReload: () => Promise<void>;
  onCreateDevice: () => void;
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
  devices,
  regions,
  skills,
  topologies,
  loadError,
  onReload,
  onCreateDevice,
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
  const [showAgent, setShowAgent] = useState(false);
  // The board is primary. The tray opens intentionally instead of consuming
  // canvas width for every user.
  const [showLibrary, setShowLibrary] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [canvasMode, setCanvasMode] = useState<"select" | "connect">("select");
  const [gridEnabled, setGridEnabled] = useState(true);
  const [canvasSelectedElementIds, setCanvasSelectedElementIds] = useState<string[]>([]);
  const [showInterfaces, setShowInterfaces] = useState(true);
  // Filters dim rather than hide, so the diagram never turns into a different
  // drawing than the one being discussed.
  const [canvasFilter, setCanvasFilter] = useState<{ vendors: string[]; statuses: NodeRuntimeStatus[]; groups: string[] }>({ vendors: [], statuses: [], groups: [] });
  // Imperative canvas handle (export / focus / viewport) and transient canvas
  // UI: right-click menu, keyboard help, and in-canvas search.
  const canvasApiRef = useRef<CanvasApi | null>(null);
  const [contextMenu, setContextMenu] = useState<CanvasContextTarget | null>(null);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [canvasQuery, setCanvasQuery] = useState("");
  const [legendOpen, setLegendOpen] = useState(true);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [topologyState, setTopologyState] = useState<TopologyState | null>(null);
  const [stateError, setStateError] = useState("");
  const [layoutBusy, setLayoutBusy] = useState(false);
  const activeTopologyRef = useRef(activeTopology);
  activeTopologyRef.current = activeTopology;
  const refreshFacts = useCallback(async () => {
    const id = activeTopologyRef.current?.topology_id;
    if (!id) return;
    try {
      const result = await apiRequest<{ state: TopologyState }>({ method: "GET", url: `${base}/topologies/${id}/state`, params: { workspace_id: workspaceId } });
      if (activeTopologyRef.current?.topology_id !== id) return;
      setTopologyState(result.state); setStateError("");
    } catch { if (activeTopologyRef.current?.topology_id === id) setStateError("状态同步失败，显示上次记录"); }
  }, [workspaceId]);
  useEffect(() => {
    setTopologyState(null);
    if (!activeTopology?.topology_id) return;
    void refreshFacts();
    const timer = window.setInterval(() => { if (!document.hidden) void refreshFacts(); }, 10000);
    return () => window.clearInterval(timer);
  }, [activeTopology?.topology_id, refreshFacts]);
  /**
   * What the Agent is told the user is looking at. The canvas selection is
   * authoritative: box-selecting five devices and asking about "these" used
   * to send the whole topology, because this came from the inspector alone.
   */
  const canvasSelection: CanvasSelection = useMemo(
    () => buildCanvasSelection(activeTopology, devices, canvasSelectedElementIds, selectedElement),
    [activeTopology, devices, canvasSelectedElementIds, selectedElement],
  );

  // Palette filters
  const [deviceSearch, setDeviceSearch] = useState("");
  const [regionFilter, setRegionFilter] = useState("");

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

  const resetLinkForm = useCallback(() => {
    setLinkForm({
      source_interface: "GE0/1",
      target_interface: "GE0/0",
      kind: "physical",
      label: "",
      show_description: false,
      status: "unknown",
      speed: "",
      vlan: "",
      medium: "",
      subnet: "",
    });
  }, []);

  const [showCompareModal, setShowCompareModal] = useState(false);
  const [compareResult, setCompareResult] = useState<TopologyCompareResult | null>(null);
  const [comparing, setComparing] = useState(false);

  const byDevice = useMemo(() => new Map(devices.map((d) => [d.device_id, d])), [devices]);
  const byRegion = useMemo(() => new Map(regions.map((r) => [r.region_id, r.name])), [regions]);
  const nodeLabelById = useMemo(() => new Map((activeTopology?.nodes || []).map((node) => [node.node_id, node.display_name || byDevice.get(node.linked_device_id || "")?.name || node.node_id])), [activeTopology?.nodes, byDevice]);

  /**
   * Operational state per node, derived from the collection pass. Without it
   * the canvas cannot answer the question an operator actually opens it for:
   * where is the problem. The hand-drawn link status is a drawing annotation
   * and is deliberately kept separate from this.
   */
  const nodeStatus = useMemo<Record<string, NodeRuntimeStatus>>(() => {
    const map: Record<string, NodeRuntimeStatus> = {};
    if (!activeTopology) return map;
    const stateById = new Map((topologyState?.nodes || []).map((node) => [node.node_id, node]));
    activeTopology.nodes.forEach((node) => {
      const state = stateById.get(node.node_id);
      const connections = state?.connections || [];
      const completeness = state?.observation?.completeness || "";
      if (!node.linked_device_id || (!connections.length && !state?.observation)) {
        map[node.node_id] = "unknown";
        return;
      }
      if (connections.length && connections.every((connection) => !connection.verified)) {
        map[node.node_id] = "error";
        return;
      }
      if (completeness && completeness !== "complete") {
        map[node.node_id] = "warning";
        return;
      }
      map[node.node_id] = connections.some((connection) => connection.verified) ? "ok" : "warning";
    });
    return map;
  }, [activeTopology, topologyState]);

  /**
   * Filtering. On a 200 device diagram the useful question is never "show me
   * everything" but "show me the Huawei gear", "show me what is broken" or
   * "show me this site" — so the options come from the drawing itself rather
   * than from a fixed list.
   */
  const filterOptions = useMemo(() => {
    const vendors = new Set<string>();
    const groups: Array<{ id: string; name: string }> = [];
    (activeTopology?.nodes || []).forEach((node) => {
      const vendor = byDevice.get(node.linked_device_id || "")?.vendor;
      if (vendor) vendors.add(String(vendor));
    });
    (activeTopology?.groups || []).forEach((group) => groups.push({ id: group.group_id, name: group.name }));
    return { vendors: [...vendors].sort(), groups };
  }, [activeTopology?.nodes, activeTopology?.groups, byDevice]);

  const filterActive = Boolean(canvasFilter.vendors.length || canvasFilter.statuses.length || canvasFilter.groups.length);

  const dimmedNodeIds = useMemo(() => {
    if (!activeTopology || !filterActive) return [];
    const matches = (node: Topology["nodes"][number]) => {
      const vendor = String(byDevice.get(node.linked_device_id || "")?.vendor || "");
      if (canvasFilter.vendors.length && !canvasFilter.vendors.includes(vendor)) return false;
      if (canvasFilter.statuses.length && !canvasFilter.statuses.includes(nodeStatus[node.node_id] || "unknown")) return false;
      if (canvasFilter.groups.length && !canvasFilter.groups.includes(String(node.group_id || ""))) return false;
      return true;
    };
    return activeTopology.nodes.filter((node) => !matches(node)).map((node) => node.node_id);
  }, [activeTopology, canvasFilter, filterActive, byDevice, nodeStatus]);

  const toggleFilter = useCallback((kind: "vendors" | "statuses" | "groups", value: string) => {
    setCanvasFilter((current) => {
      const selected = current[kind] as string[];
      return {
        ...current,
        [kind]: selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value],
      } as typeof current;
    });
  }, []);

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
      const result = mergeTopologies(lastConfirmed, mine, theirs);
      // Any resolution writes on top of their version, so the next save is
      // accepted instead of conflicting again.
      serverVersionsRef.current.set(mine.topology_id, theirs.version);
      setConflict({ base: lastConfirmed, mine, theirs, merged: result.topology, conflicts: result.conflicts, stats: result.stats });
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
    if (!history.length || !activeTopology) return;
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
    if (!future.length || !activeTopology) return;
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
      resetLinkForm();
    },
    [activeTopology, resetLinkForm, setNotice]
  );

  // Save new link from pending connection
  const handleSaveLink = (e: FormEvent) => {
    e.preventDefault();
    if (!activeTopology || !pendingConnection) return;

    const newLink: TopologyLink = {
      link_id: `link-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      source_node_id: pendingConnection.source,
      source_interface: linkForm.source_interface.trim() || "GE0/1",
      target_node_id: pendingConnection.target,
      target_interface: linkForm.target_interface.trim() || "GE0/0",
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
    setNotice("拓扑链路已创建");
  };

  // Delete node from topology
  const handleRemoveNode = useCallback(
    async (nodeId: string) => {
      if (!activeTopology) return;
      const node = activeTopology.nodes.find((item) => item.node_id === nodeId);
      const dev = byDevice.get(node?.linked_device_id || "");
      const isUnlinked = !node?.linked_device_id;
      const devName = node?.display_name || dev?.name || nodeId;

      const confirmed = await confirm({
        title: "从拓扑中移除节点",
        body: isUnlinked
          ? `将从拓扑“${activeTopology.name}”中删除图纸设备“${devName}”及关联链路。它不是工作区设备，不影响任何管理连接。`
          : `将从拓扑“${activeTopology.name}”中移除节点“${devName}”及关联链路。\n工作区的“${devName}”设备实体及管理连接将被完整保留，不受任何影响。`,
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
      setNotice(isUnlinked ? `已删除图纸设备“${devName}”` : `已从拓扑移除节点“${devName}”，工作区设备实体完整保留`);
    },
    [activeTopology, byDevice, pushState, setNotice]
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

  // Add device to canvas from palette
  const handleAddDeviceToCanvas = (dev: Device, position?: { x: number; y: number }) => {
    if (!activeTopology) return;

    const nodeCount = activeTopology.nodes.length;
    const col = nodeCount % 4;
    const row = Math.floor(nodeCount / 4);
    const newX = Math.round(position?.x ?? 120 + col * 220);
    const newY = Math.round(position?.y ?? 100 + row * 160);

    const newNode: TopologyNode = {
      node_id: `node_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      linked_device_id: dev.device_id,
      device_type: dev.device_type,
      display_name: dev.name,
      x: newX,
      y: newY,
    };

    pushState({
      ...activeTopology,
      nodes: [...activeTopology.nodes, newNode],
    });
    setNotice(`设备“${dev.name}”已加入画布；图纸节点可按需要重复呈现同一登记设备。`);
  };

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
    setNotice(`已在画布创建图纸设备“${name}”。可随时在节点详情中关联登记设备。`);
  }, [activeTopology, manualNodeName, manualNodeType, pushState, setNotice]);

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

  const handlePaletteDragStart = useCallback((event: DragEvent<HTMLDivElement>, deviceId: string) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-lzcore-device-id", deviceId);
    event.dataTransfer.setData("text/plain", deviceId);
  }, []);

  const handleNetOpsDrop = useCallback((deviceId: string, position: { x: number; y: number }) => {
    const device = devices.find((item) => item.device_id === deviceId);
    if (!device) return;
    handleAddDeviceToCanvas(device, position);
  }, [devices, handleAddDeviceToCanvas]);

  const handleNetOpsMove = useCallback((positions: Array<{ element_id: string; x: number; y: number }>) => {
    if (!activeTopology || !positions.length) return;
    const byId = new Map(positions.map((position) => [position.element_id, position]));
    pushState({ ...activeTopology, nodes: activeTopology.nodes.map((node) => {
      const position = byId.get(node.node_id);
      return position ? { ...node, x: Math.round(position.x), y: Math.round(position.y) } : node;
    }), canvas_items: (activeTopology.canvas_items || []).map((item) => {
      const position = byId.get(`canvas-${item.item_id}`);
      return position ? { ...item, x: Math.round(position.x), y: Math.round(position.y) } : item;
    }) });
  }, [activeTopology, pushState]);

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

  /**
   * Neighbour discovery. Hand-drawing a 200 device topology is not realistic;
   * the neighbour tables already collected from the devices are, so offer the
   * links that exist on the wire but were never drawn.
   */
  const [discovery, setDiscovery] = useState<{ candidates: DiscoveryCandidate[]; note: string; scanned_devices: number } | null>(null);
  const [showDiscovery, setShowDiscovery] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [adoptedIds, setAdoptedIds] = useState<string[]>([]);
  const handleDiscover = useCallback(async () => {
    if (!activeTopology) return;
    setDiscovering(true);
    try {
      const result = await apiRequest<{ candidates: DiscoveryCandidate[]; note: string; scanned_devices: number }>({
        method: "GET",
        url: `${base}/topologies/${activeTopology.topology_id}/discover`,
        params: { workspace_id: workspaceId },
      });
      setDiscovery({ candidates: result.candidates || [], note: result.note || "", scanned_devices: result.scanned_devices || 0 });
      setAdoptedIds((result.candidates || []).map((_, index) => String(index)));
      setShowDiscovery(true);
    } catch {
      setNotice("邻居发现失败，请稍后重试", false);
    } finally {
      setDiscovering(false);
    }
  }, [activeTopology, workspaceId, setNotice]);

  const adoptCandidates = useCallback(() => {
    if (!activeTopology || !discovery) return;
    const chosen = adoptedIds.map((index) => discovery.candidates[Number(index)]).filter(Boolean);
    if (!chosen.length) {
      setNotice("请先选择要采纳的候选链路", false);
      return;
    }
    const links: TopologyLink[] = chosen.map((candidate) => ({
      link_id: `link-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      source_node_id: candidate.source_node_id,
      target_node_id: candidate.target_node_id,
      source_interface: candidate.source_interface || "待核实",
      target_interface: candidate.target_interface || "待核实",
      kind: "physical",
      source: "discovered",
      status: "unknown",
      evidence_refs: candidate.evidence_artifact_id ? [candidate.evidence_artifact_id] : [],
    }));
    pushState({ ...activeTopology, links: [...activeTopology.links, ...links] });
    setNotice(`已采纳 ${links.length} 条发现链路，接口待现场核实`);
    setShowDiscovery(false);
  }, [activeTopology, discovery, adoptedIds, pushState, setNotice]);

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
        const device = byDevice.get(node.linked_device_id || "");
        return [node.display_name, node.device_type, device?.name, device?.host].some((value) => String(value || "").toLowerCase().includes(query));
      })
      .map((node) => ({ id: node.node_id, kind: "node" as const, label: node.display_name || byDevice.get(node.linked_device_id || "")?.name || node.node_id, detail: byDevice.get(node.linked_device_id || "")?.host || "图纸设备" }));
    const items = (activeTopology.canvas_items || [])
      .filter((item) => (item.text || "").toLowerCase().includes(query))
      .map((item) => ({ id: `canvas-${item.item_id}`, kind: "canvas_item" as const, label: item.text || item.kind, detail: "图纸图元" }));
    return [...nodes, ...items].slice(0, 8);
  }, [canvasQuery, activeTopology, byDevice]);

  const focusCanvasObject = useCallback((id: string, kind: "node" | "canvas_item") => {
    setSelectedElement(kind === "node" ? { type: "node", nodeId: id } : { type: "canvas_item", itemId: id.replace(/^canvas-/, "") });
    setCanvasQuery("");
    // Release focus, otherwise the shortcut guard keeps swallowing keys and
    // the user has to click the canvas before V/M/C work again.
    searchInputRef.current?.blur();
    // Let the inspector settle first; it resizes the canvas and would
    // otherwise drag the focused node away from the centre.
    window.setTimeout(() => canvasApiRef.current?.focusIds([id], 1.1), 260);
  }, []);

  const nudgeSelected = useCallback((dx: number, dy: number) => {
    if (!activeTopology || !canvasSelectedElementIds.length) return;
    const ids = new Set(canvasSelectedElementIds);
    pushState({ ...activeTopology, nodes: activeTopology.nodes.map((node) => (ids.has(node.node_id) ? { ...node, x: node.x + dx, y: node.y + dy } : node)) });
  }, [activeTopology, canvasSelectedElementIds, pushState]);

  // Batch editing: selecting ten devices and being able to do nothing with
  // them is the point where people go back to Visio.
  const selectedNodes = useMemo(() => (activeTopology?.nodes || []).filter((node) => canvasSelectedElementIds.includes(node.node_id)), [activeTopology, canvasSelectedElementIds]);
  const selectedCanvasItems = useMemo(() => (activeTopology?.canvas_items || []).filter((item) => canvasSelectedElementIds.includes(`canvas-${item.item_id}`)), [activeTopology, canvasSelectedElementIds]);
  const hasMultiSelection = selectedNodes.length + selectedCanvasItems.length > 1;

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
      body: `将从拓扑中移除 ${nodeIds.length} 个节点、${itemIds.length} 个图元及其关联链路。\n工作区设备实体与管理连接不受影响。`,
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
   * Keyboard shortcuts. Every diagram tool people already know (draw.io,
   * Figma, Visio) is keyboard driven, and the canvas is where an operator
   * spends their time, so the common gestures get single keys.
   */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
          return;
        case "Delete":
        case "Backspace":
          if (selectedElement) {
            e.preventDefault();
            deleteSelection();
          }
          return;
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
  }, [handleUndo, handleRedo, executeSave, deleteSelection, nudgeSelected, canvasSelectedElementIds]);

  const layoutTopologyNodes = useCallback(
    (topology: Topology, nodesToLayout = topology.nodes) => {
      const ordered = [...nodesToLayout].sort((left, right) =>
        (left.display_name || byDevice.get(left.linked_device_id || "")?.name || left.node_id).localeCompare(
          right.display_name || byDevice.get(right.linked_device_id || "")?.name || right.node_id,
          "zh-Hans-CN"
        )
      );
      const columns = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(ordered.length || 1))));
      return ordered.map((node, index) => ({
        ...node,
        x: 120 + (index % columns) * 250,
        y: 110 + Math.floor(index / columns) * 180,
      }));
    },
    [byDevice]
  );

  const handleAddAllDevices = useCallback(() => {
    if (!activeTopology) return;
    const existingIds = new Set(activeTopology.nodes.map((node) => node.linked_device_id));
    const additions = devices
      .filter((device) => !existingIds.has(device.device_id))
      .map((device) => ({ node_id: `node_${Date.now()}_${device.device_id}`, linked_device_id: device.device_id, device_type: device.device_type, display_name: device.name, x: 0, y: 0 }));
    if (!additions.length) {
      setNotice("工作区设备已经全部在当前画布中", false);
      return;
    }
    const nodes = layoutTopologyNodes(activeTopology, [...activeTopology.nodes, ...additions]);
    pushState({ ...activeTopology, nodes });
    setNotice(`已加入 ${additions.length} 台设备，并完成网格排布`);
  }, [activeTopology, devices, layoutTopologyNodes, pushState, setNotice]);

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
      body: `将永久删除拓扑“${activeTopology.name}”。\n关联的 Skill 将自动解除引用；工作区中的所有设备与连接均不会受任何影响。此操作不可撤销。`,
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

  // Compare topology against reality / evidence
  const handleCompareTopology = async () => {
    if (!activeTopology) return;
    setComparing(true);
    try {
      const res = await apiRequest<TopologyCompareResult>({
        method: "GET",
        url: `${base}/topologies/${activeTopology.topology_id}/compare`,
        params: { workspace_id: workspaceId },
      });
      setCompareResult(res);
      setShowCompareModal(true);
    } catch (err: unknown) {
      setNotice((err as { message?: string })?.message || "拓扑比对失败", false);
    } finally {
      setComparing(false);
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
    void refreshFacts();
    if (!activeTopology) return;
    try {
      const res = await apiRequest<{ topology: Topology }>({
        method: "GET",
        url: `${base}/topologies/${activeTopology.topology_id}`,
        params: { workspace_id: workspaceId },
      });
      const remote = res.topology;
      if (!remote || remote.version === activeTopology.version) return;
      if (saveStatus !== "saved") {
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
  }, [activeTopology, workspaceId, saveStatus, adoptServerTopology, setNotice, refreshFacts]);

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

  const selectedNodeDevice = useMemo(() => {
    if (!selectedNode) return null;
    return byDevice.get(selectedNode.linked_device_id || "") || null;
  }, [selectedNode, byDevice]);

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

  // Filtered devices for palette
  const filteredPaletteDevices = useMemo(() => {
    return devices.filter((dev) => {
      const matchRegion = !regionFilter || dev.region_id === regionFilter;
      const matchSearch =
        !deviceSearch ||
        `${dev.name} ${dev.host} ${dev.vendor}`.toLowerCase().includes(deviceSearch.toLowerCase());
      return matchRegion && matchSearch;
    });
  }, [devices, regionFilter, deviceSearch]);

  const placedDeviceIds = useMemo(() => {
    return new Set((activeTopology?.nodes || []).map((n) => n.linked_device_id).filter(Boolean));
  }, [activeTopology?.nodes]);

  // Skills referencing this topology
  const relatedSkills = useMemo(() => {
    if (!activeTopology) return [];
    return skills.filter((s) => s.topology_id === activeTopology.topology_id);
  }, [skills, activeTopology]);

  if (loadError) {
    return (
      <div className="topology-empty-state" role="alert">
        <div className="topology-empty-card topology-load-error">
          <div className="topology-empty-icon">
            <IconShield size={36} />
          </div>
          <h3>拓扑数据加载失败</h3>
          <p>无法读取拓扑列表，当前不显示“空拓扑”以免掩盖服务或接口问题。请刷新；若仍失败，请检查网络扩展后端是否已更新。</p>
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
          <h3>尚未创建网络拓扑</h3>
          <p>网络拓扑图用于独立维护设备间的二三层互联关系与逻辑分组。设备管理连接保持不变，拓扑链路支持与真实巡检证据比对。</p>
          <Button
            variant="primary"
            icon={<IconPlus size={14} />}
            onClick={() => {
              setTopologyModalMode("create");
              setTopologyNameInput("");
              setTopologyDescInput("");
            }}
          >
            创建第一个网络拓扑
          </Button>
        </div>

        {topologyModalMode === "create" && (
          <dialog open className="network-dialog-modal">
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
          <p>正在同步图纸与设备目录。</p>
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

        {/* Device Palette */}
        <div className="topology-sidebar-section palette-device-section">
          <div className="section-title-row">
            <span className="section-title">工作区设备 ({devices.length})</span>
            {devices.length > placedDeviceIds.size ? (
              <Button size="sm" icon={<IconPlus size={11} />} onClick={handleAddAllDevices}>
                加入全部
              </Button>
            ) : (
              <small className="section-subtitle">已全部加入</small>
            )}
          </div>
          <div className="palette-search-row">
            <div className="palette-search-input-wrap">
              <IconSearch size={13} className="search-icon" />
              <input
                placeholder="搜索名称 / IP"
                value={deviceSearch}
                onChange={(e) => setDeviceSearch(e.target.value)}
              />
            </div>
            {regions.length > 0 && (
              <select
                value={regionFilter}
                onChange={(e) => setRegionFilter(e.target.value)}
                className="palette-region-select"
              >
                <option value="">全部区域</option>
                {regions.map((r) => (
                  <option key={r.region_id} value={r.region_id}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="palette-device-list">
            {filteredPaletteDevices.length ? (
              filteredPaletteDevices.map((dev) => {
                const isPlaced = placedDeviceIds.has(dev.device_id);
                return (
                  <div
                    key={dev.device_id}
                    className={`palette-device-item ${isPlaced ? "is-placed" : ""}`}
                    data-testid={`palette-dev-${dev.device_id}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`定位设备 ${dev.name}`}
                    // A diagram may intentionally show the same registered
                    // asset in more than one visual context. Click locates an
                    // existing node; drag always adds another diagram node.
                    draggable
                    onDragStart={(event) => handlePaletteDragStart(event, dev.device_id)}
                    onClick={() => { const node = activeTopology?.nodes.find((item) => item.linked_device_id === dev.device_id); if (node) setSelectedElement({ type: "node", nodeId: node.node_id }); }}
                    onKeyDown={(event) => { if (event.key === "Enter") { const node = activeTopology?.nodes.find((item) => item.linked_device_id === dev.device_id); if (node) setSelectedElement({ type: "node", nodeId: node.node_id }); } }}
                  >
                    <div className="palette-dev-icon">
                      <DeviceTypeIcon deviceType={dev.device_type} size={15} />
                    </div>
                    <div className="palette-dev-info">
                      <div className="palette-dev-name-row">
                        <strong>{dev.name}</strong>
                        <span className={`vendor-badge vendor-${dev.vendor.toLowerCase()}`}>
                          {dev.vendor.toUpperCase()}
                        </span>
                      </div>
                      <small>
                        {dev.host} · {byRegion.get(dev.region_id) || "未分区"}
                      </small>
                    </div>
                    {isPlaced ? (
                      <span className="palette-badge-placed">已在画布 · 可再添加</span>
                    ) : (
                      <Button
                        size="sm"
                        icon={<IconPlus size={11} />}
                        onClick={() => handleAddDeviceToCanvas(dev)}
                      >
                        加入
                      </Button>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="palette-empty">没有匹配的设备</div>
            )}
          </div>
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
          </div>

          <div className="toolbar-right">
            <div className="canvas-search-wrap">
              <IconSearch size={13} />
              <input
                ref={searchInputRef}
                value={canvasQuery}
                placeholder="搜索设备 / IP  /"
                aria-label="在画布中搜索设备"
                onChange={(event) => setCanvasQuery(event.target.value)}
                onBlur={() => window.setTimeout(() => setCanvasQuery(""), 180)}
              />
              {canvasMatches.length > 0 && (
                <div className="canvas-search-results">
                  {canvasMatches.map((match) => (
                    <button key={match.id} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => focusCanvasObject(match.id, match.kind)}>
                      <span>{match.label}</span>
                      <small>{match.detail}</small>
                    </button>
                  ))}
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
            <button className="studio-icon-button" aria-label={focusMode ? "退出专注画布" : "专注画布"} title="专注画布" onClick={() => setFocusMode((value) => !value)}><IconExpand size={18} /></button>
            <Button size="sm" icon={<IconSparkle size={15} />} variant={showAgent ? "primary" : "default"} onClick={() => { setShowAgent((value) => !value); setIsInspectorOpen(false); }}>Agent 协作</Button>
          </div>
        </div>
        <div className="topology-editbar">
          <div className="studio-edit-tools" role="group" aria-label="画布工具">
            <button className="studio-mode-button" aria-pressed={canvasMode === "select"} onClick={() => setCanvasMode("select")}><IconMenu size={13} />选择</button>
            <button className="studio-mode-button" aria-pressed={canvasMode === "connect"} onClick={() => setCanvasMode("connect")}><IconLink size={13} />连线</button>
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
              disabled={!history.length}
              onClick={handleUndo}
              title="撤销 (Ctrl+Z / Cmd+Z)"
            >
              撤销
            </Button>
            <Button
              size="sm"
              icon={<IconRedo size={13} />}
              disabled={!future.length}
              onClick={handleRedo}
              title="重做 (Ctrl+Y / Cmd+Shift+Z)"
            >
              重做
            </Button>
            <Button
              size="sm"
              icon={<IconBranch size={13} />}
              onClick={() => openLinkComposer()}
              disabled={(activeTopology?.nodes?.length || 0) < 2}
            >
              新建链路
            </Button>
            <Button
              size="sm"
              icon={<IconPlus size={13} />}
              onClick={onCreateDevice}
              title="登记新的工作区设备；登记后可加入当前画布"
            >
              添加设备
            </Button>
            <Button
              size="sm"
              icon={<IconPlus size={13} />}
              onClick={() => { setManualNodeName(""); setManualNodeType("switch"); setShowManualNodeModal(true); }}
            >
              添加图纸设备
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
            <details className="studio-filter-menu">
              <summary><IconSearch size={13} />过滤{filterActive ? ` · ${dimmedNodeIds.length} 项已淡化` : ""}</summary>
              <div>
                <small>厂商</small>
                {filterOptions.vendors.map((vendor) => (
                  <label key={`vendor-${vendor}`}>
                    <input type="checkbox" checked={canvasFilter.vendors.includes(vendor)} onChange={() => toggleFilter("vendors", vendor)} />
                    <span>{vendor}</span>
                  </label>
                ))}
                {!filterOptions.vendors.length && <small>画布上的设备还没有厂商信息</small>}
                <small>运行状态</small>
                {NODE_STATUS_ORDER.map((status) => (
                  <label key={`status-${status}`}>
                    <input type="checkbox" checked={canvasFilter.statuses.includes(status)} onChange={() => toggleFilter("statuses", status)} />
                    <i style={{ background: NODE_STATUS_SWATCH[status] }} />
                    <span>{status === "ok" ? "正常" : status === "warning" ? "待确认" : status === "error" ? "不可达" : "未采集"}</span>
                  </label>
                ))}
                {filterOptions.groups.length > 0 && <small>分组</small>}
                {filterOptions.groups.map((group) => (
                  <label key={`group-${group.id}`}>
                    <input type="checkbox" checked={canvasFilter.groups.includes(group.id)} onChange={() => toggleFilter("groups", group.id)} />
                    <span>{group.name}</span>
                  </label>
                ))}
                <Button size="sm" disabled={!filterActive} onClick={() => setCanvasFilter({ vendors: [], statuses: [], groups: [] })}>清除过滤</Button>
              </div>
            </details>
            <Button
              size="sm"
              icon={<IconBranch size={13} />}
              onClick={() => void handleDiscover()}
              disabled={discovering || !activeTopology}
              title="从已采集的 LLDP / CDP 邻居表中找出尚未绘制的链路"
            >
              {discovering ? "发现中…" : "发现邻居"}
            </Button>
            <Button
              size="sm"
              icon={<IconEye size={13} />}
              onClick={handleCompareTopology}
              disabled={comparing}
            >
              {comparing ? "比对中..." : "拓扑比对"}
            </Button>
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

        {/* NetOps Cytoscape canvas, with LZCore topology persistence and evidence kept outside the renderer. */}
        <div className={`topology-canvas-viewport mode-${canvasMode}`}>
          <div className="studio-canvas-caption"><strong>{activeTopology?.nodes.length || 0} 个节点</strong><span>·</span><span>{activeTopology?.links.length || 0} 条连接</span>{canvasSelectedElementIds.length > 0 && <span className="canvas-selection-count">已选 {canvasSelectedElementIds.length} 个对象</span>}
            {filterActive && <span className="canvas-selection-count canvas-filter-count">过滤中 · {dimmedNodeIds.length} 个对象已淡化<button type="button" aria-label="清除画布过滤" onClick={() => setCanvasFilter({ vendors: [], statuses: [], groups: [] })}><IconClose size={11} /></button></span>}<span className="canvas-mode-hint">{canvasMode === "connect" ? "依次选择两个节点以连线" : "单击选择对象，拖动对象移动位置，拖动空白平移画布；Shift + 拖框多选"}</span><label><input type="checkbox" checked={showInterfaces} onChange={(event) => setShowInterfaces(event.target.checked)} />接口标签</label><label><input type="checkbox" checked={gridEnabled} onChange={(event) => setGridEnabled(event.target.checked)} />网格</label></div>
          {!activeTopology?.nodes?.length && (
            <div className="topology-canvas-onboarding">
              <div className="topology-canvas-onboarding-card">
                <IconBranch size={24} />
                <div>
                  <strong>从设备开始建图</strong>
                  <p>先放入现有设备，再通过节点连接点或“新建链路”填写两端接口。</p>
                </div>
                <Button size="sm" variant="primary" icon={<IconPlus size={12} />} onClick={handleAddAllDevices}>
                  加入全部 {devices.length} 台设备
                </Button>
                <Button size="sm" icon={<IconPlus size={12} />} onClick={onCreateDevice}>
                  登记新设备
                </Button>
              </div>
            </div>
          )}
          <NetOpsCanvas
            topology={activeTopology}
            devices={devices}
            mode={canvasMode}
            gridEnabled={gridEnabled}
            showInterfaces={showInterfaces}
            dimmedNodeIds={dimmedNodeIds}
            onSelectNode={(nodeId) => setSelectedElement({ type: "node", nodeId })}
            onSelectCanvasItem={(itemId) => setSelectedElement({ type: "canvas_item", itemId })}
            onSelectLink={(linkId) => setSelectedElement({ type: "link", linkId })}
            onClearSelection={() => { setSelectedElement(null); setIsInspectorOpen(false); }}
            onSelectionChange={setCanvasSelectedElementIds}
            onMoveElements={handleNetOpsMove}
            onConnect={(source, target) => { openLinkComposer(source, target); setCanvasMode("select"); }}
            onDropDevice={handleNetOpsDrop}
            onReady={(api) => { canvasApiRef.current = api; }}
            onContextMenu={setContextMenu}
            nodeStatus={nodeStatus}
          />
          <div className={`canvas-legend ${legendOpen ? "" : "is-collapsed"}`} aria-label="画布图例">
            <button type="button" className="legend-title" onClick={() => setLegendOpen((value) => !value)}>{legendOpen ? "图例" : "图例 ▸"}</button>
            {legendOpen && (
              <div className="legend-body">
                <span><i className="legend-ring" style={{ borderColor: "var(--ok)" }} />管理访问正常</span>
                <span><i className="legend-ring" style={{ borderColor: "var(--warn)" }} />采集不完整</span>
                <span><i className="legend-ring" style={{ borderColor: "var(--danger)" }} />管理访问失败</span>
                <span><i className="legend-ring" style={{ borderColor: "var(--text-4)" }} />未纳管 / 未采集</span>
                <span><i className="legend-line" />物理链路（实线）</span>
                <span><i className="legend-line dashed" />逻辑链路（虚线）</span>
                <span><i className="legend-swatch" />节点底色＝厂商</span>
                <small>链路颜色为图纸标注，非实时状态</small>
              </div>
            )}
          </div>
        </div>
        <footer className="studio-statusbar"><span>{stateError || (topologyState ? `记录同步 ${new Date(topologyState.refreshed_at).toLocaleTimeString("zh-CN", { hour12: false })}` : "正在读取设备记录…")}</span><span>节点边框＝运行状态 · 底色＝厂商 · 链路＝图纸标注</span><button onClick={() => void refreshFacts()}><IconRefresh size={12} />刷新状态</button></footer>
      </main>

      {activeTopology && <aside className="studio-agent-dock" aria-hidden={!showAgent}><TopologyAgentPanel key={`${workspaceId}:${activeTopology.topology_id}`} workspaceId={workspaceId} topology={activeTopology} skills={skills} selection={canvasSelection} onCompleted={() => { void handleAgentCompleted(); }} /></aside>}

      {contextMenu && (
        <div className="canvas-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseDown={(event) => event.stopPropagation()}>
          {contextMenu.kind === "node" && (
            <>
              <button type="button" onClick={() => { setSelectedElement({ type: "node", nodeId: contextMenu.id }); setIsInspectorOpen(true); setContextMenu(null); }}>打开设备详情</button>
              <button type="button" onClick={() => { setSelectedElement({ type: "node", nodeId: contextMenu.id }); setShowAgent(true); setIsInspectorOpen(false); setContextMenu(null); }}>围绕此设备对话</button>
              <button type="button" className="danger" onClick={() => { void handleRemoveNode(contextMenu.id); setContextMenu(null); }}>从拓扑移除</button>
            </>
          )}
          {contextMenu.kind === "link" && (
            <>
              <button type="button" onClick={() => { setSelectedElement({ type: "link", linkId: contextMenu.id }); setIsInspectorOpen(true); setContextMenu(null); }}>编辑链路</button>
              <button type="button" onClick={() => { setSelectedElement({ type: "link", linkId: contextMenu.id }); setShowAgent(true); setIsInspectorOpen(false); setContextMenu(null); }}>围绕此链路对话</button>
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
              <div><dt>V / C</dt><dd>选择 / 连线</dd></div>
              <div><dt>Shift + 拖动</dt><dd>框选多个对象</dd></div>
              <div><dt>Delete</dt><dd>删除选中对象</dd></div>
              <div><dt>Ctrl/⌘ + A</dt><dd>全选</dd></div>
              <div><dt>方向键</dt><dd>微移选中对象（Shift 加速）</dd></div>
              <div><dt>F</dt><dd>适配全部对象</dd></div>
              <div><dt>Shift + F</dt><dd>缩放至选中对象</dd></div>
              <div><dt>/</dt><dd>搜索设备并定位</dd></div>
              <div><dt>I</dt><dd>切换接口标签</dd></div>
              <div><dt>Shift + G</dt><dd>切换网格</dd></div>
              <div><dt>Ctrl/⌘ + Z / Y</dt><dd>撤销 / 重做</dd></div>
              <div><dt>Ctrl/⌘ + S</dt><dd>立即保存</dd></div>
              <div><dt>滚轮</dt><dd>缩放视图</dd></div>
              <div><dt>Esc</dt><dd>关闭面板 / 退出专注模式</dd></div>
              <div><dt>?</dt><dd>显示本帮助</dd></div>
            </dl>
          </div>
        </div>
      )}

      {/* 3. Right: Inspector */}
      <aside className={`topology-inspector ${isInspectorOpen ? "is-open" : ""}`} aria-label="拓扑详情">
        {hasMultiSelection ? (
          <div className="inspector-panel">
            <div className="inspector-header">
              <h4>已选 {selectedNodes.length + selectedCanvasItems.length} 个对象</h4>
              <Button size="sm" onClick={() => canvasApiRef.current?.clearSelection()} aria-label="取消选择"><IconClose size={13} /></Button>
            </div>
            <div className="inspector-section">
              <p className="inspector-desc">{selectedNodes.length} 台设备 · {selectedCanvasItems.length} 个图元。批量操作一次作用于全部选中对象，可用 Ctrl+Z 撤销。</p>
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
              <span className="inspector-label">微移</span>
              <p className="inspector-desc">方向键移动 8px，按住 Shift 移动 32px。</p>
              <span className="inspector-label">危险操作</span>
              <Button size="sm" variant="danger" icon={<IconTrash size={13} />} onClick={() => void removeSelectedObjects()}>移除选中的对象</Button>
            </div>
          </div>
        ) : selectedElement?.type === "node" && selectedNode ? (
          <div className="inspector-panel">
            <div className="inspector-header">
              <h4>{selectedNode.display_name || selectedNodeDevice?.name || "图纸设备"}</h4>
              <Button size="sm" onClick={() => { setSelectedElement(null); setIsInspectorOpen(false); }} aria-label="收起节点详情">
                <IconClose size={13} />
              </Button>
            </div>

            <div className="inspector-section">
              <label className="inspector-field">
                关联登记设备（可选）
                <select
                  aria-label="关联登记设备"
                  value={selectedNode.linked_device_id || ""}
                  onChange={(event) => {
                    if (!activeTopology) return;
                    const linked_device_id = event.target.value || undefined;
                    pushState({ ...activeTopology, nodes: activeTopology.nodes.map((node) => node.node_id === selectedNode.node_id ? { ...node, linked_device_id } : node) });
                  }}
                >
                  <option value="">未关联（仅图纸）</option>
                  {devices.map((device) => <option key={device.device_id} value={device.device_id}>{device.name} · {device.host}</option>)}
                </select>
                <small className="inspector-desc">关联后才展示管理状态并允许 Agent 将它作为真实设备上下文；解除关联不会删除图纸节点或链路。</small>
              </label>
              {selectedNodeDevice ? <div className="inspector-entity-card">
                <div className="entity-card-row"><strong>{selectedNodeDevice.name}</strong><span className={`vendor-badge vendor-${selectedNodeDevice.vendor.toLowerCase()}`}>{selectedNodeDevice.vendor.toUpperCase()}</span></div>
                <small className="entity-card-meta">IP: {selectedNodeDevice.host} · 角色: {selectedNodeDevice.device_type}{selectedNodeDevice.device_model ? ` · 型号: ${selectedNodeDevice.device_model}` : ""}</small>
                <div className="entity-card-note">这是可选关联；图纸名称、图标、位置和接口仍独立维护。</div>
              </div> : <div className="inspector-entity-card"><strong>未关联登记设备</strong><div className="entity-card-note">该节点只属于当前图纸，不会成为管理连接、巡检或 Agent 操作目标。</div></div>}
            </div>

            {selectedNodeDevice ? <div className="inspector-section studio-device-status"><span className="inspector-label">管理访问与观察记录</span>{(topologyState?.nodes.find((node) => node.node_id === selectedNode.node_id)?.connections || []).map((connection) => <div key={connection.connection_id}><strong>{connection.protocol.toUpperCase()} : {connection.port}</strong><span>{connection.last_tested_at ? `${connection.verified ? "上次验证成功" : "上次验证未通过"} · ${formatObservedTime(connection.last_tested_at)}` : "尚无连接测试记录"}</span></div>)}<p>最近采集：{formatObservedTime(topologyState?.nodes.find((node) => node.node_id === selectedNode.node_id)?.observation?.observed_at)}</p><Button variant="primary" icon={<IconSparkle size={14} />} onClick={() => { setShowAgent(true); setIsInspectorOpen(false); }}>围绕此设备对话</Button></div> : null}

            <div className="inspector-section">
              <label className="inspector-field">
                图纸图标
                <select
                  aria-label="图纸图标"
                  value={selectedNode.device_type || selectedNodeDevice?.device_type || "switch"}
                  onChange={(e) => {
                    if (!activeTopology) return;
                    const type = e.target.value;
                    const updated = activeTopology.nodes.map((n) =>
                      n.node_id === selectedNode.node_id ? { ...n, device_type: type } : n
                    );
                    pushState({ ...activeTopology, nodes: updated });
                  }}
                >
                  <option value="router">路由器</option><option value="switch">二层交换机</option><option value="l3_switch">三层交换机</option><option value="firewall">防火墙</option><option value="server">服务器</option><option value="wireless">无线设备</option><option value="cloud">云 / Internet</option>
                </select>
                <small className="inspector-desc">仅改变当前图纸的图标，不会修改设备实体、连接或 Agent 操作范围。</small>
              </label>

              <label className="inspector-field">
                拓扑显示名称（可选）
                <input
                  value={selectedNode.display_name || ""}
                  placeholder={selectedNodeDevice?.name || "默认设备名"}
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
        ) : selectedElement?.type === "link" && selectedLink ? (
          <div className="inspector-panel">
            <div className="inspector-header">
              <h4>链路属性</h4>
              <Button size="sm" onClick={() => { setSelectedElement(null); setIsInspectorOpen(false); }} aria-label="收起链路详情">
                <IconClose size={13} />
              </Button>
            </div>

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
                链路类型
                <select
                  value={selectedLink.kind}
                  onChange={(e) => {
                    if (!activeTopology) return;
                    const val = e.target.value as "physical" | "logical";
                    const updated = activeTopology.links.map((l) =>
                      l.link_id === selectedLink.link_id ? { ...l, kind: val } : l
                    );
                    pushState({ ...activeTopology, links: updated });
                  }}
                >
                  <option value="physical">物理链路 (实线)</option>
                  <option value="logical">逻辑链路 (虚线)</option>
                </select>
              </label>

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
        ) : selectedElement?.type === "canvas_item" && selectedCanvasItem ? (
          <div className="inspector-panel">
            <div className="inspector-header">
              <h4>图纸图元 · {selectedCanvasItem.text || "未命名图元"}</h4>
              <Button size="sm" onClick={() => { setSelectedElement(null); setIsInspectorOpen(false); }} aria-label="收起图元详情">
                <IconClose size={13} />
              </Button>
            </div>

            <div className="inspector-section">
              <p className="inspector-desc">图元只属于当前图纸：用于业务域、注释和边界说明。可编辑类型、文字、样式和尺寸；删除只移除这个图元，不会影响设备或链路。</p>
              <label className="inspector-field">
                图元类型
                <select
                  value={selectedCanvasItem.kind}
                  onChange={(e) => {
                    if (!activeTopology) return;
                    const kind = e.target.value as TopologyCanvasItem["kind"];
                    pushState({ ...activeTopology, canvas_items: (activeTopology.canvas_items || []).map((item) => item.item_id === selectedCanvasItem.item_id ? { ...item, kind } : item) });
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
                  rows={3}
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
            </div>

            <div className="inspector-actions">
              <Button variant="danger" icon={<IconTrash size={13} />} onClick={() => void handleRemoveCanvasItem(selectedCanvasItem.item_id)}>
                删除图纸图元
              </Button>
            </div>
          </div>
        ) : selectedElement?.type === "group" && selectedGroup ? (
          <div className="inspector-panel">
            <div className="inspector-header">
              <h4>分组属性</h4>
              <Button size="sm" onClick={() => { setSelectedElement(null); setIsInspectorOpen(false); }} aria-label="收起分组详情">
                <IconClose size={13} />
              </Button>
            </div>

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
                      {n.display_name || byDevice.get(n.linked_device_id || "")?.name || n.node_id}
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
        ) : (
          <div className="inspector-panel">
            <div className="inspector-header">
              <h4>拓扑概览</h4>
              <Button size="sm" onClick={() => setIsInspectorOpen(false)} aria-label="收起拓扑详情">
                <IconClose size={13} />
              </Button>
            </div>

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
              <span className="inspector-label">关联 Skill ({relatedSkills.length})</span>
              {relatedSkills.length ? (
                <div className="inspector-skill-list">
                  {relatedSkills.map((s) => (
                    <div key={s.skill_id} className="skill-ref-badge">
                      <span>{s.name}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <small className="no-skill-ref">尚无 Skill 关联此拓扑。可在 Skill 编辑面板中选择关联。</small>
              )}
            </div>

            <div className="inspector-section">
              <span className="inspector-label">快捷操作</span>
              <div className="quick-actions-col">
                <Button size="sm" icon={<IconEye size={13} />} onClick={handleCompareTopology}>
                  比对拓扑与运行现状
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
                  修改拓扑基本信息
                </Button>
              </div>
            </div>
          </div>
        )}
      </aside>

      {/* MODAL 1: Create / Edit Topology */}
      {topologyModalMode && (
        <dialog open className="network-dialog-modal">
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
        <dialog open className="network-dialog-modal">
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
                    if (target) setPendingConnection({ source, target });
                  }}
                >
                  {(activeTopology?.nodes || []).map((node) => (
                    <option key={node.node_id} value={node.node_id}>
                      {node.display_name || byDevice.get(node.linked_device_id || "")?.name || node.node_id}
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
                  onChange={(event) =>
                    setPendingConnection({ ...pendingConnection, target: event.target.value })
                  }
                >
                  {(activeTopology?.nodes || [])
                    .filter((node) => node.node_id !== pendingConnection.source)
                    .map((node) => (
                      <option key={node.node_id} value={node.node_id}>
                        {node.display_name || byDevice.get(node.linked_device_id || "")?.name || node.node_id}
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
        <dialog open className="network-dialog-modal" aria-label="新建图纸设备">
          <form onSubmit={handleAddManualNode} className="network-panel modal-panel">
            <div className="modal-header"><div><h3>新建图纸设备</h3><p>先按图纸需要创建；可随后在节点详情关联登记设备，关联前不会被 Agent 操作。</p></div><Button size="sm" type="button" onClick={() => setShowManualNodeModal(false)}><IconClose size={14} /></Button></div>
            <div className="form-grid">
              <label className="full-field">显示名称<input required autoFocus placeholder="如：Internet、核心交换机、第三方系统" value={manualNodeName} onChange={(event) => setManualNodeName(event.target.value)} /></label>
              <label className="full-field">图标类型<select value={manualNodeType} onChange={(event) => setManualNodeType(event.target.value)}><option value="router">路由器</option><option value="switch">交换机</option><option value="firewall">防火墙</option><option value="server">服务器</option><option value="cloud">云 / Internet</option><option value="wireless">无线 AP</option></select></label>
            </div>
            <div className="modal-actions"><Button type="button" onClick={() => setShowManualNodeModal(false)}>取消</Button><Button variant="primary" type="submit">放入画布</Button></div>
          </form>
        </dialog>
      )}

      {/* MODAL 3: Create Group */}
      {showGroupModal && (
        <dialog open className="network-dialog-modal">
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

      {showDiscovery && discovery && (
        <dialog open className="network-dialog-modal compare-modal" aria-label="邻居发现候选">
          <div className="network-panel modal-panel compare-panel">
            <div className="modal-header"><div><h3>邻居发现 · {discovery.candidates.length} 条候选</h3><p>来自已采集证据中的 LLDP / CDP 邻居表；不连接设备</p></div><Button aria-label="关闭邻居发现" onClick={() => setShowDiscovery(false)}><IconClose size={14} /></Button></div>
            <div className="compare-notice-banner">只列出两端都能对应到画布设备的邻居。采纳后链路标记为「发现来源」并带上证据引用，接口待现场核实。</div>
            <div className="compare-details-area">
              {discovery.candidates.map((candidate, index) => (
                <label className="compare-item" key={`${candidate.source_node_id}-${candidate.target_node_id}-${index}`}>
                  <input type="checkbox" checked={adoptedIds.includes(String(index))} onChange={(event) => setAdoptedIds((current) => event.target.checked ? [...current, String(index)] : current.filter((value) => value !== String(index)))} />
                  <span>{nodeLabelById.get(candidate.source_node_id) || candidate.source_device_id} {candidate.source_interface || "?"} ↔ {nodeLabelById.get(candidate.target_node_id) || candidate.target_device_id} {candidate.target_interface || "?"}</span>
                  <small>邻居名 {candidate.remote_name}{candidate.evidence_artifact_id ? " · 已带证据" : ""}</small>
                </label>
              ))}
              {!discovery.candidates.length && (
                <p>{discovery.scanned_devices ? "已扫描的证据里没有尚未绘制的邻居。可先对设备执行一次包含 LLDP / CDP 命令的巡检，再回来发现。" : "当前设备还没有可解析的采集证据，请先执行巡检。"}</p>
              )}
            </div>
            <div className="modal-actions">
              <Button variant="primary" disabled={!discovery.candidates.length} onClick={adoptCandidates}>采纳选中的 {adoptedIds.length} 条</Button>
              <Button onClick={() => setShowDiscovery(false)}>关闭</Button>
            </div>
          </div>
        </dialog>
      )}

      {showConflict && conflict && (
        <dialog open className="network-dialog-modal compare-modal" aria-label="编辑冲突">
          <div className="network-panel modal-panel compare-panel">
            <div className="modal-header">
              <div>
                <h3>这张图纸被其他人修改过</h3>
                <p>你编辑的是版本 {serverVersionsRef.current.get(conflict.mine.topology_id) ?? conflict.mine.version} 之前的图纸，服务端已是版本 {conflict.theirs.version}</p>
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
        <dialog open className="network-dialog-modal compare-modal" aria-label="版本历史">
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

      {showCompareModal && compareResult && (
        <dialog open className="network-dialog-modal compare-modal" aria-label="拓扑比对报告">
          <div className="network-panel modal-panel compare-panel">
            <div className="modal-header"><div><h3>拓扑比对 · {compareResult.topology_name}</h3><p>图纸定义与已有观察证据</p></div><Button aria-label="关闭比对报告" onClick={() => setShowCompareModal(false)}><IconClose size={14} /></Button></div>
            <div className="compare-notice-banner">无两端接口邻接证据的链路显示未知；手工标注不会变成运行结论。</div>
            <div className="compare-metrics-row">
              <div className="metric-box"><span className="metric-val">{compareResult.summary.total_links}</span><span className="metric-lbl">图纸链路</span></div>
              <div className="metric-box"><span className="metric-val">{compareResult.summary.matched_links}</span><span className="metric-lbl">证据已匹配</span></div>
              <div className="metric-box"><span className="metric-val">{compareResult.summary.unknown_evidence_links}</span><span className="metric-lbl">暂无证据链路</span></div>
            </div>
            <div className="compare-details-area">
              {compareResult.link_comparisons.map((link) => <div className="compare-item" key={link.link_id}><span className="compare-status-tag unknown">{link.comparison_status === "unknown" ? "未知" : link.comparison_status}</span><span>{byDevice.get(link.source_device_id)?.name || link.source_device_id} {link.source_interface} ↔ {byDevice.get(link.target_device_id)?.name || link.target_device_id} {link.target_interface}</span><small>{link.note}</small></div>)}
              {!compareResult.link_comparisons.length && <p>当前图纸尚无链路。</p>}
              {compareResult.topology_devices_not_in_scope.map((id) => <p key={id}>设备记录缺失：{id}</p>)}
            </div>
            <div className="modal-actions"><Button onClick={() => setShowCompareModal(false)}>关闭报告</Button></div>
          </div>
        </dialog>
      )}
    </div>
  );
}
