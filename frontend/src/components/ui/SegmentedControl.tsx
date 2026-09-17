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
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          tabIndex={value === option.value || (!options.some((item) => item.value === value) && index === 0) ? 0 : -1}
          className={value === option.value ? "active" : ""}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
              : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
            if (!delta && event.key !== "Home" && event.key !== "End") return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
              : (index + delta + options.length) % options.length;
            const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
            buttons?.[next]?.focus();
            onChange(options[next].value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
