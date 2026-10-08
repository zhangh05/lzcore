/** TopologyManualNodeDialog owns its presentation; document writes stay with the workspace controller. */
import { IconClose } from "../../../../frontend/src/components/Icon";
import { Button } from "../../../../frontend/src/components/ui";
import { DRAWING_DEVICE_TYPES } from "./topologyDevicePalette";
import { useTopologyDialogFocus } from "./useTopologyDialogFocus";

export type TopologyManualNodeDialogProps = {
  handleAddManualNode: (event: import("react").FormEvent) => void;
  manualNodeName: string;
  manualNodeType: string;
  setManualNodeName: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setManualNodeType: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setShowManualNodeModal: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
};

export function TopologyManualNodeDialog({
  handleAddManualNode,
  manualNodeName,
  manualNodeType,
  setManualNodeName,
  setManualNodeType,
  setShowManualNodeModal,
}: TopologyManualNodeDialogProps) {
  const dialogRef = useTopologyDialogFocus<HTMLDialogElement>(() =>
    setShowManualNodeModal(false),
  );
  return (
    <dialog
      ref={dialogRef}
      open
      role="dialog"
      aria-modal="true"
      className="network-dialog-modal"
      aria-label="新建图纸设备"
    >
      <form
        onSubmit={handleAddManualNode}
        className="network-panel modal-panel"
      >
        <div className="modal-header">
          <div>
            <h3>新建图纸设备</h3>
            <p>创建独立图纸设备，不关联登记资产。</p>
          </div>
          <Button
            size="sm"
            type="button"
            aria-label="关闭新建图纸设备"
            onClick={() => setShowManualNodeModal(false)}
          >
            <IconClose size={14} />
          </Button>
        </div>
        <div className="form-grid">
          <label className="full-field">
            显示名称
            <input
              required
              autoFocus
              placeholder="如：Internet、核心交换机、第三方系统"
              value={manualNodeName}
              onChange={(event) => setManualNodeName(event.target.value)}
            />
          </label>
          <label className="full-field">
            图标类型
            <select
              value={manualNodeType}
              onChange={(event) => setManualNodeType(event.target.value)}
            >
              {DRAWING_DEVICE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="modal-actions">
          <Button type="button" onClick={() => setShowManualNodeModal(false)}>
            取消
          </Button>
          <Button variant="primary" type="submit">
            放入画布
          </Button>
        </div>
      </form>
    </dialog>
  );
}
