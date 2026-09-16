export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
};

interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the choice being made, e.g. "检索范围" or "工具分类". */
  ariaLabel: string;
  className?: string;
}

/**
 * A row of mutually exclusive choices: search scope, category filter.
 *
 * Not a tab list. Both call sites used to render plain buttons with an `.active`
 * class and nothing else, so a screen reader could not tell which scope was in
 * effect — the selection was carried by colour alone. This is a radio group, and
 * now says so.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className = "",
}: SegmentedControlProps<T>) {
  return (
    <div className={`segmented ${className}`.trim()} role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={value === option.value ? "active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
