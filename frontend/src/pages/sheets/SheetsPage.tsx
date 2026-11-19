import { useRef, useState, type DragEvent } from "react";
import { api, bodyOf, enc, isOk, uploadMultipart } from "../../api/client";
import { useShell } from "../../app/shellContext";
import { Button } from "../../components/Button";
import { PageHeader } from "../../components/EmptyState";
import { IconDownload, IconPlus, IconUpload } from "../../components/Icon";
import type { HttpOutcome } from "../../contracts/auth";
import { NAMES } from "../../contracts/naming";
import { Field } from "../../kit/form";
import { ConfirmDialog, Dialog, FailureNote, LoadState, ReceiptNote, Table, fmtTime } from "../../kit/ui";
import { listOf, useApi } from "../../kit/useApi";
import { Link, useNavigate } from "../../router";
import { SHEET_ACCEPT, downloadExport, updatedByLabel, type SheetSummary } from "./sheetsApi";

/** 表格列表：新建、导入 Excel / CSV（选择或拖入）、打开、重命名、导出、删除。 */
export function SheetsPage() {
  const { workspaceId: ws, hrefFor } = useShell();
  const navigate = useNavigate();
  const [list, reload] = useApi(ws ? "/api/spreadsheets" : null, { workspace_id: ws ?? "" });
  const [naming, setNaming] = useState<{ mode: "new" } | { mode: "rename"; sheet: SheetSummary } | null>(null);
  const [del, setDel] = useState<SheetSummary | null>(null);
  const [failure, setFailure] = useState<HttpOutcome | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  if (!ws) return null;

  const open = (id: string) => navigate(hrefFor(`/sheets/${enc(id)}`));

  async function importFiles(files: FileList | File[]) {
    const items = Array.from(files).filter((f) => /\.(xlsx|xlsm|csv|tsv)$/i.test(f.name));
    if (!items.length) { setNote("只能导入 .xlsx、.xlsm、.csv 或 .tsv 文件。"); return; }
    setBusy(true); setFailure(null); setNote(null);
    let last: string | null = null;
    for (const file of items) {
      const o = await uploadMultipart("/api/spreadsheets/import", { workspace_id: ws! }, file);
      if (!isOk(o)) { setFailure(o); break; }
      last = bodyOf<{ spreadsheet?: SheetSummary }>(o)?.spreadsheet?.spreadsheet_id ?? null;
    }
    setBusy(false);
    reload();
    if (last && items.length === 1) open(last);
    else if (last) setNote(`已导入 ${items.length} 个文件。`);
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDragging(false);
    if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files);
  };

  const rows = listOf<SheetSummary>(list, "spreadsheets");
  return (
    <div className={`page sheets-page${dragging ? " is-dragging" : ""}`} data-testid="sheets-page"
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }} onDrop={onDrop}>
      <PageHeader title={NAMES.sheets} subtitle="像 Excel 一样自由记录；可以导入导出 .xlsx，智能体也能读写这里的表格。">
        <Button onClick={() => fileRef.current?.click()} disabled={busy} data-testid="sheets-import">
          <IconUpload size={15} aria-hidden="true" />{busy ? "导入中…" : "导入 Excel / CSV"}
        </Button>
        <Button variant="primary" onClick={() => setNaming({ mode: "new" })} data-testid="sheets-new"><IconPlus size={15} aria-hidden="true" />新建表格</Button>
        <input ref={fileRef} type="file" accept={SHEET_ACCEPT} multiple hidden data-testid="sheets-file"
          onChange={(e) => { if (e.target.files?.length) void importFiles(e.target.files); e.target.value = ""; }} />
      </PageHeader>
      {failure ? <FailureNote outcome={failure} /> : null}
      {note ? <ReceiptNote text={note} /> : null}
      {dragging ? <div className="sheets-drop" aria-hidden="true">松开即可导入</div> : null}
      <LoadState value={list} onReload={reload}>{() => (
        <Table testId="sheets-table" rows={rows} rowKey={(s) => s.spreadsheet_id} onRowOpen={(s) => open(s.spreadsheet_id)}
          empty={<div className="sheets-empty"><p>还没有表格。新建一个，或把 Excel / CSV 文件拖到这里。</p></div>}
          columns={[
            { key: "n", label: "表格", className: "sheets-col-name", sortValue: (s) => s.name, render: (s) => <Link to={hrefFor(`/sheets/${enc(s.spreadsheet_id)}`)} className="sheets-name">{s.name}</Link> },
            { key: "s", label: "工作表", className: "sheets-col-tabs", render: (s) => <span className="muted">{(s.sheets ?? []).join("、") || "—"}</span> },
            { key: "t", label: "更新", className: "is-time", sortValue: (s) => s.updated_at ?? "", render: (s) => <>{fmtTime(s.updated_at)}{s.updated_by ? <span className="muted"> · {updatedByLabel(s.updated_by)}</span> : null}</> },
            { key: "a", label: "", className: "sheets-col-actions", render: (s) => <span className="row-actions">
              <Button variant="ghost" onClick={async () => { const err = await downloadExport(ws, s, "xlsx"); if (err) setNote(err); }} aria-label={`导出 ${s.name}`}><IconDownload size={14} aria-hidden="true" />导出</Button>
              <Button variant="ghost" onClick={() => setNaming({ mode: "rename", sheet: s })}>重命名</Button>
              <Button variant="ghost" onClick={() => setDel(s)} data-testid="sheets-delete">删除</Button>
            </span> },
          ]} />
      )}</LoadState>
      {naming ? <NameDialog ws={ws} target={naming} onClose={() => setNaming(null)} onDone={(s) => {
        setNaming(null); reload();
        if (naming.mode === "new") open(s.spreadsheet_id); else setNote(`已重命名为「${s.name}」。`);
      }} /> : null}
      {del ? <ConfirmDialog title="删除表格？" confirmLabel="删除" testId="sheets-delete-dialog"
        details={<p>将永久删除「{del.name}」及其全部工作表，无法恢复。需要留底可以先导出为 Excel。</p>}
        onCancel={() => setDel(null)} onConfirm={async () => {
          const o = await api.del(`/api/spreadsheets/${enc(del.spreadsheet_id)}`, { workspace_id: ws, confirm: "delete" });
          setDel(null);
          if (isOk(o)) { setNote(`已删除「${del.name}」。`); reload(); } else setFailure(o);
        }} /> : null}
    </div>
  );
}

function NameDialog({ ws, target, onClose, onDone }: {
  ws: string; target: { mode: "new" } | { mode: "rename"; sheet: SheetSummary }; onClose: () => void; onDone: (s: SheetSummary) => void;
}) {
  const [name, setName] = useState(target.mode === "rename" ? target.sheet.name : "");
  const [failure, setFailure] = useState<HttpOutcome | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const o = target.mode === "new"
      ? await api.post("/api/spreadsheets", { workspace_id: ws, name })
      : await api.patch(`/api/spreadsheets/${enc(target.sheet.spreadsheet_id)}`, { workspace_id: ws, name });
    setSaving(false);
    const sheet = bodyOf<{ spreadsheet?: SheetSummary }>(o)?.spreadsheet;
    if (isOk(o) && sheet) onDone(sheet); else setFailure(o);
  };
  return (
    <Dialog title={target.mode === "new" ? "新建表格" : "重命名表格"} onClose={onClose} testId="sheets-name-dialog" footer={<>
      <Button variant="ghost" onClick={onClose}>取消</Button>
      <Button variant="primary" onClick={submit} disabled={!name.trim() || saving} data-testid="sheets-name-submit">{target.mode === "new" ? "创建并打开" : "保存"}</Button>
    </>}>
      <Field label="名称" required>{(a) => <input {...a} autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} placeholder="例如：巡检记录、采购清单" data-testid="sheets-name-input" />}</Field>
      {failure ? <FailureNote outcome={failure} /> : null}
    </Dialog>
  );
}
