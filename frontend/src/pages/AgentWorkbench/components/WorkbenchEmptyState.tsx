import { memo } from "react";
import { QUICK_CHIPS } from "../WorkbenchQuickChips";

export interface WorkbenchEmptyStateProps {
  currentSessionId: string | null;
  onPickChip: (prompt: string) => void;
}

export const WorkbenchEmptyState = memo(function WorkbenchEmptyState({
  currentSessionId,
  onPickChip,
}: WorkbenchEmptyStateProps) {
  /*
    The empty state's job is to get work started, not to introduce the product.
    It is a lead-in to the composer directly below it: one line of intent, then
    the real starting points. No badge, no title-plus-paragraph block, no
    marketing copy — the composer already carries the input affordance and its
    own guidance line, so repeating it here only pushes the cursor further away.
  */
  return (
    <div className="wb-empty" data-testid="workbench-empty">
      {/* A heading, not a paragraph: the lead line names this block, and screen
          readers navigate by it. It is sized as a question rather than as a
          page title, so the heading role costs no visual weight. */}
      <h2 className="wb-empty-lead">{currentSessionId ? "今天需要处理什么？" : "请先新建会话"}</h2>
      <div className="wb-empty-chips">
        {QUICK_CHIPS.map((chip) => (
          <button
            key={chip.label}
            className="wb-input-chip"
            type="button"
            onClick={() => onPickChip(chip.prompt)}
            title={currentSessionId ? chip.prompt : "请先新建会话"}
            disabled={!currentSessionId}
          >
            {chip.label}
          </button>
        ))}
      </div>
    </div>
  );
});
