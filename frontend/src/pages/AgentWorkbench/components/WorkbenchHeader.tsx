import { memo, useState } from "react";
import { saveBlob } from "../../../utils/saveBlob";
import type { ChatMsg } from "../../../stores/workbench";
import { IconChat, IconChevronDown, IconHistory, IconMore, IconSidebarSimple } from "../../../components/Icon";

export interface WorkbenchHeaderProps {
  sessionTitle: string;
  viewMode: "chat" | "timeline";
  onViewModeChange: (mode: "chat" | "timeline") => void;
  headerCollapsed: boolean;
  onToggleHeaderCollapsed: () => void;
  llmHealth: {
    connected: boolean;
    provider?: string;
    model?: string;
    recentFailure?: string;
  };
  currentSessionId: string | null;
  visibleHistory: ChatMsg[];
  taskProgressOpen?: boolean;
  onToggleTaskProgress?: () => void;
}

export const WorkbenchHeader = memo(function WorkbenchHeader({
  sessionTitle,
  viewMode,
  onViewModeChange,
  headerCollapsed,
  onToggleHeaderCollapsed,
  llmHealth,
  currentSessionId,
  visibleHistory,
  taskProgressOpen,
  onToggleTaskProgress,
}: WorkbenchHeaderProps) {
  const llmStatusLabel = llmHealth.connected
    ? llmHealth.recentFailure
      ? "模型可用 · 最近一次请求超时，可重试"
      : `模型可用 · ${llmHealth.model || llmHealth.provider || "在线"}`
    : "模型不可用";

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const handleExport = async () => {
    if (!currentSessionId || visibleHistory.length === 0) return;
    const md = visibleHistory
      .map((m) => `## ${m.role === "user" ? "用户" : "AI"}\n\n${m.text}\n\n---\n`)
      .join("\n");
    const blob = new Blob([md], { type: "text/markdown" });
    setExporting(true); setExportError('');
    try { await saveBlob(blob, `session-${currentSessionId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.md`); }
    catch (error) { setExportError(error instanceof Error ? error.message : '导出失败，请重试'); }
    finally { setExporting(false); }
  };

  return (
    <header className="wb-header" id="workbench-session-header">
      <div className="wb-header-context">
        <h1 title={sessionTitle}>{viewMode === "chat" ? sessionTitle : "完整时间线"}</h1>
        <span className="wb-header-model" title={llmStatusLabel}>
          <span className={"dot " + (llmHealth.connected ? (llmHealth.recentFailure ? "warn" : "ok") : "err")} />
          {llmHealth.connected ? llmHealth.recentFailure ? "模型可用 · 最近请求超时" : llmHealth.model || llmHealth.provider || "模型在线" : "模型不可用"}
        </span>
      </div>
      <div className="wb-header-actions">
        <button
          type="button"
          className="wb-header-collapse"
          aria-label={headerCollapsed ? "展开会话栏" : "收起会话栏"}
          title={headerCollapsed ? "展开会话栏" : "收起会话栏"}
          aria-controls="workbench-session-header"
          aria-expanded={!headerCollapsed}
          onClick={onToggleHeaderCollapsed}
          data-testid="btn-toggle-session-header"
        >
          <IconChevronDown size={14} />
        </button>
        <button
          type="button"
          className={`wb-mode-btn ${viewMode === "chat" ? "active" : ""}`}
          onClick={() => onViewModeChange("chat")}
          aria-label="对话"
          aria-pressed={viewMode === "chat"}
          data-testid="view-chat"
        >
          <IconChat size={15} />
          <span>对话</span>
        </button>
        <button
          type="button"
          className={`wb-mode-btn ${viewMode === "timeline" ? "active" : ""}`}
          onClick={() => onViewModeChange("timeline")}
          aria-label="时间线"
          aria-pressed={viewMode === "timeline"}
          data-testid="view-timeline"
        >
          <IconHistory size={15} />
          <span>时间线</span>
        </button>
        {onToggleTaskProgress ? (
          <button
            type="button"
            className={`wb-mode-btn ${taskProgressOpen ? "active" : ""}`}
            onClick={onToggleTaskProgress}
            aria-label={taskProgressOpen ? "收起任务进度" : "展开任务进度"}
            title={taskProgressOpen ? "收起任务进度" : "展开任务进度"}
            aria-pressed={taskProgressOpen}
            data-testid="btn-toggle-task-progress"
          >
            <IconSidebarSimple size={15} className="is-right" />
            <span>进度</span>
          </button>
        ) : null}
        <details className="wb-session-details" onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.currentTarget.removeAttribute("open");
            event.currentTarget.querySelector("summary")?.focus();
          }
        }}>
          <summary role="button" aria-label="会话信息与导出" title="会话信息与导出"><IconMore size={18} aria-hidden="true" /></summary>
          <div className="wb-session-details-content">
            <strong>会话信息</strong>
            <span className="meta">{currentSessionId || "未创建会话"}</span>
            <span>{llmStatusLabel}</span>
            {currentSessionId && visibleHistory.length > 0 ? (
              <button className="wb-export-btn" title="导出对话" disabled={exporting} onClick={() => { void handleExport(); }}>
                {exporting ? '保存中…' : '导出'}
              </button>
            ) : null}
            {exportError && <span role="alert">{exportError}</span>}
          </div>
        </details>
      </div>
    </header>
  );
});
