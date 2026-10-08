import type { ReactNode, SelectHTMLAttributes } from "react";
import { IconChevronDown } from "../Icon";

/**
 * Compact filter: the visible label sits inside the control ("范围：全部 ▾")
 * so a toolbar stays one row high. The accessible name is the select's own
 * `aria-label`, which always contains the visible word (label-in-name). The
 * wrapper is deliberately not a <label>: its text would also include every
 * option and leak into label-based lookups for unrelated fields.
 */
export function FilterSelect({ label, children, className = "", ...rest }: Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> & {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`ui-filter-select ${className}`.trim()}>
      <span className="ui-filter-select-label" aria-hidden="true">{label}</span>
      <span className="ui-filter-select-control">
        <select className="ui-filter-select-input" aria-label={rest["aria-label"] ?? label} {...rest}>{children}</select>
        <IconChevronDown size={12} aria-hidden="true" />
      </span>
    </div>
  );
}
