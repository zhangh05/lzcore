import type { ReactNode } from "react";

export type InfoItem = [label: string, value: ReactNode, mono?: boolean];

/** Label/value pairs for detail panels: a quiet label column, values that wrap. */
export function InfoList({ items, className = "" }: { items: Array<InfoItem | false | null | undefined>; className?: string }) {
  return (
    <dl className={`ui-info-list ${className}`.trim()}>
      {items.filter((item): item is InfoItem => Boolean(item)).map(([label, value, mono]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className={mono ? "mono" : undefined}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
