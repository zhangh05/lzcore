/**
 * 表单原语：字段级错误（aria-invalid + aria-describedby）、提示、以及「高级：JSON」模式。
 * 每个实体自己的表单决定字段与校验；这里只负责一致的外观与可访问性，不做泛型 CRUD。
 */
import { useId, useState, type ReactNode } from "react";
import { Button } from "../components/Button";

export type FieldErrors<K extends string = string> = Partial<Record<K | "_form", string>>;

export function Field({ label, error, hint, required, children, full }: { label: string; error?: string; hint?: ReactNode; required?: boolean; full?: boolean; children: (a11y: { id: string; "aria-invalid"?: true; "aria-describedby"?: string }) => ReactNode }) {
  const id = useId();
  const errId = `${id}-err`, hintId = `${id}-hint`;
  const describedBy = [error ? errId : "", hint ? hintId : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`form-field${error ? " has-error" : ""}${full ? " is-full" : ""}`}>
      <label htmlFor={id}>{label}{required ? <span className="req" aria-hidden="true"> *</span> : null}</label>
      {children({ id, ...(error ? { "aria-invalid": true as const } : {}), "aria-describedby": describedBy })}
      {hint ? <p className="form-hint" id={hintId}>{hint}</p> : null}
      {error ? <p className="form-error" id={errId} role="alert" data-testid="field-error">{error}</p> : null}
    </div>
  );
}

export function FormError({ text }: { text?: string }) {
  return text ? <p className="inline-alert tone-danger" role="alert" data-testid="form-error">{text}</p> : null;
}

/**
 * 「表单 / 高级：JSON」切换。切到 JSON 时用 toJson() 生成当前请求体；切回表单时用 fromJson() 回填字段，
 * JSON 不合法时留在 JSON 模式并提示，不丢输入。敏感字段由调用方决定不放进 JSON。
 */
export function useAdvancedJson<T>(toJson: () => Record<string, unknown>, fromJson: (v: Record<string, unknown>) => T | string) {
  const [mode, setMode] = useState<"form" | "json">("form");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const toggle = () => {
    if (mode === "form") { setText(JSON.stringify(toJson(), null, 2)); setError(null); setMode("json"); return; }
    const parsed = parseJsonObject(text);
    if (typeof parsed === "string") { setError(parsed); return; }
    const r = fromJson(parsed);
    if (typeof r === "string") { setError(r); return; }
    setError(null); setMode("form");
  };
  return { mode, text, setText, error, setError, toggle };
}

export function parseJsonObject(text: string): Record<string, unknown> | string {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : "JSON 顶层必须是对象 {…}";
  } catch (e) { return `JSON 格式不正确：${(e as Error).message}`; }
}

export function AdvancedJsonPanel({ text, onChange, error, note }: { text: string; onChange: (t: string) => void; error: string | null; note?: ReactNode }) {
  return (
    <div className="advanced-json" data-testid="advanced-json">
      {note ? <p className="form-hint">{note}</p> : null}
      <textarea className="code-input" rows={14} value={text} onChange={(e) => onChange(e.target.value)} aria-label="高级：JSON 请求体" spellCheck={false} />
      {error ? <p className="form-error" role="alert" data-testid="json-error">{error}</p> : null}
    </div>
  );
}

export function ModeToggle({ mode, onToggle }: { mode: "form" | "json"; onToggle: () => void }) {
  return <Button variant="ghost" className="sm" onClick={onToggle} data-testid="toggle-json">{mode === "form" ? "高级：JSON" : "返回表单"}</Button>;
}
