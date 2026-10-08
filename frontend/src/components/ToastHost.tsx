import { createPortal } from "react-dom";
import { useToastStore } from "../stores/toast";
import {
  IconClose,
  IconCheckCircle,
  IconXCircle,
  IconWarningCircle,
  IconInfo,
} from "./Icon";

function getToastIcon(kind: string) {
  switch (kind) {
    case "success":
      return <IconCheckCircle size={18} weight="fill" className="toast-status-icon" />;
    case "error":
      return <IconXCircle size={18} weight="fill" className="toast-status-icon" />;
    case "warning":
      return <IconWarningCircle size={18} weight="fill" className="toast-status-icon" />;
    case "info":
    default:
      return <IconInfo size={18} weight="fill" className="toast-status-icon" />;
  }
}

export function ToastHost() {
  const { messages, dismiss } = useToastStore();
  if (messages.length === 0) return null;
  return createPortal(
    <div
      className="toast-host"
      data-testid="toast-host"
    >
      {messages.map((m) => (
        // Failures interrupt (alert); confirmations wait for a pause (status).
        <div
          key={m.id}
          className={`toast ${m.kind}`}
          role={m.kind === "error" || m.kind === "warning" ? "alert" : "status"}
          aria-live={m.kind === "error" || m.kind === "warning" ? "assertive" : "polite"}
        >
          <div className="toast-icon-wrap" aria-hidden="true">
            {getToastIcon(m.kind)}
          </div>
          <div className="toast-content">
            <div className="toast-title">{m.title}</div>
            {m.body && <div className="toast-body">{m.body}</div>}
            {m.request_id && (
              <div className="toast-req">req_id: {m.request_id}</div>
            )}
          </div>
          <button
            onClick={() => dismiss(m.id)}
            aria-label="关闭通知"
            type="button"
            className="toast-close"
          >
            <IconClose size={12} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
