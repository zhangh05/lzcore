import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { PortalModal } from "./PortalModal";
import { Button } from "./ui/Button";
import { IconInfo } from "./Icon";

/**
 * In-app replacement for `window.prompt`, built on the same primitives as
 * ConfirmDialog: any component can `promptForm({ ... })` and await the trimmed
 * value, or `null` when the user cancels. The dialog is rendered once at the
 * application root via <FormDialogHost />. PortalModal provides the focus
 * trap, Escape-to-cancel and focus return to the triggering control.
 *
 * Enter submits (Shift+Enter inserts a newline in multi-line fields; Enter
 * while an IME is composing never submits). An empty or whitespace-only value
 * keeps the dialog open with an inline error and resolves nothing.
 */
export interface FormDialogSpec {
  title: string;
  description?: ReactNode;
  label: string;
  placeholder?: string;
  hint?: string;
  initialValue?: string;
  multiline?: boolean;
  /** Message shown when the trimmed value is empty. */
  requiredMessage?: string;
  /** Extra validation on the trimmed value; return an error message to block submit. */
  validate?: (value: string) => string | null;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface FormDialogState extends FormDialogSpec {
  requestId: number;
  resolve: (value: string | null) => void;
}

const listeners = new Set<(state: FormDialogState | null) => void>();
let requestSeq = 0;

function emit(state: FormDialogState | null) {
  for (const listener of listeners) listener(state);
}

export function promptForm(spec: FormDialogSpec): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    emit({ ...spec, requestId: ++requestSeq, resolve });
  });
}

/** Mount once at the app root, next to <ConfirmHost />. Renders nothing when idle. */
export function FormDialogHost() {
  const [state, setState] = useState<FormDialogState | null>(null);
  const stateRef = useRef<FormDialogState | null>(null);

  useEffect(() => {
    const listener = (next: FormDialogState | null) => {
      stateRef.current = next;
      setState(next);
    };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  const close = useCallback((value: string | null) => {
    const current = stateRef.current;
    if (!current) return;
    stateRef.current = null;
    emit(null);
    current.resolve(value);
  }, []);

  if (!state) return null;
  // Keyed by the pending request so each prompt starts with a fresh field.
  return <FormDialogView key={state.requestId} spec={state} onCancel={() => close(null)} onSubmit={(value) => close(value)} />;
}

function FormDialogView({ spec, onCancel, onSubmit }: { spec: FormDialogSpec; onCancel: () => void; onSubmit: (value: string) => void }) {
  const [value, setValue] = useState(spec.initialValue ?? "");
  const [error, setError] = useState("");
  const titleId = useId();
  const descId = useId();
  const fieldId = useId();
  const hintId = useId();
  const errorId = useId();
  const fieldRef = useRef<HTMLTextAreaElement & HTMLInputElement>(null);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = value.trim();
    const message = !trimmed ? (spec.requiredMessage ?? `请填写${spec.label}`) : spec.validate?.(trimmed) ?? "";
    if (message) {
      setError(message);
      fieldRef.current?.focus();
      return;
    }
    onSubmit(trimmed);
  };

  const onFieldKeyDown = (event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    if (!spec.multiline) return; // a single-line input submits through the native form
    event.preventDefault();
    submit();
  };

  const describedBy = [spec.hint ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined;
  const fieldProps = {
    id: fieldId,
    ref: fieldRef,
    className: "form-dialog-control" + (error ? " is-invalid" : ""),
    value,
    placeholder: spec.placeholder,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    "aria-required": true,
    onKeyDown: onFieldKeyDown,
    onChange: (event: { target: { value: string } }) => {
      setValue(event.target.value);
      if (error) setError("");
    },
  };

  return (
    <PortalModal
      open
      onClose={onCancel}
      testId="form-dialog"
      className="confirm-modal form-dialog-modal"
      ariaLabel={spec.title}
      ariaLabelledBy={titleId}
      ariaDescribedBy={spec.description ? descId : undefined}
    >
      <form className="confirm-dialog form-dialog" noValidate onSubmit={submit}>
        <div className="confirm-dialog-main">
          <span className="confirm-dialog-icon" aria-hidden="true"><IconInfo size={20} weight="fill" /></span>
          <div className="confirm-dialog-text">
            <h3 className="confirm-dialog-title" id={titleId}>{spec.title}</h3>
            {spec.description && <div className="confirm-dialog-body" id={descId}>{spec.description}</div>}
          </div>
        </div>
        <div className="form-dialog-field">
          <label className="form-dialog-label" htmlFor={fieldId}>{spec.label}</label>
          {spec.multiline ? <textarea rows={4} {...fieldProps} /> : <input type="text" {...fieldProps} />}
          {spec.hint && !error && <p className="form-dialog-hint" id={hintId}>{spec.hint}</p>}
          {error && <p className="form-dialog-error" id={errorId} role="alert">{error}</p>}
        </div>
        <div className="row-flex-sm confirm-dialog-actions">
          <Button type="button" onClick={onCancel}>{spec.cancelLabel ?? "取消"}</Button>
          <Button type="submit" variant="primary" data-testid="form-dialog-submit">{spec.confirmLabel ?? "确定"}</Button>
        </div>
      </form>
    </PortalModal>
  );
}
