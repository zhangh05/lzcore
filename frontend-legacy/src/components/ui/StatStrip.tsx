import type { ReactNode } from "react";

export interface StatItem {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "success" | "warning" | "danger";
}

/**
 * One row of headline numbers, label above value. Replaces the per-page
 * `.stat-grid` copies on surfaces that adopt the v2 system; the group label
 * names the set for assistive technology, the dl keeps label/value pairs.
 */
export function StatStrip({ items, label, testId, className = "" }: {
  items: StatItem[];
  label: string;
  testId?: string;
  className?: string;
}) {
  return (
    <div className={`ui-stat-strip ${className}`.trim()} role="group" aria-label={label} data-testid={testId}>
      <dl>
        {items.map((item) => (
          <div key={item.label} className={`ui-stat${item.tone && item.tone !== "default" ? ` is-${item.tone}` : ""}`}>
            <dt>{item.label}</dt>
            <dd>
              <span className="ui-stat-value">{item.value}</span>
              {item.hint ? <span className="ui-stat-hint">{item.hint}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
