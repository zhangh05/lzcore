/** TopologyConflictDialog owns its presentation; document writes stay with the workspace controller. */
import { IconClose } from "../../../../frontend/src/components/Icon";
import { Button } from "../../../../frontend/src/components/ui";
import type { Topology } from "./topologyDocument";
import { describeMergeValue, DIFF_FIELD_LABELS } from "./topologyRevisionModel";

export type TopologyConflictDialogProps = {
  applyConflictChoice: (choice: "merged" | "theirs" | "mine") => void;
  conflict: {
    base: Topology;
    mine: Topology;
    theirs: Topology;
    merged: Topology;
    conflicts: import("./topologyMerge").MergeConflict[];
    stats: import("./topologyMerge").MergeStats;
  };
  nodeLabelById: Map<string, string>;
  setShowConflict: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
};

export function TopologyConflictDialog({
  applyConflictChoice,
  conflict,
  nodeLabelById,
  setShowConflict,
}: TopologyConflictDialogProps) {
  return (
    <dialog
      open
      role="dialog"
      aria-modal="true"
      className="network-dialog-modal compare-modal"
      aria-label="编辑冲突"
    >
      <div className="network-panel modal-panel compare-panel">
        <div className="modal-header">
          <div>
            <h3>这张图纸被其他人修改过</h3>
            <p>
              你编辑的是版本 {conflict.base.version} 的图纸，服务端已是版本{" "}
              {conflict.theirs.version}
            </p>
          </div>
          <Button
            aria-label="关闭冲突处理"
            onClick={() => setShowConflict(false)}
          >
            <IconClose size={14} />
          </Button>
        </div>
        <div className="compare-notice-banner">
          系统已按对象 id
          做了三方合并：双方各自新增或修改、对方没动的部分都会保留；
          同一字段双方都改了、或删除与编辑撞在一起时，保留服务端值并列在下面，请人工确认。
        </div>
        <div className="compare-metrics-row">
          <div className="metric-box">
            <span className="metric-val">{conflict.stats.autoMerged}</span>
            <span className="metric-lbl">自动合并</span>
          </div>
          <div className="metric-box">
            <span className="metric-val">{conflict.stats.added}</span>
            <span className="metric-lbl">新增对象</span>
          </div>
          <div className="metric-box">
            <span className="metric-val">{conflict.stats.removed}</span>
            <span className="metric-lbl">删除对象</span>
          </div>
          <div className="metric-box">
            <span className="metric-val">{conflict.conflicts.length}</span>
            <span className="metric-lbl">需人工确认</span>
          </div>
        </div>
        {conflict.stats.orphanedLinks > 0 && (
          <p className="conflict-note">
            另有 {conflict.stats.orphanedLinks}{" "}
            条链路的端点已不存在，合并时一并移除（服务端不接受悬空链路）。
          </p>
        )}
        <div className="compare-details-area">
          {conflict.conflicts.slice(0, 12).map((item, index) => (
            <div
              className="compare-item"
              key={`conflict-${item.collection}-${item.id}-${item.field}-${index}`}
            >
              <span className="compare-status-tag warn">需确认</span>
              <span>
                {item.collection} {nodeLabelById.get(item.id) || item.id} ·{" "}
                {DIFF_FIELD_LABELS[item.field] || item.field}
              </span>
              <small>
                {item.field === "删除"
                  ? "一方删除、另一方编辑；已按删除处理"
                  : `保留服务端值 ${describeMergeValue(item.theirs)}`}
              </small>
            </div>
          ))}
          {conflict.conflicts.length > 12 && (
            <p>还有 {conflict.conflicts.length - 12} 处未列出。</p>
          )}
          {!conflict.conflicts.length && <p>没有需要人工确认的冲突。</p>}
        </div>
        <div className="modal-actions">
          <Button
            variant="primary"
            onClick={() => applyConflictChoice("merged")}
          >
            合并双方改动并保存
          </Button>
          <Button onClick={() => applyConflictChoice("theirs")}>
            用服务端版本（放弃我的改动）
          </Button>
          <Button onClick={() => applyConflictChoice("mine")}>
            保留我的（覆盖对方）
          </Button>
          <Button onClick={() => setShowConflict(false)}>稍后处理</Button>
        </div>
      </div>
    </dialog>
  );
}
