/** TopologyMetadataDialog owns its presentation; document writes stay with the workspace controller. */
import { IconClose } from "../../../../frontend/src/components/Icon";
import { Button } from "../../../../frontend/src/components/ui";

export type TopologyMetadataDialogProps = {
  busy: boolean;
  handleSaveTopologyMeta: (e: import("react").FormEvent) => Promise<void>;
  setTopologyDescInput: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setTopologyModalMode: import("react").Dispatch<
    import("react").SetStateAction<"create" | "edit" | null>
  >;
  setTopologyNameInput: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  topologyDescInput: string;
  topologyModalMode: "create" | "edit";
  topologyNameInput: string;
};

export function TopologyMetadataDialog({
  busy,
  handleSaveTopologyMeta,
  setTopologyDescInput,
  setTopologyModalMode,
  setTopologyNameInput,
  topologyDescInput,
  topologyModalMode,
  topologyNameInput,
}: TopologyMetadataDialogProps) {
  return (
    <dialog
      open
      role="dialog"
      aria-modal="true"
      aria-label={
        topologyModalMode === "create" ? "新建网络拓扑" : "编辑拓扑信息"
      }
      className="network-dialog-modal"
    >
      <form
        onSubmit={handleSaveTopologyMeta}
        className="network-panel modal-panel"
      >
        <div className="modal-header">
          <h3>
            {topologyModalMode === "create" ? "新建网络拓扑" : "编辑拓扑信息"}
          </h3>
          <Button
            size="sm"
            aria-label="关闭拓扑信息"
            onClick={() => setTopologyModalMode(null)}
          >
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
  );
}
