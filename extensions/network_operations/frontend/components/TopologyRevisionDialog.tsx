/** TopologyRevisionDialog owns its presentation; document writes stay with the workspace controller. */
import { IconClose } from "../../../../frontend/src/components/Icon";
import { Button } from "../../../../frontend/src/components/ui";
import {
  DIFF_FIELD_LABELS,
  RevisionDiff,
  TopologyRevision,
} from "./topologyRevisionModel";

export type TopologyRevisionDialogProps = {
  diffLoading: boolean;
  handleDiffRevision: (revisionId: string) => Promise<void>;
  handleRestoreRevision: (revisionId: string) => Promise<void>;
  restoreLayout: boolean;
  restoringId: string;
  revisionDiff: RevisionDiff | null;
  revisions: TopologyRevision[];
  revisionsLoading: boolean;
  setRestoreLayout: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setShowRevisions: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
};

export function TopologyRevisionDialog({
  diffLoading,
  handleDiffRevision,
  handleRestoreRevision,
  restoreLayout,
  restoringId,
  revisionDiff,
  revisions,
  revisionsLoading,
  setRestoreLayout,
  setShowRevisions,
}: TopologyRevisionDialogProps) {
  return (
    <dialog
      open
      role="dialog"
      aria-modal="true"
      className="network-dialog-modal compare-modal"
      aria-label="版本历史"
    >
      <div className="network-panel modal-panel compare-panel">
        <div className="modal-header">
          <div>
            <h3>版本历史 · {revisions.length} 个结构版本</h3>
            <p>只记录结构变化；拖动位置、缩放不产生版本</p>
          </div>
          <Button
            aria-label="关闭版本历史"
            onClick={() => setShowRevisions(false)}
          >
            <IconClose size={14} />
          </Button>
        </div>
        <div className="compare-notice-banner">
          恢复会把旧版本写成新版本并先备份当前快照，不会丢失历史；支持完整还原布局几何。
        </div>
        <div style={{ padding: "0 12px 8px 12px" }}>
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "12px",
              cursor: "pointer",
              color: "var(--text)",
            }}
          >
            <input
              type="checkbox"
              checked={restoreLayout}
              onChange={(e) => setRestoreLayout(e.target.checked)}
            />
            <span style={{ fontWeight: 500 }}>
              同时恢复布局坐标（完整几何，推荐）
            </span>
          </label>
        </div>
        <div className="compare-details-area">
          {revisions.map((revision) => (
            <div
              className="compare-item revision-item"
              key={revision.revision_id}
            >
              <span className="compare-status-tag unknown">
                v{revision.version}
              </span>
              <span>
                {new Date(revision.saved_at).toLocaleString("zh-CN", {
                  hour12: false,
                })}
              </span>
              <small>
                {revision.summary.nodes ?? 0} 节点 ·{" "}
                {revision.summary.links ?? 0} 链路 ·{" "}
                {revision.summary.groups ?? 0} 分组 ·{" "}
                {revision.summary.canvas_items ?? 0} 图元
              </small>
              <div className="revision-actions">
                <Button
                  size="sm"
                  onClick={() => void handleDiffRevision(revision.revision_id)}
                >
                  {diffLoading ? "对比中…" : "与当前对比"}
                </Button>
                <Button
                  size="sm"
                  disabled={restoringId === revision.revision_id}
                  onClick={() =>
                    void handleRestoreRevision(revision.revision_id)
                  }
                >
                  {restoringId === revision.revision_id
                    ? "恢复中…"
                    : "恢复到此版本"}
                </Button>
              </div>
            </div>
          ))}
          {!revisions.length && !revisionsLoading && (
            <p>还没有结构变更记录。改动节点、链路或图元后会自动出现版本。</p>
          )}
          {revisionsLoading && <p>读取中…</p>}
        </div>
        {revisionDiff && (
          <div className="revision-diff">
            <h4>
              版本 {revisionDiff.revision_version} → 当前{" "}
              {revisionDiff.current_version} 的差异
            </h4>
            {!revisionDiff.summary.total_changes && (
              <p>与当前图纸一致，没有差异。</p>
            )}
            <ul>
              {revisionDiff.nodes_added.map((item) => (
                <li key={`na-${item.node_id}`} className="diff-add">
                  新增节点 {item.label}
                </li>
              ))}
              {revisionDiff.nodes_removed.map((item) => (
                <li key={`nr-${item.node_id}`} className="diff-remove">
                  删除节点 {item.label}
                </li>
              ))}
              {revisionDiff.nodes_changed.map((item) => (
                <li key={`nc-${item.node_id}`} className="diff-change">
                  节点 {item.label}：
                  {Object.entries(item.changes)
                    .map(
                      ([field, change]) =>
                        `${DIFF_FIELD_LABELS[field] || field} ${change.from || "空"} → ${change.to || "空"}`,
                    )
                    .join("；")}
                </li>
              ))}
              {revisionDiff.links_added.map((item) => (
                <li key={`la-${item.link_id}`} className="diff-add">
                  新增链路 {item.label}
                </li>
              ))}
              {revisionDiff.links_removed.map((item) => (
                <li key={`lr-${item.link_id}`} className="diff-remove">
                  删除链路 {item.label}
                </li>
              ))}
              {revisionDiff.links_changed.map((item) => (
                <li key={`lc-${item.link_id}`} className="diff-change">
                  链路 {item.label}：
                  {Object.entries(item.changes)
                    .map(
                      ([field, change]) =>
                        `${DIFF_FIELD_LABELS[field] || field} ${change.from || "空"} → ${change.to || "空"}`,
                    )
                    .join("；")}
                </li>
              ))}
              {revisionDiff.groups_added.map((group) => (
                <li key={`ga-${group.group_id}`} className="diff-add">
                  新增分组 {group.label}
                </li>
              ))}
              {revisionDiff.groups_removed.map((group) => (
                <li key={`gr-${group.group_id}`} className="diff-remove">
                  删除分组 {group.label}
                </li>
              ))}
              {revisionDiff.canvas_items_added.map((item) => (
                <li key={`ia-${item.item_id}`} className="diff-add">
                  新增图元 {item.label}
                </li>
              ))}
              {revisionDiff.canvas_items_removed.map((item) => (
                <li key={`ir-${item.item_id}`} className="diff-remove">
                  删除图元 {item.label}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="modal-actions">
          <Button onClick={() => setShowRevisions(false)}>关闭</Button>
        </div>
      </div>
    </dialog>
  );
}
