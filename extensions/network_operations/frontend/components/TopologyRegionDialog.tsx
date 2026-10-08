/** TopologyRegionDialog owns its presentation; document writes stay with the workspace controller. */
import { IconClose } from "../../../../frontend/src/components/Icon";
import { Button } from "../../../../frontend/src/components/ui";
import type { Topology } from "./topologyDocument";
import { ZONE_COLOR_PRESETS } from "./topologyDocument";

export type TopologyRegionDialogProps = {
  activeTopology: Topology;
  canvasSelectedElementIds: string[];
  handleConfirmCreateZone: (e?: React.FormEvent) => void;
  setShowCreateZoneModal: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setZoneColorIndex: import("react").Dispatch<
    import("react").SetStateAction<number>
  >;
  setZoneNameInput: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  zoneColorIndex: number;
  zoneNameInput: string;
};

export function TopologyRegionDialog({
  activeTopology,
  canvasSelectedElementIds,
  handleConfirmCreateZone,
  setShowCreateZoneModal,
  setZoneColorIndex,
  setZoneNameInput,
  zoneColorIndex,
  zoneNameInput,
}: TopologyRegionDialogProps) {
  return (
    <dialog
      open
      role="dialog"
      aria-modal="true"
      className="network-dialog-modal"
      aria-label="新建智能区域底框"
    >
      <form
        onSubmit={handleConfirmCreateZone}
        className="network-panel modal-panel"
      >
        <div className="modal-header">
          <div>
            <h3>新建智能区域底框</h3>
            <p>
              基于所选设备的外接矩形与呼吸留白，自动生成严丝合缝的自适应底框。
            </p>
          </div>
          <Button
            size="sm"
            type="button"
            aria-label="关闭新建区域"
            onClick={() => setShowCreateZoneModal(false)}
          >
            <IconClose size={14} />
          </Button>
        </div>
        <div className="form-grid">
          <label className="full-field">
            区域名称
            <input
              required
              autoFocus
              placeholder="如：核心骨干区、DMZ安全区、接入汇聚区"
              value={zoneNameInput}
              onChange={(e) => setZoneNameInput(e.target.value)}
            />
          </label>
          <div className="full-field">
            <span
              className="inspector-label"
              style={{ marginBottom: 6, display: "block" }}
            >
              区域配色风格
            </span>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 8,
              }}
            >
              {ZONE_COLOR_PRESETS.map((preset, idx) => (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => setZoneColorIndex(idx)}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 6,
                    border:
                      zoneColorIndex === idx
                        ? `2px solid ${preset.color}`
                        : `1px solid ${preset.border}`,
                    background: preset.fill,
                    color: preset.color,
                    fontWeight: zoneColorIndex === idx ? 600 : 400,
                    fontSize: 12,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: preset.border,
                      border: `1px solid ${preset.color}`,
                    }}
                  />
                  <span>{preset.name}</span>
                </button>
              ))}
            </div>
          </div>
          <div
            className="full-field"
            style={{
              fontSize: 12,
              color: "var(--text-3)",
              background: "var(--surface-2, #f8fafc)",
              padding: "8px 12px",
              borderRadius: 6,
            }}
          >
            💡 提示：系统将根据已选中的{" "}
            {activeTopology?.nodes.filter((n) =>
              canvasSelectedElementIds.includes(n.node_id),
            ).length || 0}{" "}
            台设备位置，自动生成带标题的半透明彩色底框。后续在属性面板中随时可一键【自适应贴合】重新自适应包裹。
          </div>
        </div>
        <div className="modal-actions">
          <Button type="button" onClick={() => setShowCreateZoneModal(false)}>
            取消
          </Button>
          <Button variant="primary" type="submit">
            生成区域底框
          </Button>
        </div>
      </form>
    </dialog>
  );
}
