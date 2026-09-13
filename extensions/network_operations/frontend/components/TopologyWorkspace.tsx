import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  ConnectionMode,
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type Connection as FlowConnection,
  type NodeProps,
  type EdgeProps,
  type NodeChange,
  type EdgeChange,
  type ReactFlowInstance,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
// 图标全部走平台统一出口 components/Icon.tsx —— 这是全站唯一的 Phosphor
// 门面，直接 import "@phosphor-icons/react" 会让扩展页与平台图标语义脱钩。
import {
  IconArrowsX,
  IconBox,
  IconBranch,
  IconCheck,
  IconClose,
  IconCloud,
  IconEdit,
  IconEye,
  IconGrid,
  IconLayers,
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
import { layoutTopology, linkHandles } from "./topologyLayout";
import { TopologyAgentPanel, type CanvasSelection } from "./TopologyAgentPanel";
import "./TopologyStudio.css";

export type Device = {
  device_id: string;
  name: string;
  host: string;
  vendor: string;
  device_type: string;
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
  nodes: Array<{ device_id: string; connections: Connection[]; observation: { observed_at: string; completeness: string; source_id: string; artifact_id: string } | null }>;
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
  device_id: string;
  x: number;
  y: number;
  display_name?: string;
  labels?: string[];
  group_id?: string;
};

export type TopologyLink = {
  link_id: string;
  source_device_id: string;
  source_interface: string;
  target_device_id: string;
  target_interface: string;
  kind: "physical" | "logical";
  label?: string;
  metadata?: {
    speed?: string;
    vlan?: string;
    medium?: string;
    subnet?: string;
    address?: string;
    [key: string]: unknown;
  };
  source: "manual" | "discovered";
  evidence_refs?: string[];
  status: "unknown" | "up" | "down";
};

export type TopologyGroup = {
  group_id: string;
  name: string;
  kind: "as" | "region" | "datacenter" | "tenant";
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

/**
 * 设备类型图标。导出给网络运维主页用 —— 设备列表和拓扑画布节点用同一套
 * 类型 → 图标映射，用户从列表切到画布时不会认错设备。
 */
export function DeviceTypeIcon({ deviceType, size = 16 }: { deviceType: string; size?: number }) {
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

type DeviceNodeData = {
  deviceId: string;
  name: string;
  host: string;
  vendor: string;
  deviceType: string;
  displayName?: string;
  labels?: string[];
  groupName?: string;
  hasConnection?: boolean;
  connectionStatus?: string;
  lastTestedAt?: string;
  selectedContext?: boolean;
  dimmed?: boolean;
};

function DeviceNodeComponent({ data, selected }: NodeProps<Node<DeviceNodeData>>) {
  const { name, host, vendor, deviceType, displayName, labels, groupName } = data;
  const testAge = data.lastTestedAt ? Date.now() - Date.parse(data.lastTestedAt) : Infinity;
  const recentAccess = testAge >= 0 && testAge < 5 * 60 * 1000;

  return (
    <div className={`topology-device-node ${selected || data.selectedContext ? "is-selected" : ""} ${data.dimmed ? "is-dimmed" : ""}`} data-testid={`topo-node-${data.deviceId}`}>
      <Handle type="source" position={Position.Top} id="top" isConnectable />
      <Handle type="source" position={Position.Right} id="right" isConnectable />
      <Handle type="source" position={Position.Bottom} id="bottom" isConnectable />
      <Handle type="source" position={Position.Left} id="left" isConnectable />

      <div className="device-node-body">
        <div className={`device-node-icon type-${deviceType.toLowerCase()}`}>
          <DeviceTypeIcon deviceType={deviceType} size={38} />
        </div>
        <div className="device-node-main">
          <div className="device-node-title-row">
            <strong className="device-node-name" title={name}>
              {displayName || name}
            </strong>
            <span className={`vendor-badge vendor-${vendor.toLowerCase()}`}>
              {vendor.toUpperCase()}
            </span>
          </div>
          <div className="device-node-meta">
            <span className="device-node-host">{host}</span>
            <span className="device-node-type">{deviceType === "switch" ? "交换机" : deviceType === "router" ? "路由器" : deviceType}</span>
          </div>
        </div>
      </div>

      <span className={`node-access-dot ${recentAccess ? data.connectionStatus : "unknown"}`} title={data.lastTestedAt ? `上次管理连接：${data.connectionStatus} · ${formatObservedTime(data.lastTestedAt)}${recentAccess ? "" : "（历史记录）"}` : "管理连接尚无测试时间"} />

      {(labels?.length || groupName) ? (
        <div className="device-node-footer">
          {groupName && <span className="device-node-group-chip">{groupName}</span>}
          {labels?.map((label: string) => (
            <span key={label} className="device-node-label-chip">
              {label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

type GroupNodeData = {
  groupId: string;
  name: string;
  kind: "as" | "region" | "datacenter" | "tenant";
  width: number;
  height: number;
};

function GroupNodeComponent({ data, selected }: NodeProps<Node<GroupNodeData>>) {
  const kindLabels: Record<string, string> = {
    as: "自治系统 (AS)",
    region: "区域",
    datacenter: "数据中心",
    tenant: "租户",
  };

  return (
    <div
      className={`topology-group-node ${selected ? "is-selected" : ""}`}
      style={{ width: data.width || 360, height: data.height || 260 }}
      data-testid={`topo-group-${data.groupId}`}
    >
      <div className="group-node-header">
        <span className="group-kind-badge">{kindLabels[data.kind] || data.kind}</span>
        <strong>{data.name}</strong>
      </div>
    </div>
  );
}

function TopologyEdgeComponent({
  id: _id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  data,
  selected,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  });

  const kind = (data?.kind as string) || "physical";
  const srcIf = data?.source_interface as string;
  const tgtIf = data?.target_interface as string;
  const label = data?.label as string;

  // Diagram annotations are not telemetry. Highlight selection, never infer UP.
  const strokeColor = selected || data?.selectedContext ? "var(--accent)" : "var(--topology-link, #8294a6)";

  const edgeStyle = {
    ...style,
    stroke: strokeColor,
    strokeWidth: selected || data?.selectedContext ? 2.5 : 1.6,
    opacity: data?.dimmed ? 0.2 : 1,
    strokeDasharray: kind === "logical" ? "6 4" : undefined,
  };

  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  const offset = 44;
  const srcBadgeX = sourceX + (dx / dist) * offset;
  const srcBadgeY = sourceY + (dy / dist) * offset;
  const tgtBadgeX = targetX - (dx / dist) * offset;
  const tgtBadgeY = targetY - (dy / dist) * offset;

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={edgeStyle} />
      <EdgeLabelRenderer>
        {srcIf && (
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${srcBadgeX}px,${srcBadgeY}px)`,
              pointerEvents: "none",
            }}
            className="edge-if-badge"
          >
            {srcIf}
          </div>
        )}
        {tgtIf && (
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${tgtBadgeX}px,${tgtBadgeY}px)`,
              pointerEvents: "none",
            }}
            className="edge-if-badge"
          >
            {tgtIf}
          </div>
        )}
        {label && (
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: "none",
            }}
            className="edge-center-badge"
          >
            {label}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = {
  deviceNode: DeviceNodeComponent,
  groupNode: GroupNodeComponent,
};

const edgeTypes = {
  topologyEdge: TopologyEdgeComponent,
};

interface TopologyWorkspaceProps {
  workspaceId: string;
  devices: Device[];
  connections: Connection[];
  regions: Region[];
  skills: Skill[];
  topologies: Topology[];
  loadError: string;
  onReload: () => Promise<void>;
  /** ok 省略或为 true 表示成功提示（绿色）；显式传 false 表示失败（警告黄）。 */
  setNotice: (notice: string, ok?: boolean) => void;
  busy: boolean;
}

type SelectedElement =
  | { type: "node"; deviceId: string }
  | { type: "link"; linkId: string }
  | { type: "group"; groupId: string }
  | null;

export default function TopologyWorkspace({
  workspaceId,
  devices,
  connections,
  regions,
  skills,
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
  const saveStatusRef = useRef<"saved" | "saving" | "unsaved">("saved");
  const revisionRef = useRef(0);
  const serverVersionsRef = useRef(new Map<string, number>());
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (saveStatusRef.current !== "saved") return;
    setActiveTopology(currentTopology);
    if (currentTopology) serverVersionsRef.current.set(currentTopology.topology_id, currentTopology.version);
  }, [currentTopology]);

  // Undo / Redo history
  const [history, setHistory] = useState<Topology[]>([]);
  const [future, setFuture] = useState<Topology[]>([]);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "unsaved">("saved");
  const saveTimerRef = useRef<number | null>(null);
  useEffect(() => { setHistory([]); setFuture([]); setSelectedElement(null); }, [selectedTopologyId]);

  // Inspector & selection
  const [selectedElement, setSelectedElement] = useState<SelectedElement>(null);
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const [showAgent, setShowAgent] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [layer, setLayer] = useState<"all" | "physical" | "logical">("all");
  const [showInterfaces, setShowInterfaces] = useState(true);
  const [topologyState, setTopologyState] = useState<TopologyState | null>(null);
  const [stateError, setStateError] = useState("");
  const [layoutBusy, setLayoutBusy] = useState(false);
  const flowRef = useRef<ReactFlowInstance | null>(null);
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
    void refreshFacts();
    const timer = window.setInterval(() => { if (!document.hidden) void refreshFacts(); }, 10000);
    return () => window.clearInterval(timer);
  }, [selectedTopologyId, refreshFacts]);
  const canvasSelection: CanvasSelection = useMemo(() => {
    if (!activeTopology || !selectedElement) return { device_ids: [], link_ids: [], label: "整张拓扑" };
    if (selectedElement.type === "node") return { device_ids: [selectedElement.deviceId], link_ids: [], label: devices.find((dev) => dev.device_id === selectedElement.deviceId)?.name || selectedElement.deviceId };
    if (selectedElement.type === "link") {
      const link = activeTopology.links.find((item) => item.link_id === selectedElement.linkId);
      return link ? { device_ids: [link.source_device_id, link.target_device_id], link_ids: [link.link_id], label: `${devices.find((dev) => dev.device_id === link.source_device_id)?.name || link.source_device_id} ↔ ${devices.find((dev) => dev.device_id === link.target_device_id)?.name || link.target_device_id}` } : { device_ids: [], link_ids: [], label: "整张拓扑" };
    }
    return { device_ids: activeTopology.nodes.filter((node) => node.group_id === selectedElement.groupId).map((node) => node.device_id), link_ids: [], label: activeTopology.groups.find((group) => group.group_id === selectedElement.groupId)?.name || "分组" };
  }, [activeTopology, selectedElement, devices]);

  // Palette filters
  const [deviceSearch, setDeviceSearch] = useState("");
  const [regionFilter, setRegionFilter] = useState("");

  // Modals
  const [topologyModalMode, setTopologyModalMode] = useState<"create" | "edit" | null>(null);
  const [topologyNameInput, setTopologyNameInput] = useState("");
  const [topologyDescInput, setTopologyDescInput] = useState("");

  const [showGroupModal, setShowGroupModal] = useState(false);
  const [groupNameInput, setGroupNameInput] = useState("");
  const [groupKindInput, setGroupKindInput] = useState<"as" | "region" | "datacenter" | "tenant">("datacenter");

  const [pendingConnection, setPendingConnection] = useState<{
    source: string;
    target: string;
  } | null>(null);
  const [linkForm, setLinkForm] = useState({
    source_interface: "GE0/1",
    target_interface: "GE0/0",
    kind: "physical" as "physical" | "logical",
    label: "",
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

  useEffect(() => {
    if (selectedElement && !showAgent) setIsInspectorOpen(true);
  }, [selectedElement, showAgent]);

  // Execute Save
  const executeSave = useCallback(
    (topo: Topology) => {
      const revision = revisionRef.current;
      const work = async () => {
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
          },
        });
        serverVersionsRef.current.set(topo.topology_id, res.topology.version);
        if (revision === revisionRef.current) {
          setActiveTopology(res.topology);
          saveStatusRef.current = "saved"; setSaveStatus("saved");
          void onReload();
        } else {
          setActiveTopology((current) => current?.topology_id === topo.topology_id ? { ...current, version: res.topology.version } : current);
          saveStatusRef.current = "unsaved"; setSaveStatus("unsaved");
        }
      } catch (err: unknown) {
        saveStatusRef.current = "unsaved"; setSaveStatus("unsaved");
        const errMsg = (err as { message?: string })?.message || "自动保存拓扑失败";
        setNotice(errMsg.includes("version_conflict") || errMsg.includes("version conflict") ? "拓扑版本冲突：已被其他操作修改，当前未保存编辑仍保留" : errMsg, false);
      }
      };
      saveChainRef.current = saveChainRef.current.then(work, work);
      return saveChainRef.current;
    },
    [workspaceId, onReload, setNotice]
  );

  // Push state with debounced save
  const pushState = useCallback(
    (next: Topology) => {
      if (!activeTopology) return;
      setHistory((prev) => [...prev.slice(-20), activeTopology]);
      setFuture([]);
      revisionRef.current += 1;
      saveStatusRef.current = "unsaved";
      setActiveTopology(next);
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

  // Keyboard shortcut listener for Undo / Redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, [contenteditable=true]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key === "y") {
        e.preventDefault();
        handleRedo();
      } else if (e.key === "Escape") {
        setFocusMode(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleUndo, handleRedo]);

  // React Flow Nodes
  const flowNodes: Node[] = useMemo(() => {
    if (!activeTopology) return [];

    const groupMap = new Map((activeTopology.groups || []).map((g) => [g.group_id, g.name]));

    const gNodes: Node[] = (activeTopology.groups || []).map((g) => ({
      id: `group-${g.group_id}`,
      type: "groupNode",
      position: { x: g.x, y: g.y },
      data: {
        groupId: g.group_id,
        name: g.name,
        kind: g.kind,
        width: g.width,
        height: g.height,
      },
      selectable: true,
      draggable: true,
      style: { width: g.width, height: g.height },
      zIndex: -1,
    }));

    const dNodes: Node[] = (activeTopology.nodes || []).map((n) => {
      const dev = byDevice.get(n.device_id);
      const conn = connections.find((c) => c.device_id === n.device_id);
      return {
        id: n.device_id,
        type: "deviceNode",
        position: { x: n.x, y: n.y },
        data: {
          deviceId: n.device_id,
          name: dev?.name || n.device_id,
          host: dev?.host || "未配置 IP",
          vendor: dev?.vendor || "generic",
          deviceType: dev?.device_type || "switch",
          displayName: n.display_name,
          labels: n.labels,
          groupName: n.group_id ? groupMap.get(n.group_id) : undefined,
          hasConnection: !!conn,
          connectionStatus: conn?.status,
          lastTestedAt: topologyState?.nodes.find((node) => node.device_id === n.device_id)?.connections[0]?.last_tested_at || conn?.last_tested_at,
          selectedContext: canvasSelection.device_ids.includes(n.device_id),
          dimmed: !!deviceSearch && !`${dev?.name} ${dev?.host}`.toLowerCase().includes(deviceSearch.toLowerCase()),
        },
        selectable: true,
        draggable: true,
        // React Flow's fitView uses its measured node box. Declare the same
        // geometry as the persisted layout contract rather than relying on a
        // CSS-only custom node to be observed after a re-render.
        style: { width: 160, height: 130 },
        zIndex: 1,
      };
    });

    return [...gNodes, ...dNodes];
  }, [activeTopology, byDevice, connections, topologyState, canvasSelection, deviceSearch]);

  // React Flow Edges
  const flowEdges: Edge[] = useMemo(() => {
    if (!activeTopology) return [];
    const nodeMap = new Map(activeTopology.nodes.map((node) => [node.device_id, node]));
    return (activeTopology.links || []).filter((link) => layer === "all" || link.kind === layer).map((l) => ({
      id: l.link_id,
      source: l.source_device_id,
      target: l.target_device_id,
      ...linkHandles(nodeMap.get(l.source_device_id) || { x: 0, y: 0 }, nodeMap.get(l.target_device_id) || { x: 0, y: 0 }),
      type: "topologyEdge",
      data: {
        link_id: l.link_id,
        source_interface: showInterfaces ? l.source_interface : "",
        target_interface: showInterfaces ? l.target_interface : "",
        kind: l.kind,
        label: l.label,
        status: l.status,
        metadata: l.metadata,
        source: l.source,
        evidence_refs: l.evidence_refs,
        selectedContext: canvasSelection.link_ids.includes(l.link_id),
      },
      selectable: true,
    }));
  }, [activeTopology, layer, showInterfaces, canvasSelection]);

  const [nodes, setNodes] = useState<Node[]>(flowNodes);
  const [edges, setEdges] = useState<Edge[]>(flowEdges);

  useEffect(() => {
    setNodes(flowNodes);
  }, [flowNodes]);

  useEffect(() => {
    setEdges(flowEdges);
  }, [flowEdges]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds));
  }, []);

  // Node Drag Stop -> update model
  const onNodeDragStop = useCallback(
    (_: MouseEvent | TouchEvent, node: Node) => {
      if (!activeTopology) return;

      if (node.id.startsWith("group-")) {
        const groupId = (node.data as GroupNodeData).groupId;
        const updatedGroups = activeTopology.groups.map((g) =>
          g.group_id === groupId ? { ...g, x: Math.round(node.position.x), y: Math.round(node.position.y) } : g
        );
        pushState({ ...activeTopology, groups: updatedGroups });
      } else {
        const updatedNodes = activeTopology.nodes.map((n) =>
          n.device_id === node.id ? { ...n, x: Math.round(node.position.x), y: Math.round(node.position.y) } : n
        );
        pushState({ ...activeTopology, nodes: updatedNodes });
      }
    },
    [activeTopology, pushState]
  );

  const openLinkComposer = useCallback(
    (sourceId?: string, targetId?: string) => {
      const availableIds = activeTopology?.nodes.map((node) => node.device_id) || [];
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

  // Connect two nodes
  const onConnect = useCallback(
    (params: FlowConnection) => {
      if (!params.source || !params.target) return;
      if (params.source === params.target) {
        setNotice("不能在同一设备节点建立自环链路", false);
        return;
      }
      openLinkComposer(params.source, params.target);
    },
    [openLinkComposer, setNotice]
  );

  // Save new link from pending connection
  const handleSaveLink = (e: FormEvent) => {
    e.preventDefault();
    if (!activeTopology || !pendingConnection) return;

    const newLink: TopologyLink = {
      link_id: `link-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      source_device_id: pendingConnection.source,
      source_interface: linkForm.source_interface.trim() || "GE0/1",
      target_device_id: pendingConnection.target,
      target_interface: linkForm.target_interface.trim() || "GE0/0",
      kind: linkForm.kind,
      label: linkForm.label.trim() || undefined,
      metadata: {
        speed: linkForm.speed.trim() || undefined,
        vlan: linkForm.vlan.trim() || undefined,
        medium: linkForm.medium.trim() || undefined,
        subnet: linkForm.subnet.trim() || undefined,
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
    async (deviceId: string) => {
      if (!activeTopology) return;
      const dev = byDevice.get(deviceId);
      const devName = dev?.name || deviceId;

      const confirmed = await confirm({
        title: "从拓扑中移除节点",
        body: `将从拓扑“${activeTopology.name}”中移除节点“${devName}”及关联链路。\n工作区的“${devName}”设备实体及管理连接将被完整保留，不受任何影响。`,
        confirmLabel: "从拓扑移除",
        destructive: true,
      });
      if (!confirmed) return;

      const nextNodes = activeTopology.nodes.filter((n) => n.device_id !== deviceId);
      const nextLinks = activeTopology.links.filter(
        (l) => l.source_device_id !== deviceId && l.target_device_id !== deviceId
      );

      pushState({
        ...activeTopology,
        nodes: nextNodes,
        links: nextLinks,
      });
      setSelectedElement(null);
      setNotice(`已从拓扑移除节点“${devName}”，工作区设备实体完整保留`);
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

  // Keyboard delete handler in React Flow
  const onNodesDelete = useCallback(
    (deletedNodes: Node[]) => {
      if (!activeTopology) return;
      let nextNodes = [...activeTopology.nodes];
      let nextLinks = [...activeTopology.links];
      let nextGroups = [...activeTopology.groups];

      for (const node of deletedNodes) {
        if (node.id.startsWith("group-")) {
          const gId = (node.data as GroupNodeData).groupId;
          nextGroups = nextGroups.filter((g) => g.group_id !== gId);
          nextNodes = nextNodes.map((n) => (n.group_id === gId ? { ...n, group_id: undefined } : n));
        } else {
          nextNodes = nextNodes.filter((n) => n.device_id !== node.id);
          nextLinks = nextLinks.filter(
            (l) => l.source_device_id !== node.id && l.target_device_id !== node.id
          );
        }
      }

      pushState({
        ...activeTopology,
        nodes: nextNodes,
        links: nextLinks,
        groups: nextGroups,
      });
      setSelectedElement(null);
      setNotice("已从拓扑移除所选项，设备实体不受影响");
    },
    [activeTopology, pushState, setNotice]
  );

  const onEdgesDelete = useCallback(
    (deletedEdges: Edge[]) => {
      if (!activeTopology) return;
      const edgeIds = new Set(deletedEdges.map((e) => e.id));
      const nextLinks = activeTopology.links.filter((l) => !edgeIds.has(l.link_id));
      pushState({
        ...activeTopology,
        links: nextLinks,
      });
      setSelectedElement(null);
      setNotice("链路已删除");
    },
    [activeTopology, pushState, setNotice]
  );

  // Add device to canvas from palette
  const handleAddDeviceToCanvas = (dev: Device) => {
    if (!activeTopology) return;
    if (activeTopology.nodes.some((n) => n.device_id === dev.device_id)) {
      setNotice(`设备“${dev.name}”已在当前拓扑画布中，禁止重复添加`, false);
      return;
    }

    const nodeCount = activeTopology.nodes.length;
    const col = nodeCount % 4;
    const row = Math.floor(nodeCount / 4);
    const newX = 120 + col * 220;
    const newY = 100 + row * 160;

    const newNode: TopologyNode = {
      device_id: dev.device_id,
      x: newX,
      y: newY,
    };

    pushState({
      ...activeTopology,
      nodes: [...activeTopology.nodes, newNode],
    });
    setNotice(`设备“${dev.name}”已加入画布`);
  };

  const layoutTopologyNodes = useCallback(
    (topology: Topology, nodesToLayout = topology.nodes) => {
      const ordered = [...nodesToLayout].sort((left, right) =>
        (byDevice.get(left.device_id)?.name || left.device_id).localeCompare(
          byDevice.get(right.device_id)?.name || right.device_id,
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
    const existingIds = new Set(activeTopology.nodes.map((node) => node.device_id));
    const additions = devices
      .filter((device) => !existingIds.has(device.device_id))
      .map((device) => ({ device_id: device.device_id, x: 0, y: 0 }));
    if (!additions.length) {
      setNotice("工作区设备已经全部在当前画布中", false);
      return;
    }
    const nodes = layoutTopologyNodes(activeTopology, [...activeTopology.nodes, ...additions]);
    pushState({ ...activeTopology, nodes });
    setNotice(`已加入 ${additions.length} 台设备，并完成网格排布`);
  }, [activeTopology, devices, layoutTopologyNodes, pushState, setNotice]);

  const handleAutoLayout = useCallback(async () => {
    if (!activeTopology || activeTopology.nodes.length < 2) {
      setNotice("至少需要两台画布设备才可自动排布", false);
      return;
    }
    setLayoutBusy(true);
    try {
      const result = await layoutTopology(activeTopology);
      if (activeTopologyRef.current !== activeTopology) { setNotice("图纸已变化，请重新排布", false); return; }
      pushState(result);
      window.setTimeout(() => { void flowRef.current?.fitView({ padding: 0.22, duration: 300, maxZoom: 1.1 }); }, 80);
      setNotice("已按连接关系排布；已有分组随成员调整");
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
      try {
        const res = await apiRequest<{ topology: Topology }>({
          method: "PUT",
          url: `${base}/topologies/${activeTopology.topology_id}`,
          data: {
            workspace_id: workspaceId,
            name: topologyNameInput.trim(),
            description: topologyDescInput.trim(),
            version: activeTopology.version,
            nodes: activeTopology.nodes,
            links: activeTopology.links,
            groups: activeTopology.groups,
          },
        });
        setTopologyModalMode(null);
        setActiveTopology(res.topology);
        await onReload();
        setNotice("拓扑信息已更新");
      } catch (err: unknown) {
        setNotice((err as { message?: string })?.message || "更新拓扑失败", false);
      }
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

  // Node selection inspector helpers
  const selectedNode = useMemo(() => {
    if (selectedElement?.type !== "node" || !activeTopology) return null;
    return activeTopology.nodes.find((n) => n.device_id === selectedElement.deviceId) || null;
  }, [selectedElement, activeTopology]);

  const selectedNodeDevice = useMemo(() => {
    if (!selectedNode) return null;
    return byDevice.get(selectedNode.device_id) || null;
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
    return new Set((activeTopology?.nodes || []).map((n) => n.device_id));
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

  return (
    <div className={`network-topology-workspace topology-studio ${showLibrary ? "library-open" : ""} ${showAgent ? "agent-open" : ""} ${focusMode ? "focus-mode" : ""}`}>
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
                  {t.name} (v{t.version} · {t.nodes.length} 节点)
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
                    onClick={() => { if (isPlaced) { setSelectedElement({ type: "node", deviceId: dev.device_id }); void flowRef.current?.fitView({ nodes: [{ id: dev.device_id }], duration: 300, maxZoom: 1.2 }); } }}
                    onKeyDown={(event) => { if (event.key === "Enter" && isPlaced) { setSelectedElement({ type: "node", deviceId: dev.device_id }); void flowRef.current?.fitView({ nodes: [{ id: dev.device_id }], duration: 300, maxZoom: 1.2 }); } }}
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
                      <span className="palette-badge-placed">已在画布</span>
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
            <span className="topology-version-badge">v{activeTopology?.version}</span>
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
              ) : (
                <>
                  <IconSave size={12} />
                  <span>未保存修改</span>
                </>
              )}
            </div>
          </div>

          <div className="toolbar-right">
            <button className="studio-icon-button" aria-label={focusMode ? "退出专注画布" : "专注画布"} title="专注画布" onClick={() => setFocusMode((value) => !value)}><IconExpand size={18} /></button>
            <Button size="sm" icon={<IconSparkle size={15} />} variant={showAgent ? "primary" : "default"} onClick={() => { setShowAgent((value) => !value); setIsInspectorOpen(false); }}>Agent 协作</Button>
          </div>
        </div>
        <div className="topology-editbar">
          <div className="studio-layer-tabs" role="group" aria-label="拓扑图层">{([ ["all", "全部"], ["physical", "物理连接"], ["logical", "逻辑连接"] ] as const).map(([value, label]) => <button key={value} aria-pressed={layer === value} onClick={() => setLayer(value)}>{label}</button>)}</div>
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
              icon={<IconGrid size={13} />}
              onClick={() => void handleAutoLayout()}
              disabled={layoutBusy || (activeTopology?.nodes?.length || 0) < 2}
            >
              {layoutBusy ? "排布中" : "自动排布"}
            </Button>
            <Button
              size="sm"
              icon={<IconEye size={13} />}
              onClick={handleCompareTopology}
              disabled={comparing}
            >
              {comparing ? "比对中..." : "拓扑比对"}
            </Button>
            <details className="studio-more"><summary>更多</summary><div>
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

        {/* ReactFlow Workspace */}
        <div className="topology-canvas-viewport">
          <div className="studio-canvas-caption"><strong>{activeTopology?.nodes.length || 0} 台设备</strong><span>·</span><span>{activeTopology?.links.length || 0} 条连接</span><label><input type="checkbox" checked={showInterfaces} onChange={(event) => setShowInterfaces(event.target.checked)} />接口标签</label></div>
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
              </div>
            </div>
          )}
          <ReactFlow
            onInit={(instance) => { flowRef.current = instance; }}
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            onNodesDelete={onNodesDelete}
            onEdgesDelete={onEdgesDelete}
            onNodeClick={(_: React.MouseEvent, node: Node) => {
              if (node.id.startsWith("group-")) {
                setSelectedElement({ type: "group", groupId: (node.data as GroupNodeData).groupId });
              } else {
                setSelectedElement({ type: "node", deviceId: node.id });
              }
            }}
            onEdgeClick={(_: React.MouseEvent, edge: Edge) => {
              setSelectedElement({ type: "link", linkId: edge.id });
            }}
            onPaneClick={() => setSelectedElement(null)}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            connectionMode={ConnectionMode.Loose}
            fitView
            fitViewOptions={{ padding: 0.22, maxZoom: 1.1 }}
            snapToGrid
            snapGrid={[10, 10]}
            minZoom={0.2}
            maxZoom={2.5}
            defaultEdgeOptions={{ type: "topologyEdge" }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--line-2)" />
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap
              nodeStrokeColor="var(--line-3)"
              nodeColor="var(--surface-2)"
              nodeBorderRadius={4}
              maskColor="var(--overlay)"
              position="bottom-right"
              className="topology-minimap-custom"
            />
          </ReactFlow>
        </div>
        <footer className="studio-statusbar"><span>{stateError || (topologyState ? `记录同步 ${new Date(topologyState.refreshed_at).toLocaleTimeString("zh-CN", { hour12: false })}` : "正在读取设备记录…")}</span><span>链路颜色：图纸连接 · 管理访问状态见设备详情</span><button onClick={() => void refreshFacts()}><IconRefresh size={12} />刷新状态</button></footer>
      </main>

      {activeTopology && <aside className="studio-agent-dock" aria-hidden={!showAgent}><TopologyAgentPanel key={`${workspaceId}:${activeTopology.topology_id}`} workspaceId={workspaceId} topology={activeTopology} skills={skills} selection={canvasSelection} onCompleted={() => { void refreshFacts(); if (saveStatus === "saved") void onReload(); }} /></aside>}

      {/* 3. Right: Inspector */}
      <aside className={`topology-inspector ${isInspectorOpen ? "is-open" : ""}`} aria-label="拓扑详情">
        {selectedElement?.type === "node" && selectedNode ? (
          <div className="inspector-panel">
            <div className="inspector-header">
              <h4>{selectedNodeDevice?.name || "设备详情"}</h4>
              <Button size="sm" onClick={() => { setSelectedElement(null); setIsInspectorOpen(false); }} aria-label="收起节点详情">
                <IconClose size={13} />
              </Button>
            </div>

            <div className="inspector-section studio-device-status"><span className="inspector-label">管理访问与观察记录</span>{(topologyState?.nodes.find((node) => node.device_id === selectedNode.device_id)?.connections || []).map((connection) => <div key={connection.connection_id}><strong>{connection.protocol.toUpperCase()} : {connection.port}</strong><span>{connection.last_tested_at ? `${connection.verified ? "上次验证成功" : "上次验证未通过"} · ${formatObservedTime(connection.last_tested_at)}` : "尚无连接测试记录"}</span></div>)}<p>最近采集：{formatObservedTime(topologyState?.nodes.find((node) => node.device_id === selectedNode.device_id)?.observation?.observed_at)}</p><Button variant="primary" icon={<IconSparkle size={14} />} onClick={() => { setShowAgent(true); setIsInspectorOpen(false); }}>围绕此设备对话</Button></div>

            <div className="inspector-section">
              <span className="inspector-label">关联设备实体</span>
              <div className="inspector-entity-card">
                <div className="entity-card-row">
                  <strong>{selectedNodeDevice?.name || selectedNode.device_id}</strong>
                  <span
                    className={`vendor-badge vendor-${(selectedNodeDevice?.vendor || "generic").toLowerCase()}`}
                  >
                    {(selectedNodeDevice?.vendor || "generic").toUpperCase()}
                  </span>
                </div>
                <small className="entity-card-meta">
                  IP: {selectedNodeDevice?.host || "未配置"} · 类型: {selectedNodeDevice?.device_type || "switch"}
                </small>
                <div className="entity-card-note">
                  从拓扑中移除仅解除拓扑引用，不会删除此设备实体或连接。
                </div>
              </div>
            </div>

            <div className="inspector-section">
              <label className="inspector-field">
                拓扑显示名称（可选）
                <input
                  value={selectedNode.display_name || ""}
                  placeholder={selectedNodeDevice?.name || "默认设备名"}
                  onChange={(e) => {
                    if (!activeTopology) return;
                    const val = e.target.value;
                    const updated = activeTopology.nodes.map((n) =>
                      n.device_id === selectedNode.device_id ? { ...n, display_name: val || undefined } : n
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
                      n.device_id === selectedNode.device_id ? { ...n, labels: labels.length ? labels : undefined } : n
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
                      n.device_id === selectedNode.device_id ? { ...n, group_id: val } : n
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
                      l.source_device_id === selectedNode.device_id ||
                      l.target_device_id === selectedNode.device_id
                  )
                  .map((l) => {
                    const otherId =
                      l.source_device_id === selectedNode.device_id
                        ? l.target_device_id
                        : l.source_device_id;
                    const otherName = byDevice.get(otherId)?.name || otherId;
                    const isSrc = l.source_device_id === selectedNode.device_id;
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
                onClick={() => handleRemoveNode(selectedNode.device_id)}
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
                  <strong>{byDevice.get(selectedLink.source_device_id)?.name || selectedLink.source_device_id}</strong>
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
                  <strong>{byDevice.get(selectedLink.target_device_id)?.name || selectedLink.target_device_id}</strong>
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
                链路标签（可选）
                <input
                  value={selectedLink.label || ""}
                  placeholder="如：主干 Trunk"
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
                    const val = e.target.value as "as" | "region" | "datacenter" | "tenant";
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
                </select>
              </label>
            </div>

            <div className="inspector-section">
              <span className="inspector-label">属于此分组的节点</span>
              <div className="inspector-group-members">
                {activeTopology?.nodes
                  ?.filter((n) => n.group_id === selectedGroup.group_id)
                  .map((n) => (
                    <div key={n.device_id} className="group-member-item">
                      {byDevice.get(n.device_id)?.name || n.device_id}
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
              <div className="stat-card">
                <span className="stat-num">v{activeTopology?.version}</span>
                <span className="stat-lbl">乐观版本</span>
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
                        ? (activeTopology?.nodes || []).find((node) => node.device_id !== source)?.device_id || ""
                        : pendingConnection.target;
                    if (target) setPendingConnection({ source, target });
                  }}
                >
                  {(activeTopology?.nodes || []).map((node) => (
                    <option key={node.device_id} value={node.device_id}>
                      {byDevice.get(node.device_id)?.name || node.device_id}
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
                    .filter((node) => node.device_id !== pendingConnection.source)
                    .map((node) => (
                      <option key={node.device_id} value={node.device_id}>
                        {byDevice.get(node.device_id)?.name || node.device_id}
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
                链路名称/标识（可选）
                <input
                  placeholder="如：主干 Trunk 1"
                  value={linkForm.label}
                  onChange={(e) => setLinkForm({ ...linkForm, label: e.target.value })}
                />
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
                    setGroupKindInput(e.target.value as "as" | "region" | "datacenter" | "tenant")
                  }
                >
                  <option value="as">自治系统 (AS)</option>
                  <option value="region">区域 (Region)</option>
                  <option value="datacenter">数据中心 (Datacenter)</option>
                  <option value="tenant">业务租户 (Tenant)</option>
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
