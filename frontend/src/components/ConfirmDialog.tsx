import { useEffect, useId, useState, useCallback, useRef, type ReactNode } from "react";
import { PortalModal } from "./PortalModal";
import { Button } from "./ui/Button";
import { IconWarningCircle, IconInfo } from "./Icon";

/**
 * Pre-built confirm dialog state stored in a global ref so any component can
 * `confirm({ title, body, ... })` and get a Promise<boolean> back. The dialog
 * itself is rendered once at the application root via <ConfirmHost />. Replaces
 * the global `window.confirm` calls that used to bypass the React tree (and
 * fail in jsdom / Electron-style contexts).
 */
export interface ConfirmSpec {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface ConfirmState extends ConfirmSpec {
  resolve: (value: boolean) => void;
}

const listeners = new Set<(state: ConfirmState | null) => void>();

function emit(state: ConfirmState | null) {
  for (const listener of listeners) listener(state);
}

export function confirm(spec: ConfirmSpec): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    emit({ ...spec, resolve });
  });
}

/** Mount once at the app root. Renders nothing when no confirm is pending. */
export function ConfirmHost() {
  const [state, setState] = useState<ConfirmState | null>(null);
  const stateRef = useRef<ConfirmState | null>(null);

  useEffect(() => {
    const listener = (next: ConfirmState | null) => {
      stateRef.current = next;
      setState(next);
    };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  const close = useCallback((value: boolean) => {
    const current = stateRef.current;
    if (!current) return;
    stateRef.current = null;
    emit(null);
    current.resolve(value);
  }, []);

  const onClose = useCallback(() => close(false), [close]);
  const titleId = useId();
  const bodyId = useId();

  if (!state) return null;

  return (
    <PortalModal
      open
      onClose={onClose}
      testId="confirm-dialog"
      className="confirm-modal"
      ariaLabel={state.title}
      ariaLabelledBy={titleId}
      ariaDescribedBy={state.body ? bodyId : undefined}
    >
      {/* Focus lands on the first control, which is Cancel: a destructive
          confirmation must never be one stray Enter away from running. */}
      <div className={"confirm-dialog" + (state.destructive ? " is-destructive" : "")}>
        <div className="confirm-dialog-main">
          <span className="confirm-dialog-icon" aria-hidden="true">
            {state.destructive ? <IconWarningCircle size={20} weight="fill" /> : <IconInfo size={20} weight="fill" />}
          </span>
          <div className="confirm-dialog-text">
            <h3 className="confirm-dialog-title" id={titleId}>{state.title}</h3>
            {state.body && <div className="confirm-dialog-body" id={bodyId}>{state.body}</div>}
          </div>
        </div>
        <div className="row-flex-sm confirm-dialog-actions">
          <Button onClick={onClose}>{state.cancelLabel ?? "取消"}</Button>
          <Button
            variant={state.destructive ? "danger-confirm" : "primary"}
            onClick={() => close(true)}
            data-testid="confirm-dialog-confirm"
          >
            {state.confirmLabel ?? "确认"}
          </Button>
        </div>
      </div>
    </PortalModal>
  );
}
