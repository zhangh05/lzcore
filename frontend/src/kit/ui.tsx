/**
 * 页面通用部件：统一页头 / 空态已在 components/EmptyState；这里是表格、tab、对话框、抽屉、
 * 回执提示、失败说明、409 冲突面板、preview|apply 两段式。
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { HttpOutcome } from "../contracts/auth";
import { describeFailure } from "../api/client";
import { Button } from "../components/Button";
import { useSearchParams } from "../router";
import type { Loadable } from "./useApi";
import type { Tone } from "../contracts/outcomeState";

export function Chip({ tone = "neutral", children, testId }: { tone?: Tone | "neutral"; children: ReactNode; testId?: string }) {
  return <span className={`status-chip tone-${tone}`} data-testid={testId}>{children}</span>;
}

export function FailureNote({ outcome, onRetryRead }: { outcome: HttpOutcome; onRetryRead?: () => void }) {
  const unimplemented = outcome.kind === "http" && outcome.status === 501;
  return (
    <p className={`inline-alert ${unimplemented ? "tone-info" : "tone-warn"}`} role="alert" data-testid={unimplemented ? "not-implemented" : "failure-note"}>
      {describeFailure(outcome)}
      {onRetryRead ? <> <button type="button" className="btn ghost" onClick={onRetryRead}>重新读取</button></> : null}
    </p>
  );
}

export function LoadState<T>({ value, onReload, children, empty }: {
  value: Loadable<T>; onReload?: () => void; children: (data: T) => ReactNode; empty?: ReactNode;
}) {
  if (value.state === "idle") return <>{empty ?? null}</>;
  if (value.state === "loading") return <p role="status" className="muted">读取中…</p>;
  if (value.state === "error") return <FailureNote outcome={value.outcome} onRetryRead={onReload} />;
  return <>{children(value.data)}</>;
}

/** tab 进 URL（?tab=）。 */
export function useUrlTab<T extends string>(tabs: readonly T[], fallback: T, param = "tab"): [T, (t: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(param) as T | null;
  const current = raw && tabs.includes(raw) ? raw : fallback;
  const set = (t: T) => {
    const next = new URLSearchParams(params);
    next.set(param, t);
    setParams(next, { replace: true });
  };
  return [current, set];
}

export function Tabs<T extends string>({ tabs, current, onChange, label }: {
  tabs: readonly { key: T; label: string; count?: number }[]; current: T; onChange: (t: T) => void; label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={current === t.key} className={`tab ${current === t.key ? "is-active" : ""}`}
          onClick={() => onChange(t.key)} data-tab={t.key}>
          {t.label}{typeof t.count === "number" ? <span className="tab-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export interface Column<R> {
  key: string;
  label: string;
  render: (row: R) => ReactNode;
  sortValue?: (row: R) => string | number;
}

/** 原生 table：aria-sort、行选择、「N 项已选 · 清除」。 */
export function Table<R>({ rows, columns, rowKey, selectable, selected, onSelect, onRowOpen, empty, testId }: {
  rows: R[]; columns: Column<R>[]; rowKey: (r: R) => string; selectable?: boolean;
  selected?: Set<string>; onSelect?: (s: Set<string>) => void; onRowOpen?: (r: R) => void; empty?: ReactNode; testId?: string;
}) {
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const sorted = [...rows];
  const col = sort ? columns.find((c) => c.key === sort.key) : undefined;
  if (col?.sortValue && sort) sorted.sort((a, b) => (col.sortValue!(a) > col.sortValue!(b) ? 1 : -1) * sort.dir);
  const sel = selected ?? new Set<string>();
  if (rows.length === 0) return <>{empty ?? <p className="muted">没有数据。</p>}</>;
  return (
    <div className="table-wrap">
      {selectable && sel.size > 0 ? (
        <div className="selection-bar" role="status">{sel.size} 项已选 · <button type="button" className="btn ghost" onClick={() => onSelect?.(new Set())}>清除</button></div>
      ) : null}
      <table className="table" data-testid={testId}>
        <thead>
          <tr>
            {selectable ? <th scope="col"><span className="sr-only">选择</span></th> : null}
            {columns.map((c) => (
              <th key={c.key} scope="col" aria-sort={sort?.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
                {c.sortValue ? <button type="button" className="th-sort" onClick={() => setSort((s) => ({ key: c.key, dir: s?.key === c.key && s.dir === 1 ? -1 : 1 }))}>{c.label}</button> : c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const k = rowKey(r);
            return (
              <tr key={k} data-row={k} tabIndex={onRowOpen ? 0 : undefined}
                onKeyDown={(e) => { if (onRowOpen && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onRowOpen(r); } }}
                onClick={onRowOpen ? (e) => { if ((e.target as HTMLElement).closest("button,a,input,label")) return; onRowOpen(r); } : undefined}
                className={onRowOpen ? "is-clickable" : undefined}>
                {selectable ? (
                  <td><input type="checkbox" aria-label={`选择 ${k}`} checked={sel.has(k)} onChange={(e) => {
                    const next = new Set(sel); if (e.target.checked) next.add(k); else next.delete(k); onSelect?.(next);
                  }} /></td>
                ) : null}
                {columns.map((c) => <td key={c.key}>{c.render(r)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function useFocusTrap(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const node = ref.current;
    node?.querySelector<HTMLElement>("input,textarea,select,button,[tabindex='0']")?.focus();
    const onKey = (e: KeyboardEvent) => {
      const modals = document.querySelectorAll('[aria-modal="true"]');
      if (modals[modals.length - 1] !== node) return;
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); }
      if (e.key === "Tab" && node) {
        const items = Array.from(node.querySelectorAll<HTMLElement>("input,textarea,select,button,a[href],[tabindex='0']")).filter((x) => !x.hasAttribute("disabled"));
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, [open]);
  return ref;
}

export function Dialog({ title, children, onClose, footer, testId }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; testId?: string }) {
  const ref = useFocusTrap(true, onClose);
  const id = useId();
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} data-testid={testId}>
        <h2 id={id} className="dialog-title">{title}</h2>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Drawer({ title, children, onClose, testId }: { title: string; children: ReactNode; onClose: () => void; testId?: string }) {
  const ref = useFocusTrap(true, onClose);
  const id = useId();
  return (
    <div className="overlay overlay-drawer" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} data-testid={testId}>
        <header className="drawer-header"><h2 id={id}>{title}</h2><Button variant="ghost" onClick={onClose} aria-label="关闭">关闭</Button></header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

/**
 * 危险确认：两步。可要求后端确认串（例如 `DELETE <job_id>`、`RESOLVE <id>`、`RESTORE`）与依据。
 * details 用来列出将受影响或将重放的内容。
 */
export function ConfirmDialog({ title, details, confirmText, requireReason, confirmLabel = "确认", danger = true, onConfirm, onCancel, testId }: {
  title: string; details: ReactNode; confirmText?: string; requireReason?: boolean; confirmLabel?: string; danger?: boolean;
  onConfirm: (input: { reason: string; confirmation: string }) => void | Promise<void>; onCancel: () => void; testId?: string;
}) {
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = (!confirmText || typed === confirmText) && (!requireReason || reason.trim().length > 0);
  return (
    <Dialog title={title} onClose={onCancel} testId={testId ?? "confirm-dialog"} footer={<>
      <Button onClick={onCancel}>取消</Button>
      <Button variant={danger ? "danger" : "primary"} disabled={!ok || busy} onClick={async () => { setBusy(true); try { await onConfirm({ reason: reason.trim(), confirmation: typed }); } finally { setBusy(false); } }} data-testid="confirm-submit">{confirmLabel}</Button>
    </>}>
      <div className="confirm-details">{details}</div>
      {requireReason ? (
        <label className="field"><span>依据（必填）</span><textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} data-testid="confirm-reason" /></label>
      ) : null}
      {confirmText ? (
        <label className="field"><span>输入 <code>{confirmText}</code> 以确认</span><input value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="confirm-text" autoComplete="off" /></label>
      ) : null}
    </Dialog>
  );
}

/** 409 是一种结果：说明冲突并提供「重新加载最新版本」。 */
export function ConflictPanel({ title, reason, onReload, extra }: { title: string; reason: ReactNode; onReload: () => void; extra?: ReactNode }) {
  return (
    <div className="inline-alert tone-warn conflict-panel" role="alert" data-testid="conflict-panel">
      <strong>{title}</strong>
      <p>{reason}</p>
      {extra}
      <Button onClick={onReload} data-testid="reload-latest">重新加载最新版本</Button>
    </div>
  );
}

/** 受理回执：只写「已提交 / 已入队 / 已请求」，并提示去看终态。 */
export function ReceiptNote({ text, testId }: { text: string; testId?: string }) {
  return <p className="inline-alert tone-info" role="status" data-testid={testId ?? "receipt-note"}>{text}（这是受理回执，不代表已完成；请以刷新后的服务端状态为准。）</p>;
}

/** preview | apply 两段式：没有 preview 结果就不能 apply；apply 需二次确认。 */
export function PreviewApply({ label, preview, apply, renderPreview, confirmText, testId }: {
  label: string; preview: () => Promise<HttpOutcome>; apply: (previewBody: unknown) => Promise<HttpOutcome>;
  renderPreview: (body: unknown) => ReactNode; confirmText?: string; testId?: string;
}) {
  const [p, setP] = useState<HttpOutcome | null>(null);
  const [a, setA] = useState<HttpOutcome | null>(null);
  const [confirming, setConfirming] = useState(false);
  const previewOk = p?.kind === "http" && p.status >= 200 && p.status < 300;
  return (
    <section className="card" data-testid={testId}>
      <h3>{label}</h3>
      <div className="row-actions">
        <Button onClick={async () => { setA(null); setP(await preview()); }} data-testid="preview-btn">预览（不写入）</Button>
        <Button variant="danger" disabled={!previewOk} onClick={() => setConfirming(true)} data-testid="apply-btn">应用</Button>
      </div>
      {!previewOk ? <p className="muted">必须先预览，再应用。</p> : null}
      {p && !previewOk ? <FailureNote outcome={p} /> : null}
      {previewOk ? <div className="preview-body">{renderPreview(p.kind === "http" ? p.body : null)}</div> : null}
      {a ? (a.kind === "http" && a.status < 300 ? <ReceiptNote text="应用请求已提交" /> : <FailureNote outcome={a} />) : null}
      {confirming ? (
        <ConfirmDialog title={`确认应用：${label}`} details={<p>将按刚才的预览结果写入。预览之后数据若有变化，以服务端结果为准。</p>}
          confirmText={confirmText} onCancel={() => setConfirming(false)}
          onConfirm={async () => { setConfirming(false); setA(await apply(p?.kind === "http" ? p.body : null)); }} />
      ) : null}
    </section>
  );
}

export function KeyValues({ items }: { items: [string, ReactNode][] }) {
  return <dl className="kv">{items.map(([k, v]) => <div key={k} className="kv-row"><dt>{k}</dt><dd>{v ?? "—"}</dd></div>)}</dl>;
}

export function JsonBlock({ value }: { value: unknown }) {
  return <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>;
}

export function fmtTime(v?: unknown): string {
  if (!v || typeof v !== "string") return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString("zh-CN", { hour12: false });
}
