/**
 * 页面通用部件：统一页头 / 空态已在 components/EmptyState；这里是表格、tab、对话框、抽屉、
 * 回执提示、失败说明、409 冲突面板、preview|apply 两段式。
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { motionTokens } from "../components/arc/lib/motion-tokens";
import { FIELD_ZH } from "./fieldLabels";
import type { HttpOutcome } from "../contracts/auth";
import { describeFailure } from "../api/client";
import { Button } from "../components/Button";
import { Badge, type BadgeTone } from "../components/arc/badge/badge";
import { Tabs as ArcTabs, TabsList, TabsTrigger } from "../components/arc/tabs/tabs";
import { useSearchParams } from "../router";
import type { Loadable } from "./useApi";
import type { Tone } from "../contracts/outcomeState";

const BADGE_TONE: Record<Tone, BadgeTone> = { neutral: "neutral", ok: "success", warn: "warning", danger: "danger", unknown: "neutral", info: "info" };

/** 状态标签：Arc UI Badge，tone 沿用产品语义（ok / warn / danger / info / unknown）。 */
export function Chip({ tone = "neutral", children, testId }: { tone?: Tone | "neutral"; children: ReactNode; testId?: string }) {
  return <Badge tone={BADGE_TONE[tone]} size="sm" dot={tone !== "neutral" && tone !== "unknown"} data-tone={tone} data-testid={testId}>{children}</Badge>;
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
  if (value.state === "loading") {
    return (
      <div className="load-state" aria-busy="true">
        <div className="skeleton" aria-hidden="true"><span /><span /><span /></div>
        {value.slow
          ? <p role="status" className="shimmer-text" data-testid="load-slow">读取中…后端响应较慢，请求仍在进行。</p>
          : <p role="status" className="shimmer-text">读取中…</p>}
      </div>
    );
  }
  if (value.state === "error") return <FailureNote outcome={value.outcome} onRetryRead={onReload} />;
  return (
    <>
      {value.refreshError ? (
        <p className="inline-alert tone-warn" role="alert" data-testid="stale-data-note">
          重新读取失败，以下是 {value.at ? new Date(value.at).toLocaleTimeString("zh-CN", { hour12: false }) : "此前"} 读取的数据，可能已过期。{describeFailure(value.refreshError)}
          {onReload ? <> <button type="button" className="btn ghost" onClick={onReload}>重新读取</button></> : null}
        </p>
      ) : null}
      {children(value.data)}
    </>
  );
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

/** Sliding active marker shared by tabs and segmented switches (Arc tabs motion: critically damped, no overshoot). */
export function TabIndicator() {
  const reduced = useReducedMotion();
  return <motion.span layoutId="tab-indicator" className="tab-indicator" aria-hidden="true"
    transition={reduced ? { duration: 0 } : motionTokens.spring.smooth} />;
}

/** Wraps one tab set so its indicator animates only between its own tabs. */
export function TabGroup({ children }: { children: ReactNode }) {
  return <LayoutGroup id={useId()}>{children}</LayoutGroup>;
}

/** `line` for a page's primary views; `segmented` for a second level nested under them. */
/** 页签：Arc UI Tabs（滑动高亮、溢出滚动）。只渲染页签条，面板由调用方按 current 渲染。 */
export function Tabs<T extends string>({ tabs, current, onChange, label }: {
  tabs: readonly { key: T; label: string; count?: number }[]; current: T; onChange: (t: T) => void; label: string; variant?: "line" | "segmented";
}) {
  return (
    <ArcTabs value={current} onValueChange={(v) => onChange(v as T)} className="kit-tabs">
      <TabsList aria-label={label}>
        {tabs.map((t) => (
          // Radix 在 mousedown 时切换；补 onClick 让键盘外的程序化点击（含测试）同样生效，重复触发幂等。
          <TabsTrigger key={t.key} value={t.key} data-tab={t.key} onClick={() => { if (t.key !== current) onChange(t.key); }}>
            {t.label}{typeof t.count === "number" ? <span className="tab-count">{t.count}</span> : null}
          </TabsTrigger>
        ))}
      </TabsList>
    </ArcTabs>
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

/**
 * 浮层统一挂到 document.body：遮罩永远全窗，不受触发点所在容器的 max-width / overflow / transform 影响
 * （上一轮工作台输入区 `.wb-composer > *` 的 max-width 把托管文件抽屉压到了中间）。
 */
export function Portal({ children }: { children: ReactNode }) {
  return typeof document === "undefined" ? <>{children}</> : createPortal(children, document.body);
}

export function Dialog({ title, children, onClose, footer, testId, wide }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; testId?: string; wide?: boolean }) {
  const ref = useFocusTrap(true, onClose);
  const id = useId();
  return (
    <Portal><div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`dialog${wide ? " is-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} data-testid={testId}>
        <h2 id={id} className="dialog-title">{title}</h2>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-footer">{footer}</div> : null}
      </div>
    </div></Portal>
  );
}

export function Drawer({ title, children, onClose, testId }: { title: string; children: ReactNode; onClose: () => void; testId?: string }) {
  const ref = useFocusTrap(true, onClose);
  const id = useId();
  return (
    <Portal><div className="overlay overlay-drawer" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} data-testid={testId}>
        <header className="drawer-header"><h2 id={id}>{title}</h2><Button variant="ghost" onClick={onClose} aria-label="关闭">关闭</Button></header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div></Portal>
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
  return <dl className="kv">{items.map(([k, v], i) => <div key={`${k}-${i}`} className="kv-row"><dt>{k}</dt><dd>{v ?? "—"}</dd></div>)}</dl>;
}

export function JsonBlock({ value }: { value: unknown }) {
  return <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>;
}

export function fmtTime(v?: unknown): string {
  if (!v || typeof v !== "string") return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString("zh-CN", { hour12: false });
}

// ── 产品化数据呈现（系统 / 用量等页）：状态、指标、条目在前；完整原始数据折叠在后。 ──
// 交互范式参考 Arc UI 免费组件 metric-card / json-viewer / copy-button 的文档（uiarc.dev），
// 代码为本仓库自写，未复制 Arc 源码。

export function StatusBanner({ tone, title, detail, children, testId }: { tone: Tone | "neutral"; title: ReactNode; detail?: ReactNode; children?: ReactNode; testId?: string }) {
  return (
    <div className={`status-banner tone-${tone}`} role="status" data-testid={testId}>
      <span className={`status-dot tone-${tone}`} aria-hidden="true" />
      <span className="status-banner-title">{title}</span>
      {detail ? <span className="status-banner-detail">{detail}</span> : null}
      <span className="grow" />
      {children}
    </div>
  );
}

export interface MetricItem { label: string; value: ReactNode; context?: ReactNode; tone?: Tone | "neutral" }
export function MetricGrid({ items, testId }: { items: MetricItem[]; testId?: string }) {
  return (
    <dl className="metric-grid" data-testid={testId}>
      {items.map((m) => (
        <div key={m.label} className={`metric tone-${m.tone ?? "neutral"}`}>
          <dt className="metric-label">{m.label}</dt>
          <dd className="metric-value">{m.value}</dd>
          {m.context ? <dd className="metric-context">{m.context}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/** 完整原始响应：默认折叠，可展开、可复制；请求路径只出现在这里。 */
export function RawData({ value, path, label = "原始数据", testId }: { value: unknown; path?: string; label?: string; testId?: string }) {
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const text = JSON.stringify(value, null, 2) ?? "null";
  return (
    <details className="raw-data" data-testid={testId ?? "raw-data"}>
      <summary>
        <span>{label}</span>
        {path ? <span className="raw-data-path">GET {path}</span> : null}
      </summary>
      <div className="raw-data-body">
        <div className="row-actions">
          <Button className="sm" onClick={async () => {
            try { await navigator.clipboard.writeText(text); setCopied("ok"); } catch { setCopied("fail"); }
          }} data-testid="raw-copy">复制 JSON</Button>
          {copied === "ok" ? <span className="muted" role="status">已复制</span> : copied === "fail" ? <span className="muted" role="status">浏览器不允许复制，请手动选择文本</span> : null}
        </div>
        <pre className="json-block">{text}</pre>
      </div>
    </details>
  );
}

const isScalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
export function scalarText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "是" : "否";
  return String(v);
}

/**
 * 通用对象投影：标量 → 键值；字符串数组 → 标签；对象数组 → 表格；嵌套对象 → 小节。
 * 不丢字段：超过深度的部分仍以 JSON 显示；完整原文另由 RawData 提供。
 */
export function ObjectView({ value, labels: own = {}, depth = 0 }: { value: unknown; labels?: Record<string, string>; depth?: number }) {
  const labels: Record<string, string> = depth ? own : { ...FIELD_ZH, ...own };
  if (isScalar(value)) return <span>{scalarText(value)}</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="muted">（空）</span>;
    if (value.every(isScalar)) return <ul className="chip-list">{value.map((x, i) => <li key={i} className="status-chip">{scalarText(x)}</li>)}</ul>;
    if (value.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
      const keys = [...new Set(value.flatMap((x) => Object.keys(x as object)))];
      return (
        <div className="table-wrap"><table className="table">
          <thead><tr>{keys.map((k) => <th key={k} scope="col">{labels[k] ?? k}</th>)}</tr></thead>
          <tbody>{value.map((row, i) => <tr key={i}>{keys.map((k) => {
            const cell = (row as Record<string, unknown>)[k];
            return <td key={k}>{isScalar(cell) || cell === undefined ? scalarText(cell) : <code>{JSON.stringify(cell)}</code>}</td>;
          })}</tr>)}</tbody>
        </table></div>
      );
    }
    return <JsonBlock value={value} />;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return <span className="muted">（空）</span>;
    const flat = entries.filter(([, v]) => isScalar(v) || (Array.isArray(v) && v.every(isScalar)));
    const nested = entries.filter(([, v]) => !(isScalar(v) || (Array.isArray(v) && v.every(isScalar))));
    return (
      <>
        {flat.length ? <KeyValues items={flat.map(([k, v]) => [labels[k] ?? k, <ObjectView key={k} value={v} labels={labels} depth={depth + 1} />])} /> : null}
        {nested.map(([k, v]) => (
          <details key={k} className="section object-fold">
            <summary className="section-title">{labels[k] ?? k} <span className="muted">（{Array.isArray(v) ? `${v.length} 项` : `${Object.keys((v ?? {}) as object).length} 个字段`}，展开查看）</span></summary>
            {depth >= 3 ? <JsonBlock value={v} /> : <ObjectView value={v} labels={labels} depth={depth + 1} />}
          </details>
        ))}
      </>
    );
  }
  return <span className="muted">—</span>;
}

/**
 * 锚定浮层（小动作 / 状态细节）：挂到 body，按触发按钮定位（右对齐，靠底时向上翻），
 * Esc / 点外部 / 滚动 / 缩放关闭并把焦点还给触发按钮。小动作不再用整高抽屉。
 */
export function Popover({ anchor, open, onClose, children, role = "dialog", label, testId, className = "" }: {
  anchor: RefObject<HTMLElement | null>; open: boolean; onClose: () => void; children: ReactNode;
  role?: "dialog" | "menu"; label: string; testId?: string; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const place = useCallback(() => {
    const a = anchor.current?.getBoundingClientRect();
    const el = ref.current;
    if (!a || !el) return;
    const w = el.offsetWidth, h = el.offsetHeight, gap = 4;
    const left = Math.max(8, Math.min(a.right - w, window.innerWidth - w - 8));
    const below = a.bottom + gap;
    const top = below + h > window.innerHeight - 8 && a.top - gap - h > 8 ? a.top - gap - h : below;
    setPos({ top, left });
  }, [anchor]);
  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  // 锚点所在列表可能在菜单打开后重排（列表回读、排序变化）：逐帧跟随锚点位置，避免菜单盖住别的行。
  useEffect(() => {
    if (!open) return;
    let frame = 0, last = "";
    const tick = () => {
      const a = anchor.current?.getBoundingClientRect();
      const key = a ? `${a.top}|${a.right}|${a.bottom}` : "";
      if (key !== last) { last = key; place(); }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [open, anchor, place]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { const t = e.target as Node; if (ref.current?.contains(t) || anchor.current?.contains(t)) return; onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); anchor.current?.focus(); } };
    const onMove = () => place();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); window.removeEventListener("resize", onMove); window.removeEventListener("scroll", onMove, true); };
  }, [open, onClose, anchor, place]);
  if (!open) return null;
  return (
    <Portal>
      <div ref={ref} className={`float-panel ${className}`} role={role} aria-label={label} data-testid={testId}
        style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden", top: 0, left: 0 }}>
        {children}
      </div>
    </Portal>
  );
}

export interface MenuItem { key: string; label: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; testId?: string; hint?: string }

/** 「⋯ / 更多」菜单：role=menu，方向键移动、Enter 选择、Esc 关闭。 */
export function MenuButton({ label, items, children, testId, menuTestId, className = "btn ghost" }: {
  label: string; items: MenuItem[]; children: ReactNode; testId?: string; menuTestId?: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) requestAnimationFrame(() => document.querySelector<HTMLElement>(".float-panel.is-menu [role=menuitem]:not([disabled])")?.focus()); }, [open]);
  const onKey = (e: ReactKeyboardEvent) => {
    const list = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])"));
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    if (e.key === "Tab") setOpen(false);
  };
  return (
    <>
      <button type="button" ref={btn} className={className} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen((o) => !o)} data-testid={testId}>{children}</button>
      <Popover anchor={btn} open={open} onClose={close} role="menu" label={label} testId={menuTestId} className="is-menu">
        <div ref={menuRef} className="menu" onKeyDown={onKey}>
          {items.map((it) => (
            <button key={it.key} type="button" role="menuitem" disabled={it.disabled} title={it.hint} className={it.danger ? "is-danger" : undefined} data-testid={it.testId}
              onClick={() => { setOpen(false); btn.current?.focus(); it.onSelect(); }}>{it.label}</button>
          ))}
        </div>
      </Popover>
    </>
  );
}
