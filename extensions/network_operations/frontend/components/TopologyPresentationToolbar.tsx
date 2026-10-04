/** TopologyPresentationToolbar owns its presentation; document writes stay with the workspace controller. */
import {
  IconArrowsIn,
  IconChevronLeft,
  IconChevronRight,
  IconEdit,
  IconExpand,
} from "../../../../frontend/src/components/Icon";
import { type CanvasApi } from "./NetOpsCanvas";
import type { Topology } from "./topologyDocument";

export type TopologyPresentationToolbarProps = {
  activeTopology: Topology;
  applyBookmark: (bookmark: {
    name: string;
    x: number;
    y: number;
    zoom: number;
  }) => void;
  bookmarks: { name: string; x: number; y: number; zoom: number }[];
  canvasApiRef: import("react").MutableRefObject<CanvasApi | null>;
  currentBookmarkName: string;
  handleToggleFullscreen: () => void;
  handleToggleWhiteboard: () => void;
  whiteboardActive: boolean;
};

export function TopologyPresentationToolbar({
  activeTopology,
  applyBookmark,
  bookmarks,
  canvasApiRef,
  currentBookmarkName,
  handleToggleFullscreen,
  handleToggleWhiteboard,
  whiteboardActive,
}: TopologyPresentationToolbarProps) {
  return (
    <div
      className="topology-presentation-bar"
      role="toolbar"
      aria-label="全屏演示控制器"
    >
      <div className="presentation-brand">
        <span className="presentation-title">
          {activeTopology?.name || "拓扑演示"}
        </span>
        <span className="presentation-badge">演示模式</span>
      </div>

      {bookmarks.length > 0 && (
        <div className="presentation-view-nav">
          <button
            type="button"
            className="presentation-btn"
            title="上一视图"
            onClick={() => {
              const currentIdx = bookmarks.findIndex(
                (b) => b.name === currentBookmarkName,
              );
              const prevIdx =
                currentIdx <= 0 ? bookmarks.length - 1 : currentIdx - 1;
              applyBookmark(bookmarks[prevIdx]);
            }}
          >
            <IconChevronLeft size={14} />
          </button>
          <select
            className="presentation-view-select"
            value={currentBookmarkName}
            aria-label="切换保存的视图"
            onChange={(e) => {
              const found = bookmarks.find((b) => b.name === e.target.value);
              if (found) {
                applyBookmark(found);
              }
            }}
          >
            <option value="" disabled>
              选择视图 ({bookmarks.length})
            </option>
            {bookmarks.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="presentation-btn"
            title="下一视图"
            onClick={() => {
              const currentIdx = bookmarks.findIndex(
                (b) => b.name === currentBookmarkName,
              );
              const nextIdx = (currentIdx + 1) % bookmarks.length;
              applyBookmark(bookmarks[nextIdx]);
            }}
          >
            <IconChevronRight size={14} />
          </button>
        </div>
      )}

      <div className="presentation-actions">
        <button
          type="button"
          className="presentation-btn"
          onClick={() => canvasApiRef.current?.fit()}
          title="适配画布 (F)"
        >
          <IconExpand size={14} />
          <span>适配</span>
        </button>

        <button
          type="button"
          className={`presentation-btn ${whiteboardActive ? "is-active" : ""}`}
          onClick={handleToggleWhiteboard}
          title="切换画板批注"
        >
          <IconEdit size={14} />
          <span>{whiteboardActive ? "关闭批注" : "画板批注"}</span>
        </button>

        <button
          type="button"
          className="presentation-btn presentation-btn-exit"
          onClick={handleToggleFullscreen}
          title="退出全屏演示 (Esc / F11)"
        >
          <IconArrowsIn size={14} />
          <span>退出</span>
        </button>
      </div>
    </div>
  );
}
