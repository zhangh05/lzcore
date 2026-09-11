import { useState } from "react";
import type { AgentResult, InlineToolCall } from "../../../types";
import { IconCheck, IconAlert, IconChevronDown, IconChevronRight, IconClock, IconDocument } from "../../../components/Icon";
import {
  UNKNOWN_OUTCOME_COPY,
  deriveInlineCardState,
  unresolvedUnknownOutcome,
  unknownOutcomeParagraph,
} from "../../../components/toolCallState";

interface InlineToolCallCardProps {
  toolCall: InlineToolCall;
  seq: number;
  /**
   * 本回合的 `AgentResult`。
   *
   * 为什么传整个 result 而不是 `metadata.unknown_outcome`：
   * 「写入结果未知」是否成立由**回合级**投影 `execution_outcome` 决定，
   * 触发事实只回答「是哪一次调用」。只传指针就无从判断这次不确定
   * 是否已经被后续 read-back 关闭，会把已确认的写入重新渲染成不确定。
   *
   * 可选参数：不传时行为与改造前完全一致（三态），因此既有调用方无需改动。
   */
  turnResult?: Pick<AgentResult, "metadata"> | null;
}

export function InlineToolCallCard({ toolCall, seq, turnResult }: InlineToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const state = deriveInlineCardState(toolCall, turnResult);
  const pending = state === "pending";
  const unknown = state === "unknown";
  const succeeded = state === "ok";
  /** 只有确实处于未知态时才取事实，避免在成功/失败态渲染出误导性字段。 */
  const unknownFact = unknown ? unresolvedUnknownOutcome(turnResult) : undefined;
  const errText = toolCall.errors?.join(", ");
  const orchestration = toolCall.orchestration;
  const orchestrationStep = typeof orchestration?.step_id === "string" ? orchestration.step_id : "";
  const orchestrationLayer = typeof orchestration?.layer === "number" && Number.isFinite(orchestration.layer)
    ? orchestration.layer
    : null;
  const orchestrationDependsOn = Array.isArray(orchestration?.depends_on)
    ? orchestration.depends_on.filter((item): item is string => typeof item === "string")
    : [];

  return (
    <div
      className={`tool-call-card ${state}${open ? " is-open" : ""}`}
      onClick={() => setOpen(!open)}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen(!open);
        }
      }}
    >
      <div className="tool-call-card-header">
        <span className="tc-seq">#{seq}</span>
        <span className={`tc-icon ${state}`}>
          {succeeded ? <IconCheck size={13} weight="bold" /> : <IconAlert size={13} weight="bold" />}
        </span>
        <span className="tc-name">{toolCall.tool_name || toolCall.tool_id}</span>
        {pending && <span className="tc-state">已提交，等待设备结果</span>}
        {unknown && <span className="tc-state tc-state-unknown">{UNKNOWN_OUTCOME_COPY.pill}</span>}
        {toolCall.duration_ms != null && (
          <span className="tc-duration-pill">
            <IconClock size={11} />
            {(toolCall.duration_ms / 1000).toFixed(1)}s
          </span>
        )}
        <span className="tc-chev">
          {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
        </span>
      </div>
      {open && (
        <div className="tool-call-card-body">
          {toolCall.summary && <div className="tc-summary">{toolCall.summary}</div>}
          {errText && <div className="tc-error">{errText}</div>}
          {toolCall.duration_ms != null && (
            <div className="tc-duration">{(toolCall.duration_ms / 1000).toFixed(1)}s</div>
          )}
          {/* 「写入结果未知」的解释。措辞与 ResultInline 的回合级告警同源，
              区别只在这里定位到具体某一次调用。 */}
          {unknown && (
            <div className="tc-unknown" role="note">
              <strong>{UNKNOWN_OUTCOME_COPY.headline}</strong>
              <p>{unknownOutcomeParagraph()}</p>
              <div className="tc-unknown-facts">
                <span>工具：{unknownFact?.tool_id || toolCall.tool_id}</span>
                {(unknownFact?.call_id || toolCall.call_id) && (
                  <span>调用：{unknownFact?.call_id || toolCall.call_id}</span>
                )}
                {unknownFact?.error_code && <span>代码：{unknownFact.error_code}</span>}
              </div>
            </div>
          )}
          {orchestrationStep && (
            <div className="tc-orchestration">
              <span>步骤：{orchestrationStep}</span>
              {orchestrationLayer != null && <span>第 {orchestrationLayer} 组</span>}
              {orchestration?.parallel === true && <span>并行执行</span>}
              {orchestrationDependsOn.length ? (
                <span>依赖：{orchestrationDependsOn.join("、")}</span>
              ) : null}
            </div>
          )}
          {toolCall.artifacts && toolCall.artifacts.length > 0 && (
            <div className="tc-artifacts">
              {toolCall.artifacts.map((a) => (
                <span key={a.artifact_id} className="tc-artifact-tag">
                  <IconDocument size={12} /> {a.title || a.artifact_id}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
