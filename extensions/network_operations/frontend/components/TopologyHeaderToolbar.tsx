/** TopologyHeaderToolbar owns its presentation; document writes stay with the workspace controller. */
import {
  IconAlert,
  IconChat,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconEdit,
  IconEye,
  IconLayers,
  IconRefresh,
  IconSave,
  IconSparkle,
  IconTrash,
} from "../../../../frontend/src/components/Icon";
import { Button } from "../../../../frontend/src/components/ui";
import type { Topology } from "./topologyDocument";

export type TopologyHeaderToolbarProps = {
  activeTopology: Topology;
  activeTopologyRef: import("react").MutableRefObject<Topology | null>;
  executeSave: (topo: Topology) => Promise<void>;
  exportCanvas: (format: "png" | "svg" | "pdf") => Promise<void>;
  handleDeleteTopology: () => Promise<void>;
  handleOpenRevisions: () => Promise<void>;
  handleOpenWorkbenchChat: () => Promise<void>;
  handleSetWorkspaceMode: (mode: "view" | "edit") => void;
  isInspectorOpen: boolean;
  revisionsLoading: boolean;
  saveStatus: "saved" | "saving" | "unsaved" | "conflict";
  setIsInspectorOpen: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setShowAgent: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setShowConflict: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setShowLibrary: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setTopologyDescInput: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setTopologyModalMode: import("react").Dispatch<
    import("react").SetStateAction<"create" | "edit" | null>
  >;
  setTopologyNameInput: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  showAgent: boolean;
  showLibrary: boolean;
  workspaceMode: "edit" | "view";
};

export function TopologyHeaderToolbar({
  activeTopology,
  activeTopologyRef,
  executeSave,
  exportCanvas,
  handleDeleteTopology,
  handleOpenRevisions,
  handleOpenWorkbenchChat,
  handleSetWorkspaceMode,
  isInspectorOpen,
  revisionsLoading,
  saveStatus,
  setIsInspectorOpen,
  setShowAgent,
  setShowConflict,
  setShowLibrary,
  setTopologyDescInput,
  setTopologyModalMode,
  setTopologyNameInput,
  showAgent,
  showLibrary,
  workspaceMode,
}: TopologyHeaderToolbarProps) {
  return (
    <div className="topology-canvas-toolbar">
      <div className="toolbar-left">
        <button
          className="studio-icon-button"
          title="设备库与拓扑列表"
          aria-label="设备库与拓扑列表"
          aria-pressed={showLibrary}
          onClick={() => setShowLibrary((value) => !value)}
        >
          <IconLayers size={18} />
        </button>
        <strong className="topology-canvas-title">
          {activeTopology?.name}
        </strong>
        <Button
          size="sm"
          variant={
            saveStatus === "unsaved"
              ? "primary"
              : saveStatus === "conflict"
                ? "danger"
                : "default"
          }
          icon={
            saveStatus === "saving" ? (
              <IconRefresh size={13} className="spin-icon" />
            ) : saveStatus === "saved" ? (
              <IconCheck size={13} />
            ) : saveStatus === "conflict" ? (
              <IconAlert size={13} />
            ) : (
              <IconSave size={13} />
            )
          }
          disabled={saveStatus === "saved" || saveStatus === "saving"}
          onClick={() => {
            if (saveStatus === "conflict") {
              setShowConflict(true);
            } else if (activeTopologyRef.current && saveStatus !== "saving") {
              void executeSave(activeTopologyRef.current);
            }
          }}
          title={
            saveStatus === "conflict"
              ? "这张图纸被其他人修改过，点击选择如何处理"
              : saveStatus === "unsaved"
                ? "保存图纸 (快捷键 Ctrl+S / Cmd+S)"
                : "图纸所有改动已保存"
          }
          className={`topology-save-btn status-${saveStatus}`}
        >
          {saveStatus === "saving"
            ? "正在保存..."
            : saveStatus === "conflict"
              ? "有冲突待处理"
              : saveStatus === "unsaved"
                ? "保存"
                : "已保存"}
        </Button>
        <div
          className="studio-workspace-mode-switch"
          role="radiogroup"
          aria-label="画布模式"
        >
          <button
            type="button"
            role="radio"
            aria-checked={workspaceMode === "view"}
            className={`mode-pill ${workspaceMode === "view" ? "is-active" : ""}`}
            onClick={() => handleSetWorkspaceMode("view")}
            title="查看模式：方便平移漫游，点击设备、多选、连线均无响应 (快捷键 H)"
          >
            <IconEye size={13} />
            <span>查看模式</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={workspaceMode === "edit"}
            className={`mode-pill ${workspaceMode === "edit" ? "is-active" : ""}`}
            onClick={() => handleSetWorkspaceMode("edit")}
            title="编辑模式：支持设备放置、极速连线、对齐与属性修改 (快捷键 E)"
          >
            <IconEdit size={13} />
            <span>编辑模式</span>
          </button>
        </div>
      </div>

      <div className="toolbar-right">
        <details className="studio-file-menu" data-toolbar-menu>
          <summary>图纸</summary>
          <div>
            <Button
              size="sm"
              icon={<IconClock size={13} />}
              onClick={() => void handleOpenRevisions()}
              disabled={revisionsLoading || !activeTopology}
              title="查看图纸的结构变更历史并按需恢复"
            >
              {revisionsLoading ? "读取中…" : "版本历史"}
            </Button>

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
          </div>
        </details>

        <Button
          size="sm"
          icon={<IconEye size={13} />}
          iconOnly
          aria-label={isInspectorOpen ? "收起详情" : "查看详情"}
          onClick={() => {
            setIsInspectorOpen((open) => !open);
            setShowAgent(false);
          }}
          aria-pressed={isInspectorOpen}
        >
          <span className="tool-action-label">
            {isInspectorOpen ? "收起详情" : "查看详情"}
          </span>
        </Button>
        <div
          className="topology-chat-actions"
          role="group"
          aria-label="图纸对话"
        >
          <Button
            size="sm"
            icon={<IconSparkle size={15} />}
            variant={showAgent ? "selected" : "default"}
            aria-pressed={showAgent}
            onClick={() => {
              setShowAgent((value) => !value);
              setIsInspectorOpen(false);
            }}
          >
            绘图对话
          </Button>
          <details className="studio-chat-menu" data-toolbar-menu>
            <summary aria-label="对话选项" title="对话选项">
              <IconChevronDown size={13} />
            </summary>
            <div>
              <button
                type="button"
                className="studio-mode-button"
                onClick={handleOpenWorkbenchChat}
                title="前往工作台对话，支持大窗口、历史记录与全屏交互"
              >
                <IconChat size={13} />
                <span>工作台对话</span>
              </button>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
