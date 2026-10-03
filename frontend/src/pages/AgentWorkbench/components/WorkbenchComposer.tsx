import React, { memo, useEffect, useId, useRef, useState, type ChangeEvent, type DragEvent, type RefObject } from "react";
import type { PendingAttachment } from "../../../hooks/useWorkbenchSend";
import {
  IconAttachment,
  IconClose,
  IconDocument,
  IconLock,
  IconSend,
  IconStop,
  IconChevronDown,
} from "../../../components/Icon";

export interface WorkbenchSkill {
  extension_id: string;
  skill_id: string;
  name: string;
  description: string;
  resources: Array<{ resource_id: string; name: string; description: string; kind: string }>;
  default_resource_ids: string[];
  selection_mode: "single" | "multiple";
}

export interface WorkbenchComposerProps {
  currentSessionId: string | null;
  turnRunning: boolean;
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  attachments: PendingAttachment[];
  onRemoveAttachment: (id: string) => void;
  onPickFile: () => void;
  fileInputRef: RefObject<HTMLInputElement>;
  onFileInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  inputRef: RefObject<HTMLTextAreaElement>;
  workbenchSkills: WorkbenchSkill[];
  selectedSkillKey: string;
  onSelectSkillKey: (key: string) => void;
  selectedSkill: WorkbenchSkill | undefined;
  selectedResourceIds: string[];
  onSelectResourceIds: (updater: (prev: string[]) => string[]) => void;
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
  isSkillLocked?: boolean;
}

export const WorkbenchComposer = memo(function WorkbenchComposer({
  currentSessionId,
  turnRunning,
  input,
  onInputChange,
  onSend,
  onStop,
  attachments,
  onRemoveAttachment,
  onPickFile,
  fileInputRef,
  onFileInputChange,
  inputRef,
  workbenchSkills,
  selectedSkillKey,
  onSelectSkillKey,
  selectedSkill,
  selectedResourceIds,
  onSelectResourceIds,
  onDragOver,
  onDrop,
  isSkillLocked = false,
}: WorkbenchComposerProps) {
  const canSend = Boolean(currentSessionId && (input.trim() || attachments.length > 0));
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [resourceQuery, setResourceQuery] = useState("");
  const resourcePanelId = useId();
  const resourceToggleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setResourcesOpen(false);
    setResourceQuery("");
  }, [currentSessionId, selectedSkillKey]);
  const selectedResources = selectedSkill?.resources.filter((resource) => selectedResourceIds.includes(resource.resource_id)) ?? [];
  const resourceSummary = isSkillLocked
    ? selectedResources.map((resource) => resource.name).join("、") || "已绑定图纸"
    : selectedResources.length > 0 ? `已选 ${selectedResources.length} 个资源` : "选择资源";

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend && !turnRunning) onSend();
    }
  };

  return (
    <div className="wb-input-bar wb-composer-dock" onDragOver={onDragOver} onDrop={onDrop}
      onKeyDown={(event) => {
        if (event.key === "Escape" && resourcesOpen) {
          event.stopPropagation();
          setResourcesOpen(false);
          resourceToggleRef.current?.focus();
        }
      }}>
      {/* 附件托盘 */}
      {attachments.length > 0 ? (
        <div className="wb-attachments">
          {attachments.map((attachment) => (
            <span key={attachment.id} className="tag wb-attachment-tag">
              {attachment.uploading ? (
                <span className="spinner wb-attachment-spinner" />
              ) : attachment.previewUrl ? (
                <img className="wb-attachment-preview" src={attachment.previewUrl} alt="待识别图片" />
              ) : (
                <IconDocument size={14} />
              )}
              <span className="wb-attachment-name" title={attachment.name}>{attachment.name}</span>
              <button
                onClick={() => onRemoveAttachment(attachment.id)}
                className="wb-attachment-remove"
                type="button"
                aria-label={`移除 ${attachment.name}`}
              >
                <IconClose size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/* 核心输入行与操作 */}
      <div className="wb-input-row">
        <div className="wb-input-main">
          <textarea
            ref={inputRef}
            className="wb-input wb-input-content"
            placeholder={currentSessionId ? "输入问题或添加文件" : "请先点击左侧 + 新建会话"}
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!currentSessionId || turnRunning}
            rows={1}
            aria-label="任务描述"
            data-testid="chat-input"
            spellCheck={false}
          />
          <div className="wb-composer-actions">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              disabled={!currentSessionId || turnRunning}
              accept=".txt,.md,.json,.csv,.tsv,.log,.conf,.cfg,.yaml,.yml,.xml,.html,.htm,.pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.gif,.webp"
              onChange={onFileInputChange}
              className="wb-file-input"
            />

            <button
              className="wb-attach-btn"
              onClick={onPickFile}
              disabled={!currentSessionId || turnRunning}
              title={currentSessionId ? "添加文件" : "请先新建会话"}
              aria-label={currentSessionId ? "添加文件" : "请先新建会话"}
              type="button"
            >
              <IconAttachment size={16} aria-hidden="true" />
            </button>

            {turnRunning ? (
              <button
                className="wb-stop"
                onClick={onStop}
                title="停止当前任务"
                aria-label="停止当前任务"
                type="button"
                data-testid="btn-stop"
              >
                <IconStop size={15} weight="fill" aria-hidden="true" />
              </button>
            ) : (
              <button
                className="wb-send"
                onClick={onSend}
                disabled={!canSend}
                data-testid="btn-send"
                type="button"
                aria-label="发送"
                title="Enter 发送"
              >
                <IconSend size={17} />
              </button>
            )}
          </div>
        </div>

        {/* Scope controls stay below the text and action row. */}
        <div className="wb-composer-toolbar">
          {/* Skill 选择栏 */}
          {currentSessionId && (isSkillLocked || workbenchSkills.length > 0) ? (
            <div className={`wb-skill-picker ${isSkillLocked ? "is-locked" : ""}`} data-testid="workbench-skill-picker">
              {isSkillLocked && selectedSkill ? (
                <div
                  className="wb-skill-locked-badge"
                  title="该会话已绑定拓扑图纸，绘图上下文专属固定，不可切换其他 Skill"
                  data-testid="workbench-skill-locked-badge"
                >
                  <IconLock size={12} className="wb-skill-lock-icon" />
                  <span className="wb-skill-lock-label">已绑定：{selectedSkill.name}</span>
                </div>
              ) : (
                <label>
                  <span>Skill</span>
                  <select
                    value={selectedSkillKey}
                    disabled={turnRunning}
                    onChange={(event) => onSelectSkillKey(event.target.value)}
                  >
                    <option value="">通用对话</option>
                    {workbenchSkills.map((skill) => (
                      <option key={`${skill.extension_id}:${skill.skill_id}`} value={`${skill.extension_id}:${skill.skill_id}`}>
                        {skill.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {selectedSkill && selectedSkill.resources.length > 0 ? (
                <button ref={resourceToggleRef} type="button" className="wb-resource-toggle"
                  aria-expanded={resourcesOpen} aria-controls={resourcePanelId}
                  onClick={() => setResourcesOpen((open) => !open)}
                  title={resourceSummary}>
                  <span>{resourceSummary}</span><IconChevronDown size={13} aria-hidden="true" />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {resourcesOpen && selectedSkill ? (
          <section id={resourcePanelId} className="wb-resource-panel" aria-label={isSkillLocked ? "已绑定图纸资源" : "选择 Skill 资源"}>
            <div className="wb-resource-panel-heading">
              <strong>{isSkillLocked ? "会话绑定的图纸" : "本次任务的资源范围"}</strong>
              <span>{isSkillLocked ? "绑定范围不可切换" : selectedSkill.selection_mode === "single" ? "单选" : "多选"}</span>
            </div>
            {selectedSkill.resources.length > 8 && !isSkillLocked ? (
              <input className="input" type="search" aria-label="搜索 Skill 资源" placeholder="按名称查找资源"
                value={resourceQuery} onChange={(event) => setResourceQuery(event.target.value)} />
            ) : null}
            <div className={`wb-skill-devices ${isSkillLocked ? "is-locked" : ""}`}>
              {(isSkillLocked ? selectedResources : selectedSkill.resources.filter((resource) => resource.name.toLocaleLowerCase().includes(resourceQuery.trim().toLocaleLowerCase()))).map((resource) => {
                const active = selectedResourceIds.includes(resource.resource_id);
                return isSkillLocked ? (
                  <span key={resource.resource_id} className="wb-skill-device-chip is-locked" title={resource.description || resource.name}>{resource.name}</span>
                ) : (
                  <button key={resource.resource_id} type="button" className={active ? "active" : ""}
                    aria-pressed={active} title={resource.description} disabled={turnRunning}
                    onClick={() => onSelectResourceIds((items) => items.includes(resource.resource_id)
                      ? items.filter((item) => item !== resource.resource_id)
                      : selectedSkill.selection_mode === "single" ? [resource.resource_id] : [...items, resource.resource_id])}>
                    {resource.name}
                  </button>
                );
              })}
            </div>
            {!isSkillLocked && !selectedSkill.resources.some((resource) => resource.name.toLocaleLowerCase().includes(resourceQuery.trim().toLocaleLowerCase())) ? <p className="wb-resource-empty">没有匹配的资源</p> : null}
          </section>
        ) : null}
      </div>

      <div className="wb-composer-meta">
        <span className="wb-meta-hint">Enter 发送 · Shift + Enter 换行</span>
        <span className="wb-meta-security">
          {turnRunning ? "任务正在运行 · 可随时停止" : attachments.length > 0 ? `已添加 ${attachments.length}/8 个文件` : "操作会经过权限与安全检查"}
        </span>
      </div>
    </div>
  );
});
