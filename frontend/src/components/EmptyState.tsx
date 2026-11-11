import type { ReactNode } from "react";

/** 空态：icon + 标题 + 一两句原因 + 一个主动作（方案 3.4 / 第 5 节）。 */
export function EmptyState({ icon, title, reason, action, testId }: {
  icon: ReactNode; title: string; reason: ReactNode; action?: ReactNode; testId?: string;
}) {
  return (
    <section className="empty-state" data-testid={testId}>
      <div className="empty-state-icon" aria-hidden="true">{icon}</div>
      <h2 className="empty-state-title">{title}</h2>
      <p className="empty-state-reason">{reason}</p>
      {action ? <div className="empty-state-action">{action}</div> : null}
    </section>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        <h1 className="page-title">{title}</h1>
        {subtitle ? <p className="page-subtitle">{subtitle}</p> : null}
      </div>
      {children ? <div className="page-header-actions">{children}</div> : null}
    </header>
  );
}
