/** TopologyLinkDialog owns its presentation; document writes stay with the workspace controller. */
import { type FormEvent } from "react";
import { IconClose } from "../../../../frontend/src/components/Icon";
import { Button } from "../../../../frontend/src/components/ui";
import type { Topology } from "./topologyDocument";
import { nextFreeInterface } from "./topologyInterfaceAllocation";
import { useTopologyDialogFocus } from "./useTopologyDialogFocus";

export type TopologyLinkDialogProps = {
  activeTopology: Topology;
  handleSaveLink: (e: FormEvent) => void;
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
  pendingConnection: { source: string; target: string };
  setLinkForm: import("react").Dispatch<
    import("react").SetStateAction<{
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
    }>
  >;
  setPendingConnection: import("react").Dispatch<
    import("react").SetStateAction<{ source: string; target: string } | null>
  >;
};

export function TopologyLinkDialog({
  activeTopology,
  handleSaveLink,
  linkForm,
  pendingConnection,
  setLinkForm,
  setPendingConnection,
}: TopologyLinkDialogProps) {
  const dialogRef = useTopologyDialogFocus<HTMLDialogElement>(() =>
    setPendingConnection(null),
  );
  return (
    <dialog
      ref={dialogRef}
      open
      role="dialog"
      aria-modal="true"
      aria-label="新建拓扑链路"
      className="network-dialog-modal"
    >
      <form onSubmit={handleSaveLink} className="network-panel modal-panel">
        <div className="modal-header">
          <h3>新建拓扑链路</h3>
          <Button
            size="sm"
            aria-label="关闭高级连线"
            onClick={() => setPendingConnection(null)}
          >
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
                    ? (activeTopology?.nodes || []).find(
                        (node) => node.node_id !== source,
                      )?.node_id || ""
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
              onChange={(e) =>
                setLinkForm({ ...linkForm, source_interface: e.target.value })
              }
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
                  target_interface: nextFreeInterface(
                    activeTopology?.links || [],
                    target,
                    0,
                  ),
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
              onChange={(e) =>
                setLinkForm({ ...linkForm, target_interface: e.target.value })
              }
            />
          </label>
          <label>
            链路性质
            <select
              value={linkForm.kind}
              onChange={(e) =>
                setLinkForm({
                  ...linkForm,
                  kind: e.target.value as "physical" | "logical",
                })
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
                setLinkForm({
                  ...linkForm,
                  status: e.target.value as "unknown" | "up" | "down",
                })
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
              onChange={(e) =>
                setLinkForm({ ...linkForm, label: e.target.value })
              }
            />
          </label>
          <label className="check full-field">
            <input
              type="checkbox"
              checked={linkForm.show_description}
              onChange={(e) =>
                setLinkForm({ ...linkForm, show_description: e.target.checked })
              }
            />
            <span>在画布显示这条描述（默认仅在链路详情中保留）</span>
          </label>
          <label>
            速率 (Speed)
            <input
              placeholder="如：10Gbps"
              value={linkForm.speed}
              onChange={(e) =>
                setLinkForm({ ...linkForm, speed: e.target.value })
              }
            />
          </label>
          <label>
            VLAN / 子网
            <input
              placeholder="如：VLAN 100"
              value={linkForm.vlan}
              onChange={(e) =>
                setLinkForm({ ...linkForm, vlan: e.target.value })
              }
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
  );
}
