import { TOPOLOGY_API_BASE as base } from "./topologyApi";
/** TopologyNodeInspector owns its presentation; document writes stay with the workspace controller. */
import { apiRequest } from "../../../../frontend/src/api/client";
import {
  IconClose,
  IconCopy,
  IconTrash,
  IconUnlock,
} from "../../../../frontend/src/components/Icon";
import { Button } from "../../../../frontend/src/components/ui";
import { Link } from "../../../../frontend/src/router";
import { netOpsIconForDeviceType } from "./netopsCanvasAssets";
import { overlayCaption, type NodeOverlay } from "./nodeOverlay";
import { deviceTypeMap, DRAWING_DEVICE_TYPES } from "./topologyDevicePalette";
import type {
  SelectedElement,
  Topology,
  TopologyNode,
} from "./topologyDocument";

export type TopologyNodeInspectorProps = {
  activeTopology: Topology;
  bindableDevices: { device_id: string; name: string; host: string }[];
  bindChoice: string;
  binding: boolean;
  handleCloneNode: (nodeId: string) => void;
  handleHeaderMouseDown: (e: React.MouseEvent) => void;
  handleJoinZone: (nodeId: string, zoneItemId: string) => void;
  handleLeaveZone: (nodeId: string) => void;
  handleRemoveNode: (nodeId: string) => Promise<void>;
  handleSelectLockGroup: (nodeId: string) => void;
  handleSelectZoneMembers: (nodeId: string) => void;
  handleUnlockNode: (nodeId: string) => void;
  nodeLabelById: Map<string, string>;
  nodeOverlays: NodeOverlay[];
  pinButton: import("react").JSX.Element;
  pushState: (next: Topology) => void;
  savedBindId: string;
  selectedNode: TopologyNode;
  setBindChoice: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setBinding: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setIsInspectorOpen: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setNotice: (notice: string, ok?: boolean) => void;
  setOverlayRevision: import("react").Dispatch<
    import("react").SetStateAction<number>
  >;
  setSelectedElement: import("react").Dispatch<
    import("react").SetStateAction<SelectedElement>
  >;
  workspaceId: string;
};

export function TopologyNodeInspector({
  activeTopology,
  bindableDevices,
  bindChoice,
  binding,
  handleCloneNode,
  handleHeaderMouseDown,
  handleJoinZone,
  handleLeaveZone,
  handleRemoveNode,
  handleSelectLockGroup,
  handleSelectZoneMembers,
  handleUnlockNode,
  nodeLabelById,
  nodeOverlays,
  pinButton,
  pushState,
  savedBindId,
  selectedNode,
  setBindChoice,
  setBinding,
  setIsInspectorOpen,
  setNotice,
  setOverlayRevision,
  setSelectedElement,
  workspaceId,
}: TopologyNodeInspectorProps) {
  return (
    <div className="inspector-panel">
      <div className="inspector-header" onMouseDown={handleHeaderMouseDown}>
        <div className="inspector-header-left">
          <span className="inspector-drag-grip" title="按住拖拽移动弹窗">
            ⋮⋮
          </span>
          <div className="inspector-icon-wrap">
            <img
              src={netOpsIconForDeviceType(
                selectedNode.device_type || "switch",
              )}
              alt=""
              className="inspector-header-icon"
            />
          </div>
          <div className="inspector-header-titles">
            <h4>{selectedNode.display_name || "图纸设备"}</h4>
            <div className="inspector-header-meta">
              <span className="inspector-type-pill">
                {deviceTypeMap.get(selectedNode.device_type || "") ||
                  selectedNode.device_type ||
                  "设备"}
              </span>
              {selectedNode.labels?.length ? (
                <span className="inspector-label-tag">
                  {selectedNode.labels.join(", ")}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="inspector-header-actions">
          {pinButton}
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
                  n.node_id === selectedNode.node_id
                    ? { ...n, device_type: type }
                    : n,
                );
                pushState({ ...activeTopology, nodes: updated });
              }}
            >
              {DRAWING_DEVICE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
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
                  n.node_id === selectedNode.node_id
                    ? { ...n, display_name: val || undefined }
                    : n,
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
                  n.node_id === selectedNode.node_id
                    ? { ...n, labels: labels.length ? labels : undefined }
                    : n,
                );
                pushState({ ...activeTopology, nodes: updated });
              }}
            />
          </label>

          <label className="inspector-field">
            所属区域
            <select
              value={selectedNode.region_id || ""}
              onChange={(e) => {
                if (!activeTopology) return;
                const val = e.target.value || undefined;
                const updated = activeTopology.nodes.map((n) =>
                  n.node_id === selectedNode.node_id
                    ? { ...n, region_id: val || null }
                    : n,
                );
                pushState({ ...activeTopology, nodes: updated });
              }}
            >
              <option value="">未指定区域</option>
              {(activeTopology?.canvas_items || [])
                .filter((item) => item.kind !== "text")
                .map((g) => (
                  <option key={g.item_id} value={g.item_id}>
                    {g.text || g.item_id}
                  </option>
                ))}
            </select>
          </label>

          <div
            className="inspector-field-group"
            style={{
              marginTop: "12px",
              paddingTop: "12px",
              borderTop: "1px dashed var(--line, #e2e8f0)",
            }}
          >
            <span
              className="inspector-label"
              style={{ fontWeight: 600, color: "var(--accent, #2563eb)" }}
            >
              网络规划与设备属性
            </span>

            <label className="inspector-field">
              管理 IP 地址
              <input
                value={selectedNode.ip || ""}
                placeholder="例如 192.168.1.1 或 10.0.0.1/24"
                onChange={(e) => {
                  if (!activeTopology) return;
                  const val = e.target.value;
                  const updated = activeTopology.nodes.map((n) =>
                    n.node_id === selectedNode.node_id
                      ? { ...n, ip: val || undefined }
                      : n,
                  );
                  pushState({ ...activeTopology, nodes: updated });
                }}
              />
            </label>

            <div className="inspector-dimension-grid">
              <label className="inspector-field">
                网络角色 / 层级
                <select
                  value={selectedNode.role || ""}
                  onChange={(e) => {
                    if (!activeTopology) return;
                    const val = e.target.value;
                    const updated = activeTopology.nodes.map((n) =>
                      n.node_id === selectedNode.node_id
                        ? { ...n, role: val || undefined }
                        : n,
                    );
                    pushState({ ...activeTopology, nodes: updated });
                  }}
                >
                  <option value="">未指定角色</option>
                  <option value="core">核心层 (Core)</option>
                  <option value="aggregation">汇聚层 (Aggregation)</option>
                  <option value="access">接入层 (Access)</option>
                  <option value="edge">边界/出口 (Edge)</option>
                  <option value="firewall">安全/防火墙 (Firewall)</option>
                  <option value="spine">Spine</option>
                  <option value="leaf">Leaf</option>
                  <option value="server">服务器 (Server)</option>
                  <option value="terminal">终端/办公 (Terminal)</option>
                  <option value="storage">存储 (Storage)</option>
                  <option value="management">管理网 (OOB/Mgt)</option>
                  <option value="custom">自定义角色</option>
                </select>
              </label>

              <label className="inspector-field">
                设备厂商
                <input
                  value={selectedNode.vendor || ""}
                  placeholder="Cisco / 华为 / 华三等"
                  list="topo-vendor-options"
                  onChange={(e) => {
                    if (!activeTopology) return;
                    const val = e.target.value;
                    const updated = activeTopology.nodes.map((n) =>
                      n.node_id === selectedNode.node_id
                        ? { ...n, vendor: val || undefined }
                        : n,
                    );
                    pushState({ ...activeTopology, nodes: updated });
                  }}
                />
                <datalist id="topo-vendor-options">
                  <option value="Huawei" />
                  <option value="Cisco" />
                  <option value="H3C" />
                  <option value="Ruijie" />
                  <option value="Fortinet" />
                  <option value="Palo Alto" />
                  <option value="Juniper" />
                  <option value="Linux" />
                </datalist>
              </label>
            </div>

            <div className="inspector-dimension-grid">
              <label className="inspector-field">
                设备型号
                <input
                  value={selectedNode.model || ""}
                  placeholder="如 S5720-28X-SI"
                  onChange={(e) => {
                    if (!activeTopology) return;
                    const val = e.target.value;
                    const updated = activeTopology.nodes.map((n) =>
                      n.node_id === selectedNode.node_id
                        ? { ...n, model: val || undefined }
                        : n,
                    );
                    pushState({ ...activeTopology, nodes: updated });
                  }}
                />
              </label>

              <label className="inspector-field">
                业务/管理 VLAN
                <input
                  value={selectedNode.vlan || ""}
                  placeholder="如 VLAN 10, 20"
                  onChange={(e) => {
                    if (!activeTopology) return;
                    const val = e.target.value;
                    const updated = activeTopology.nodes.map((n) =>
                      n.node_id === selectedNode.node_id
                        ? { ...n, vlan: val || undefined }
                        : n,
                    );
                    pushState({ ...activeTopology, nodes: updated });
                  }}
                />
              </label>
            </div>

            <label className="inspector-field">
              物理位置 / 机房机柜
              <input
                value={selectedNode.location || ""}
                placeholder="如 主机房 A01 机柜 4U"
                onChange={(e) => {
                  if (!activeTopology) return;
                  const val = e.target.value;
                  const updated = activeTopology.nodes.map((n) =>
                    n.node_id === selectedNode.node_id
                      ? { ...n, location: val || undefined }
                      : n,
                  );
                  pushState({ ...activeTopology, nodes: updated });
                }}
              />
            </label>
          </div>
        </div>

        <div className="inspector-section">
          <span className="inspector-label">所属区域</span>
          {selectedNode.region_id ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                当前归属：
                <strong>
                  {(activeTopology?.canvas_items || []).find(
                    (ci) => ci.item_id === selectedNode.region_id,
                  )?.text || "未命名区域"}
                </strong>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Button
                  size="sm"
                  onClick={() => handleSelectZoneMembers(selectedNode.node_id)}
                >
                  选中同区设备
                </Button>
                <Button
                  size="sm"
                  onClick={() => handleLeaveZone(selectedNode.node_id)}
                >
                  移出区域
                </Button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <p className="inspector-label" style={{ margin: 0 }}>
                暂未归属区域。多选设备后可直接“编为区域底框”。
              </p>
              {(activeTopology?.canvas_items || []).filter(
                (ci) => ci.kind === "rectangle" || ci.kind === "ellipse",
              ).length > 0 && (
                <select
                  style={{
                    width: "100%",
                    padding: "4px 8px",
                    fontSize: 12,
                    borderRadius: 4,
                    border: "1px solid var(--line)",
                  }}
                  value=""
                  onChange={(e) => {
                    if (e.target.value)
                      handleJoinZone(selectedNode.node_id, e.target.value);
                  }}
                >
                  <option value="">加入已有区域底框...</option>
                  {(activeTopology?.canvas_items || [])
                    .filter(
                      (ci) => ci.kind === "rectangle" || ci.kind === "ellipse",
                    )
                    .map((ci) => (
                      <option key={ci.item_id} value={ci.item_id}>
                        {ci.text || `区域 ${ci.item_id.slice(-4)}`}
                      </option>
                    ))}
                </select>
              )}
            </div>
          )}
        </div>

        <div className="inspector-section">
          <span className="inspector-label">固定联动</span>
          {selectedNode.lock_group ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                已与{" "}
                {
                  (activeTopology?.nodes || []).filter(
                    (n) =>
                      n.lock_group === selectedNode.lock_group &&
                      n.node_id !== selectedNode.node_id,
                  ).length
                }{" "}
                台设备固定联动（拖动任意一台，同组设备沿相同轨迹同步移动）
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Button
                  size="sm"
                  onClick={() => handleSelectLockGroup(selectedNode.node_id)}
                >
                  选中同组设备
                </Button>
                <Button
                  size="sm"
                  icon={<IconUnlock size={13} />}
                  onClick={() => handleUnlockNode(selectedNode.node_id)}
                >
                  解除固定
                </Button>
              </div>
            </div>
          ) : (
            <p className="inspector-label" style={{ margin: 0 }}>
              多选设备后可点击“固定选中设备”，拖动其中一台时其他设备将跟随相同轨迹移动。
            </p>
          )}
        </div>

        <div className="inspector-section">
          <span className="inspector-label">
            登记设备（只读观测，不写入图纸）
          </span>
          {bindableDevices.length === 0 ? (
            <p className="inspector-label">
              还没有登记设备。
              <Link to="/extensions/network.operations/manage?tab=devices">
                去网络设备登记
              </Link>
            </p>
          ) : (
            <label className="inspector-field">
              已登记设备
              <select
                aria-label="绑定登记设备"
                value={bindChoice}
                onChange={(event) => setBindChoice(event.target.value)}
              >
                <option value="">不绑定</option>
                {bindableDevices.map((device) => (
                  <option key={device.device_id} value={device.device_id}>
                    {device.name} · {device.host}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(() => {
            const overlay = nodeOverlays.find(
              (item) => item.node_id === selectedNode.node_id,
            );
            return overlay ? (
              <p className="inspector-label">{overlayCaption(overlay)}</p>
            ) : (
              <p className="inspector-label">
                尚未绑定。绑定后只显示最近测试和最近观测，不表示当前正常。
              </p>
            );
          })()}
          <div className="inspector-actions">
            <Button
              size="sm"
              disabled={
                binding ||
                bindChoice === savedBindId ||
                (bindableDevices.length === 0 && !savedBindId)
              }
              onClick={() => {
                if (!activeTopology || binding) return;
                const deviceId = bindChoice;
                const url = `${base}/topologies/${activeTopology.topology_id}/nodes/${selectedNode.node_id}/binding`;
                const request = deviceId
                  ? apiRequest({
                      method: "PUT",
                      url,
                      data: { workspace_id: workspaceId, device_id: deviceId },
                    })
                  : apiRequest({
                      method: "DELETE",
                      url,
                      data: { workspace_id: workspaceId },
                    });
                setBinding(true);
                void request
                  .then(() => {
                    setOverlayRevision((value) => value + 1);
                    setNotice(
                      deviceId
                        ? "已绑定登记设备。节点第二行是最近记录，不表示当前正常。"
                        : "已解除绑定。",
                    );
                  })
                  .catch(() =>
                    setNotice("绑定失败，请检查设备是否仍存在。", false),
                  )
                  .finally(() => setBinding(false));
              }}
            >
              {bindChoice ? "保存绑定" : "解除绑定"}
            </Button>
          </div>
        </div>

        <div className="inspector-section">
          <span className="inspector-label">关联拓扑链路</span>
          <div className="inspector-link-list">
            {activeTopology?.links
              ?.filter(
                (l) =>
                  l.source_node_id === selectedNode.node_id ||
                  l.target_node_id === selectedNode.node_id,
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
                    onClick={() =>
                      setSelectedElement({ type: "link", linkId: l.link_id })
                    }
                  >
                    <span className={`link-kind-dot ${l.kind}`} />
                    <span>
                      {isSrc ? l.source_interface : l.target_interface} ↔{" "}
                      {otherName} (
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
  );
}
