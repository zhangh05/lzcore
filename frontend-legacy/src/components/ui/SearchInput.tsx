import type { InputHTMLAttributes } from "react";
import { IconClose, IconSearch } from "../Icon";

interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "type"> {
  className?: string;
  /**
   * Shown only when the field has a value. Pass it whenever clearing is
   * meaningful; without it the field renders as a plain search box.
   */
  onClear?: () => void;
  clearLabel?: string;
}

/**
 * The product's search field.
 *
 * Four pages had each grown their own: two hand-built wrappers with different
 * icon sizes, one hand-drawn inline SVG, and one bare input. They looked
 * different, cleared differently, and every new page had to guess which to copy.
 * This is that control, once.
 */
export function SearchInput({ className = "", onClear, clearLabel = "清除搜索", value, ...rest }: SearchInputProps) {
  const hasValue = String(value ?? "").length > 0;
  return (
    <div className={`ui-search ${className}`.trim()}>
      <IconSearch size={14} className="ui-search-icon" aria-hidden="true" />
      <input className="input ui-search-input" type="text" value={value} {...rest} />
      {onClear && hasValue ? (
        <button type="button" className="ui-search-clear" aria-label={clearLabel} onClick={onClear}>
          <IconClose size={12} />
        </button>
      ) : null}
    </div>
  );
}
