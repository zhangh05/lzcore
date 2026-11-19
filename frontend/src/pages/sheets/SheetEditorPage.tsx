import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, bodyOf, enc, isOk } from "../../api/client";
import { useShell } from "../../app/shellContext";
import { Button } from "../../components/Button";
import { IconArrowLeft, IconDownload } from "../../components/Icon";
import type { HttpOutcome } from "../../contracts/auth";
import { NAMES } from "../../contracts/naming";
import { FailureNote } from "../../kit/ui";
import { Link, useNavigationGuard } from "../../router";
import type { SheetHandle } from "./UniverSheet";
import { downloadExport, updatedByLabel, type SheetRecord, type SheetSummary } from "./sheetsApi";

// Univer 体积大，只在打开表格时加载。
const UniverSheet = lazy(() => import("./UniverSheet"));

const SAVE_DELAY_MS = 1200;
const POLL_MS = 4000;

type SaveState =
  | { kind: "saved"; at: number }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "conflict"; current: number }
  | { kind: "failed"; outcome: HttpOutcome };

/** 表格编辑页：自动保存（带版本号防覆盖）、别处（如智能体）写入后自动载入、导出。 */
export function SheetEditorPage({ spreadsheetId }: { spreadsheetId: string }) {
  const { workspaceId: ws, hrefFor, auth } = useShell();
  const [record, setRecord] = useState<SheetRecord | null>(null);
  const [loadFailure, setLoadFailure] = useState<HttpOutcome | null>(null);

  useEffect(() => {
    if (!ws) return;
    let alive = true;
    setRecord(null); setLoadFailure(null);
    void api.get(`/api/spreadsheets/${enc(spreadsheetId)}`, { workspace_id: ws }).then((o) => {
      if (!alive) return;
      const sheet = bodyOf<{ spreadsheet?: SheetRecord }>(o)?.spreadsheet;
      if (isOk(o) && sheet) setRecord(sheet); else setLoadFailure(o);
    });
    return () => { alive = false; };
  }, [ws, spreadsheetId]);

  if (!ws) return null;
  const back = <Link to={hrefFor("/sheets")} className="btn ghost wb-back"><IconArrowLeft size={15} aria-hidden="true" />{NAMES.sheets}</Link>;
  if (loadFailure) return <div className="page">{back}<FailureNote outcome={loadFailure} /></div>;
  if (!record) return <div className="page wb-editor" aria-busy="true">{back}<p className="muted shimmer-text" role="status">读取表格…</p></div>;
  return <Editor key={record.spreadsheet_id} ws={ws} initial={record} readOnly={auth.role === "viewer"} back={back} />;
}

function Editor({ ws, initial, readOnly, back }: { ws: string; initial: SheetRecord; readOnly: boolean; back: React.ReactNode }) {
  const [meta, setMeta] = useState<SheetSummary>(initial);
  const [state, setState] = useState<SaveState>({ kind: "saved", at: Date.now() });
  const [notice, setNotice] = useState<string | null>(null);
  const handle = useRef<SheetHandle | null>(null);
  const revision = useRef(initial.revision);
  const dirty = useRef(false);
  const saving = useRef(false);
  const blocked = useRef(false); // 冲突后停止自动保存，等用户选择
  const timer = useRef<number | undefined>(undefined);
  const url = `/api/spreadsheets/${enc(initial.spreadsheet_id)}`;

  const save = useCallback(async (force = false): Promise<void> => {
    window.clearTimeout(timer.current);
    if (readOnly || !handle.current || saving.current || (blocked.current && !force)) return;
    const snapshot = handle.current.snapshot();
    if (!snapshot) return;
    saving.current = true;
    dirty.current = false;
    setState({ kind: "saving" });
    let o = await api.put(url, { workspace_id: ws, workbook: snapshot, base_revision: revision.current });
    if (force && o.kind === "http" && o.status === 409) {
      // 用户选择用自己的版本覆盖：以服务端当前版本为基准重新提交。
      const current = (bodyOf<{ current_revision?: number }>(o)?.current_revision) ?? revision.current;
      o = await api.put(url, { workspace_id: ws, workbook: snapshot, base_revision: current });
    }
    saving.current = false;
    const saved = bodyOf<{ spreadsheet?: SheetSummary }>(o)?.spreadsheet;
    if (isOk(o) && saved) {
      blocked.current = false;
      revision.current = saved.revision;
      setMeta(saved);
      if (dirty.current) { setState({ kind: "dirty" }); timer.current = window.setTimeout(() => void save(), SAVE_DELAY_MS); }
      else setState({ kind: "saved", at: Date.now() });
      return;
    }
    dirty.current = true;
    if (o.kind === "http" && o.status === 409) {
      blocked.current = true;
      setState({ kind: "conflict", current: bodyOf<{ current_revision?: number }>(o)?.current_revision ?? 0 });
    } else setState({ kind: "failed", outcome: o });
  }, [readOnly, url, ws]);

  const onChange = useCallback(() => {
    if (readOnly) return;
    dirty.current = true;
    setNotice(null);
    if (!blocked.current) setState((s) => (s.kind === "dirty" ? s : { kind: "dirty" }));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(), SAVE_DELAY_MS);
  }, [readOnly, save]);

  const reloadLatest = useCallback(async (reason: string) => {
    const o = await api.get(url, { workspace_id: ws });
    const latest = bodyOf<{ spreadsheet?: SheetRecord }>(o)?.spreadsheet;
    if (!isOk(o) || !latest || !handle.current) return false;
    handle.current.load(latest.workbook);
    revision.current = latest.revision;
    dirty.current = false;
    blocked.current = false;
    setMeta(latest);
    setState({ kind: "saved", at: Date.now() });
    setNotice(reason.replace("{who}", updatedByLabel(latest.updated_by) || "其他人"));
    return true;
  }, [url, ws]);

  // 别处写入（智能体、另一个窗口）后自动载入：只在本地没有未保存修改时进行。
  useEffect(() => {
    const id = window.setInterval(async () => {
      if (dirty.current || saving.current || blocked.current || document.hidden) return;
      const o = await api.get(url, { workspace_id: ws, summary: 1 });
      const latest = bodyOf<{ spreadsheet?: SheetSummary }>(o)?.spreadsheet;
      if (isOk(o) && latest && latest.revision > revision.current && !dirty.current && !saving.current) {
        await reloadLatest("已载入{who}刚才的修改。");
      }
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [url, ws, reloadLatest]);

  // 离开页面前把未保存的修改发出去。
  useEffect(() => () => { if (dirty.current && !blocked.current) void save(); }, [save]);
  const unsaved = state.kind === "dirty" || state.kind === "saving" || state.kind === "conflict" || state.kind === "failed";
  useNavigationGuard(unsaved, "表格还有未保存的修改，确定离开吗？");

  const onReady = useCallback((h: SheetHandle | null) => { handle.current = h; }, []);
  // 初始快照只在挂载时交给 Univer；之后由 handle.load 更新。
  const initialWorkbook = useMemo(() => initial.workbook, [initial.workbook]);

  const exportAs = async (format: "xlsx" | "csv") => {
    if (dirty.current) await save();
    const err = await downloadExport(ws, meta, format, format === "csv" ? handle.current?.activeSheetName() : undefined);
    if (err) setNotice(err);
  };

  return (
    <div className="page wb-editor" data-testid="sheet-editor">
      <header className="wb-bar">
        {back}
        <h1 className="wb-title" title={meta.name}>{meta.name}</h1>
        <SaveStatus state={state} readOnly={readOnly} revision={meta.revision} />
        <span className="grow" />
        <Button variant="ghost" onClick={() => void exportAs("csv")} data-testid="sheet-export-csv">导出当前工作表 CSV</Button>
        <Button onClick={() => void exportAs("xlsx")} data-testid="sheet-export-xlsx"><IconDownload size={15} aria-hidden="true" />导出 Excel</Button>
      </header>
      {notice ? <p className="readback-note" role="status" data-testid="sheet-notice">{notice}</p> : null}
      {state.kind === "conflict" ? (
        <div className="inline-alert tone-warn wb-conflict" role="alert" data-testid="sheet-conflict">
          <span>这张表格刚被别处修改过（例如智能体写入），你的修改还没保存。</span>
          <Button onClick={() => void reloadLatest("已载入{who}的版本，你刚才的修改已放弃。")} data-testid="sheet-conflict-reload">载入最新版本</Button>
          <Button variant="ghost" onClick={() => void save(true)} data-testid="sheet-conflict-overwrite">用我的版本覆盖</Button>
        </div>
      ) : null}
      {state.kind === "failed" ? (
        <div className="wb-failed"><FailureNote outcome={state.outcome} /><Button onClick={() => void save()}>重试保存</Button></div>
      ) : null}
      <div className="wb-canvas">
        <Suspense fallback={<p className="muted shimmer-text" role="status">加载表格编辑器…</p>}>
          <UniverSheet workbook={initialWorkbook} readOnly={readOnly} onChange={onChange} onReady={onReady} />
        </Suspense>
      </div>
    </div>
  );
}

function SaveStatus({ state, readOnly, revision }: { state: SaveState; readOnly: boolean; revision: number }) {
  if (readOnly) return <span className="wb-status" data-testid="sheet-status">只读 · 当前账户不能修改</span>;
  const text = state.kind === "saving" ? "保存中…"
    : state.kind === "dirty" ? "有未保存的修改"
    : state.kind === "conflict" ? "未保存 · 版本冲突"
    : state.kind === "failed" ? "保存失败"
    : `已保存 · 第 ${revision} 版`;
  return <span className={`wb-status is-${state.kind}`} role="status" data-testid="sheet-status">{text}</span>;
}
