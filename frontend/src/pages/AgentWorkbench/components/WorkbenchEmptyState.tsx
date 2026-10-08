import { memo } from "react";
import { QUICK_CHIPS } from "../WorkbenchQuickChips";
import { IconChevronRight } from "../../../components/Icon";

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
      <span className="empty-mark" aria-hidden="true">联</span>
      <h2 className="wb-empty-lead">{currentSessionId ? "今天需要处理什么？" : "请先新建会话"}</h2>
      <div className="wb-empty-chips wb-start-cards">
        {QUICK_CHIPS.map((chip, index) => {
          // The first sentence repeats the label; the rest says what the
          // assistant will ask for, which is what helps choosing.
          const hint = chip.prompt.split("。").slice(1).join("。").trim() || chip.prompt;
          const hintId = `wb-empty-chip-hint-${index}`;
          return (
            <div key={chip.label} className="wb-start-card">
              <button
                className="wb-input-chip wb-start-card-btn"
                type="button"
                onClick={() => onPickChip(chip.prompt)}
                title={currentSessionId ? chip.prompt : "请先新建会话"}
                aria-describedby={hintId}
                disabled={!currentSessionId}
              >
                {chip.label}
              </button>
              <span className="wb-start-card-hint" id={hintId}>{hint}</span>
              <IconChevronRight size={14} className="wb-start-card-arrow" aria-hidden="true" />
            </div>
          );
        })}
      </div>
    </div>
  );
});
