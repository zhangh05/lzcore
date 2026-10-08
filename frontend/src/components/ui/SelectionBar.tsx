import type { ReactNode } from "react";
import { Button } from "./Button";

/**
 * Batch-action bar shown while a list has a selection. It states how many
 * items are selected and what the action will do before the user commits;
 * the destructive step itself still goes through ConfirmDialog.
 */
export function SelectionBar({ count, unit = "项", note, onClear, children, className = "" }: {
  count: number;
  unit?: string;
  note?: ReactNode;
  onClear?: () => void;
  children?: ReactNode;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <div className={`ui-selection-bar ${className}`.trim()} role="group" aria-label="批量操作">
      <span className="ui-selection-count">已选 <b>{count}</b> {unit}</span>
      {note ? <span className="ui-selection-note">{note}</span> : null}
      <span className="ui-selection-actions">
        {onClear ? <Button size="sm" variant="ghost" onClick={onClear}>清除选择</Button> : null}
        {children}
      </span>
    </div>
  );
}
