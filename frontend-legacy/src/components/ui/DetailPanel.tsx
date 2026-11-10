import type { ReactNode } from "react";
import { IconClose } from "../Icon";
import { EmptyState } from "../common";

interface DetailPanelProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  onClose?: () => void;
  empty?: { text: string; hint?: string };
  className?: string;
  /** Heading level for the title. Pages render h1, so the panel defaults to h2. */
  headingLevel?: 2 | 3;
}

export function DetailPanel({
  title,
  subtitle,
  children,
  actions,
  onClose,
  empty,
  className = "",
  headingLevel = 2,
}: DetailPanelProps) {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  if (!children && empty) {
    return (
      <div className={`split-detail ui-detail-empty ${className}`}>
        <EmptyState text={empty.text} hint={empty.hint} />
      </div>
    );
  }

  return (
    <div className={`split-detail ui-detail-panel ${className}`}>
      {(title || actions || onClose) && (
        <div className="ui-detail-panel-head">
          <div>
            {title && <Heading className="ui-detail-panel-title">{title}</Heading>}
            {subtitle && <div className="ui-detail-panel-subtitle">{subtitle}</div>}
          </div>
          <div className="ui-detail-panel-actions">
            {actions}
            {onClose && (
              <button className="btn sm ghost" onClick={onClose} type="button" aria-label="关闭详情">
                <IconClose size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      )}
      <div className="ui-detail-panel-body">{children}</div>
    </div>
  );
}
