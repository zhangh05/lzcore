import { useMemo, useState } from "react";
import { api, enc } from "../api/client";
import { useShell } from "../app/shellContext";
import { Button } from "../components/Button";
import { IconCheckCircle } from "../components/Icon";
import { Alert } from "../components/arc/alert/alert";
import { Dialog, DialogContent } from "../components/arc/dialog/dialog";
import { EmptyState } from "../components/arc/empty-state/empty-state";
import { Input } from "../components/arc/input/input";
import { SearchField } from "../components/arc/search-field/search-field";
import SegmentedControl from "../components/arc/segmented-control/segmented-control";
import { SortableDataTable, type DataColumn } from "../components/arc/sortable-data-table/sortable-data-table";
import { Textarea } from "../components/arc/textarea/textarea";
import { INBOX_SOURCE_LABEL, type InboxEntry, type InboxSource } from "../contracts/reviewInbox";
import { Chip, fmtTime } from "../kit/ui";
import { Link } from "../router";

type Filter = "all" | InboxSource;
type Resolution = "succeeded" | "failed";
type Row = { key: string; title: string; status: string; source: string; updated: string; entry: InboxEntry };
type RunState = { phase: "running"; done: number; total: number } | { phase: "done"; ok: number; failed: { title: string; reason: string }[]; skipped: number };

const RESOLUTION_LABEL: Record<Resolution, string> = { succeeded: "已生效", failed: "未生效" };
/** 任务没有单独的标记接口（需在会话里核对后续接），批量标记只覆盖写操作与审阅项。 */
const markable = (e: InboxEntry) => e.markable === true;

async function markOne(e: InboxEntry, resolution: Resolution, reason: string, ws: string): Promise<string | null> {
  const o = e.source === "ledger"
    ? await api.post(`/api/admin/operation-ledger/${enc(e.id)}/resolve`, { workspace_id: ws, confirmation: `RESOLVE ${e.id}`, status: resolution, reason })
    : await api.put(`/api/review-items/${enc(e.id)}`, { status: resolution === "succeeded" ? "accepted" : "modified", user_note: reason }, { workspace_id: ws, artifact_id: e.artifactId ?? "" });
  if (o.kind === "http" && o.status < 300) return null;
  if (o.kind !== "http") return "无法连接服务";
  const b = o.body as { error?: string; errors?: string[] } | null;
  return b?.error || b?.errors?.join("；") || `HTTP ${o.status}`;
}

/**
 * 待核对的批量管理：按来源筛选、搜索、勾选（含 Shift 区间选择），把一批写操作 / 审阅项标记为「已生效」或「未生效」。
 * 标记只更新记录（逐条走既有的人工标记接口），不重试、不回滚任何操作；任务类未知项仍需逐条去会话核对。
 */
export function ReviewBulk({ highlight }: { highlight?: string | null }) {
  const { inbox, inboxError, refreshInbox, workspaceId } = useShell();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [dialog, setDialog] = useState<Resolution | null>(null);
  const [run, setRun] = useState<RunState | null>(null);

  const entries = inbox?.entries ?? [];
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: entries.length, ledger: 0, review_item: 0, task: 0 };
    for (const e of entries) c[e.source] += 1;
    return c;
  }, [entries]);
  const q = query.trim().toLowerCase();
  const rows: Row[] = entries
    .filter((e) => filter === "all" || e.source === filter)
    .filter((e) => !q || [e.title, e.detail, e.id, e.statusLabel].some((v) => v.toLowerCase().includes(q)))
    .map((e) => ({ key: e.key, title: e.title, status: e.statusLabel, source: INBOX_SOURCE_LABEL[e.source], updated: e.updatedAt ?? "", entry: e }));
  const visible = new Set(rows.map((r) => r.key));
  const chosen = entries.filter((e) => selected.includes(e.key) && visible.has(e.key));
  const toMark = chosen.filter(markable);
  const skipped = chosen.length - toMark.length;

  const columns: DataColumn<Row>[] = [
    { key: "title", label: "事项", render: (_v, r) => (
      <span className={`review-cell ${highlight === r.key ? "is-highlighted" : ""}`}>
        <strong>{r.title}</strong>
        <span className="muted">{r.entry.detail || r.entry.id}</span>
      </span>
    ) },
    { key: "status", label: "状态", render: (_v, r) => <Chip tone={r.entry.tone}>{r.status}</Chip> },
    { key: "source", label: "来源" },
    { key: "updated", label: "更新时间", render: (v) => (v ? fmtTime(String(v)) : "—") },
    { key: "action", label: "", sortable: false, render: (_v, r) => <Link to={r.entry.href} className="review-link" data-action="verify">去核对</Link> },
  ];

  const execute = async (resolution: Resolution, reason: string) => {
    setDialog(null);
    const failed: { title: string; reason: string }[] = [];
    let ok = 0;
    setRun({ phase: "running", done: 0, total: toMark.length });
    for (const [i, e] of toMark.entries()) {
      // 逐条提交：每条都有自己的确认串与回执，一条失败不影响其余。
      const err = await markOne(e, resolution, reason, workspaceId ?? "");
      if (err) failed.push({ title: `${e.title} · ${e.id}`, reason: err }); else ok += 1;
      setRun({ phase: "running", done: i + 1, total: toMark.length });
    }
    setRun({ phase: "done", ok, failed, skipped });
    setSelected([]);
    refreshInbox();
  };

  if (inboxError) return <Alert tone="warning" title="待核对读取失败">{inboxError} <Button className="sm" variant="ghost" onClick={refreshInbox}>重试读取</Button></Alert>;
  if (!inbox) return <p className="inbox-note" role="status">读取待核对…</p>;
  const problems = (Object.entries(inbox.sources) as [InboxSource, (typeof inbox.sources)[InboxSource]][]).filter(([, s]) => s.state !== "ok");

  return (
    <section className="review-bulk" data-testid="review-bulk">
      {problems.map(([src, s]) => <Alert key={src} tone="warning" title={`${INBOX_SOURCE_LABEL[src]}未能读取`}>{s.state === "ok" ? "" : s.reason}。计数不完整，不代表其中没有待核对项。</Alert>)}
      {run?.phase === "running" ? <p className="inbox-note" role="status" data-testid="bulk-progress">正在标记 {run.done}/{run.total}…</p> : null}
      {run?.phase === "done" ? (
        <Alert tone={run.failed.length ? "warning" : "success"} title={`已标记 ${run.ok} 项${run.failed.length ? `，${run.failed.length} 项未成功` : ""}`} data-testid="bulk-result" onDismiss={() => setRun(null)}>
          {run.skipped ? <p>跳过 {run.skipped} 项：任务要在会话里核对，已阻断的写操作没有执行，需单独处理。</p> : null}
          {run.failed.length ? <ul className="bulk-failures">{run.failed.map((f) => <li key={f.title}>{f.title}：{f.reason}</li>)}</ul> : <p>记录已更新；没有重试或回滚任何操作。</p>}
        </Alert>
      ) : null}

      {entries.length === 0 ? (
        <EmptyState title="暂无待核对项" icon={<IconCheckCircle size={20} />}
          description={problems.length ? "可读来源里没有待核对项；上面列出的来源未能读取，不代表其中没有。" : "审阅项、写操作账本和任务里目前都没有需要人工核对的内容。"} />
      ) : (
        <>
          <div className="review-toolbar">
            <SegmentedControl label="按来源筛选" value={filter} onValueChange={(v) => { setFilter(v as Filter); setSelected([]); }}
              options={([["all", "全部"], ["ledger", "写操作"], ["review_item", "审阅项"], ["task", "任务"]] as const).map(([value, label]) => ({ value, label, accessory: <span className="tab-count">{counts[value]}</span> }))} />
            <SearchField label="搜索待核对" value={query} onValueChange={setQuery} placeholder="按工具、说明、编号搜索" className="review-search" />
          </div>

          <div className={`bulk-bar ${chosen.length ? "is-active" : ""}`} role="toolbar" aria-label="批量操作" data-testid="bulk-bar">
            {chosen.length ? (
              <>
                <span><strong>已选 {chosen.length} 项</strong>{skipped ? <span className="muted"> · 其中 {skipped} 项不能批量标记（任务或已阻断的写操作）</span> : null}</span>
                <span className="grow" />
                <Button className="sm" variant="ghost" onClick={() => setSelected([])}>清除选择</Button>
                <Button className="sm" onClick={() => setDialog("failed")} disabled={!toMark.length || run?.phase === "running"} data-testid="bulk-failed">标记为未生效</Button>
                <Button className="sm" variant="primary" onClick={() => setDialog("succeeded")} disabled={!toMark.length || run?.phase === "running"} data-testid="bulk-succeeded">标记为已生效</Button>
              </>
            ) : <span className="muted">勾选多项后可批量标记；按住 Shift 可连续勾选。逐条核对请点「去核对」。</span>}
          </div>

          <SortableDataTable<Row> rows={rows} columns={columns} rowKey="key" selectable selectedKeys={selected} onSelectionChange={setSelected}
            caption="待核对事项" emptyMessage="没有符合条件的事项" itemName={{ one: "项", other: "项" }} defaultSort={{ key: "updated", direction: "desc" }}
            messages={{
              selectAll: "全选", selectRow: (n) => `选择 ${n}`, selected: "项已选", selectionCleared: "已清除选择", clearSelection: "清除选择",
              selectionCount: (s, t) => `已选 ${s} / ${t} 项`, sortBy: (l, st) => `按${l}排序${st ? `，当前${st === "ascending" ? "升序" : "降序"}` : ""}`,
              sortedBy: (l, d) => `已按${l}${d === "ascending" ? "升序" : "降序"}排列`,
            }} />
        </>
      )}

      {dialog ? <BulkDialog resolution={dialog} entries={toMark} skipped={skipped} onCancel={() => setDialog(null)} onConfirm={(reason) => void execute(dialog, reason)} /> : null}
    </section>
  );
}

function BulkDialog({ resolution, entries, skipped, onCancel, onConfirm }: {
  resolution: Resolution; entries: InboxEntry[]; skipped: number; onCancel: () => void; onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const expected = `标记 ${entries.length} 项`;
  const ready = reason.trim().length > 0 && typed.trim() === expected;
  const groups = Object.entries(entries.reduce<Record<string, number>>((m, e) => ({ ...m, [`${INBOX_SOURCE_LABEL[e.source]} · ${e.title}`]: (m[`${INBOX_SOURCE_LABEL[e.source]} · ${e.title}`] ?? 0) + 1 }), {}));
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onCancel(); }}>
      <DialogContent title={`把 ${entries.length} 项标记为「${RESOLUTION_LABEL[resolution]}」？`} data-testid="bulk-dialog"
        description={resolution === "succeeded" ? "表示你已在设备或系统上确认这些写入确实发生了。" : "表示你已确认这些写入没有发生。"}>
        <div className="bulk-dialog">
          <ul className="bulk-groups">{groups.map(([k, n]) => <li key={k}><span>{k}</span><strong>{n}</strong></li>)}</ul>
          <p className="muted">只更新核对记录，不会重试、回滚或下发任何操作。{skipped ? ` 另有 ${skipped} 项不在本次范围内。` : ""}</p>
          <Textarea label="核对说明（必填）" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例如：已登录设备核对运行配置，未见变更" rows={3} data-testid="bulk-reason" />
          <Input label={`输入「${expected}」确认`} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={expected} data-testid="bulk-confirm-text" />
          <div className="bulk-dialog-foot">
            <Button variant="ghost" onClick={onCancel}>取消</Button>
            <Button variant={resolution === "succeeded" ? "primary" : "danger"} disabled={!ready} onClick={() => onConfirm(reason.trim())} data-testid="bulk-submit">
              标记为{RESOLUTION_LABEL[resolution]}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
