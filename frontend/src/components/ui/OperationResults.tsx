import { IconAlert, IconCheck, IconClose } from "../Icon";
import { Button } from "./Button";

export interface OperationResult {
  name: string;
  result?: string;
  error?: string;
}

/**
 * Per-item outcome of a batch (import, recycle, purge). Failures are listed
 * with the server's reason and never collapsed into a single toast, so the
 * user can see exactly which items still need attention.
 */
export function OperationResults({ items, title = "处理结果", onDismiss, busy = false }: {
  items: OperationResult[];
  title?: string;
  onDismiss?: () => void;
  busy?: boolean;
}) {
  if (!items.length) return null;
  const failed = items.filter((item) => item.error).length;
  const done = items.length - failed;
  return (
    <div className={`ui-op-results${failed ? " has-failures" : ""}`} role="status">
      <div className="ui-op-results-head">
        <strong>{title}</strong>
        <span>{busy ? `已处理 ${items.length} 项…` : `${done} 项完成${failed ? `，${failed} 项失败` : ""}`}</span>
        {onDismiss && !busy ? (
          <Button size="sm" variant="ghost" iconOnly aria-label="关闭处理结果" onClick={onDismiss}>
            <IconClose size={14} aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <ul aria-label="逐项处理结果">
        {items.map((item, index) => (
          <li key={index} className={item.error ? "is-error" : "is-ok"}>
            {item.error ? <IconAlert size={14} aria-hidden="true" /> : <IconCheck size={14} aria-hidden="true" />}
            {item.name}：{item.error || item.result}
          </li>
        ))}
      </ul>
    </div>
  );
}
