import { useCallback, useEffect, useRef, useState } from "react";
import { IconClose } from "../../../../frontend/src/components/Icon";

export interface NoticeState {
  text: string;
  ok: boolean;
}

export function useNotice(autoDismissMs = 5000) {
  const [notice, setNoticeState] = useState<NoticeState>({ text: "", ok: true });
  const timerRef = useRef<number | null>(null);

  const clearNotice = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setNoticeState({ text: "", ok: true });
  }, []);

  const setNotice = useCallback(
    (text: string, ok = true) => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setNoticeState({ text, ok });
      if (text && autoDismissMs > 0) {
        timerRef.current = window.setTimeout(() => {
          setNoticeState({ text: "", ok: true });
          timerRef.current = null;
        }, autoDismissMs);
      }
    },
    [autoDismissMs]
  );

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return { notice, setNotice, clearNotice };
}

export function NetworkNotice({
  notice,
  onClose,
  role = "status",
}: {
  notice: NoticeState;
  onClose: () => void;
  role?: "status" | "alert";
}) {
  if (!notice.text) return null;
  return (
    <div role={role} className={`network-notice${notice.ok ? " kind-ok" : ""}`}>
      <span className="network-notice-text">{notice.text}</span>
      <button
        type="button"
        className="network-notice-close"
        aria-label="关闭提示"
        title="关闭提示"
        onClick={onClose}
      >
        <IconClose size={13} />
      </button>
    </div>
  );
}
