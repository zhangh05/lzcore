import { useEffect, useState } from "react";
import { api, bodyOf, enc } from "../../api/client";
import { useShell, withWorkspace } from "../../app/shellContext";
import { Button } from "../../components/Button";
import { PageHeader } from "../../components/EmptyState";
import { NAMES } from "../../contracts/naming";
import type { HttpOutcome } from "../../contracts/auth";
import { listOf, useApi } from "../../kit/useApi";
import { Chip, Drawer, FailureNote, JsonBlock, KeyValues, LoadState, ReceiptNote, Table, Tabs, fmtTime, useUrlTab } from "../../kit/ui";
import { Link, useSearchParams } from "../../router";
import { JobsColumn } from "./JobsColumn";
import { OUTCOME_FIELD_MISSING, runtimeActionGate, runtimeStatusLabel, type RuntimeTask, type SessionTaskView } from "./model";

const TABS = ["tasks", "runs", "reports", "trajectories"] as const;
type Tab = typeof TABS[number];

export function TasksPage() {
  const { workspaceId: ws } = useShell();
  const [tab, setTab] = useUrlTab(TABS, "tasks");
  const [params, setParams] = useSearchParams();
  const openTask = params.get("task");
  const openRun = params.get("run");
  const setParam = (k: string, v: string | null) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n); };
  if (!ws) return <div className="page"><p role="status">正在确定工作区…</p></div>;
  return (
    <div className="page" data-testid="tasks-page">
      <PageHeader title={NAMES.tasks} subtitle="主模型是运行时任务（runtime tasks）；作业队列只作为附列展示队列态。" />
      <Tabs label="任务视图" current={tab} onChange={(t: Tab) => setTab(t)} tabs={[{ key: "tasks", label: "运行时任务" }, { key: "runs", label: "运行 / 追踪" }, { key: "reports", label: "报告" }, { key: "trajectories", label: "轨迹" }]} />
      <div className="tasks-layout">
        <div className="tasks-main">
          {tab === "tasks" ? <RuntimeTaskList ws={ws} onOpen={(id) => setParam("task", id)} /> : null}
          {tab === "runs" ? <RunsView ws={ws} onOpen={(id) => setParam("run", id)} /> : null}
          {tab === "reports" ? <ReportsView ws={ws} openId={params.get("report")} onOpen={(id) => setParam("report", id)} onOpenRun={(id) => setParam("run", id)} /> : null}
          {tab === "trajectories" ? <TrajectoriesView ws={ws} /> : null}
        </div>
        <JobsColumn ws={ws} />
      </div>
      {openTask ? <TaskDetail ws={ws} taskId={openTask} onClose={() => setParam("task", null)} /> : null}
      {openRun ? <RunDetail ws={ws} runId={openRun} onClose={() => setParam("run", null)} /> : null}
    </div>
  );
}

function RuntimeTaskList({ ws, onOpen }: { ws: string; onOpen: (id: string) => void }) {
  const [tasks, reload] = useApi("/api/runtime/tasks", { workspace_id: ws });
  return (
    <>
      <p className="inline-alert tone-info" role="note" data-testid="outcome-missing-note">该列表来自 <code>GET /api/runtime/tasks</code>（durable TaskState），后端不返回 <code>execution_outcome</code> / <code>unknown_outcome</code>；目标层结论与未知项请打开详情，从该任务所属会话的 task-state 读取。</p>
      <LoadState value={tasks} onReload={reload}>{() => (
        <Table testId="runtime-tasks" rows={listOf<RuntimeTask>(tasks, "tasks")} rowKey={(t) => t.task_id} onRowOpen={(t) => onOpen(t.task_id)}
          empty={<p className="muted">还没有运行时任务。</p>}
          columns={[
            { key: "goal", label: "目标", render: (t) => t.user_goal || <code>{t.task_id}</code> },
            { key: "status", label: "运行时状态", render: (t) => <Chip>{runtimeStatusLabel(t.status)}</Chip>, sortValue: (t) => t.status ?? "" },
            { key: "outcome", label: "目标结论", render: () => <span className="muted">{OUTCOME_FIELD_MISSING}</span> },
            { key: "session", label: "会话", render: (t) => t.session_id ? <Link to={withWorkspace(`/workbench?session=${enc(t.session_id)}`, ws)}>打开会话</Link> : "—" },
            { key: "updated", label: "更新", render: (t) => fmtTime(t.updated_at), sortValue: (t) => t.updated_at ?? "" },
          ]} />
      )}</LoadState>
    </>
  );
}

const DETAIL_TABS = ["overview", "steps", "events", "checkpoints", "audit"] as const;
type DetailTab = typeof DETAIL_TABS[number];

export function TaskDetail({ ws, taskId, onClose }: { ws: string; taskId: string; onClose: () => void }) {
  const base = `/api/runtime/tasks/${enc(taskId)}`;
  const [detail, reload] = useApi(base, { workspace_id: ws });
  const [tab, setTab] = useState<DetailTab>("overview");
  const [sessionTask, setSessionTask] = useState<SessionTaskView | null | "unreadable">(null);
  const [action, setAction] = useState<{ label: string; o: HttpOutcome } | null>(null);
  const task = detail.state === "ok" ? ((detail.data as { task?: RuntimeTask }).task ?? (detail.data as unknown as RuntimeTask)) : null;

  useEffect(() => {
    if (!task?.session_id) { setSessionTask(null); return; }
    void api.get(`/api/runtime/sessions/${enc(task.session_id)}/task-state`, { workspace_id: ws }).then((o) => {
      if (o.kind !== "http" || o.status !== 200) { setSessionTask("unreadable"); return; }
      setSessionTask(bodyOf<{ task_state?: { task?: SessionTaskView } }>(o)?.task_state?.task ?? null);
    });
  }, [ws, task?.session_id]);

  const post = async (label: string, path: string, body: unknown = {}) => { setAction({ label, o: await api.post(path, body, { workspace_id: ws }) }); reload(); };
  const unknownCount = sessionTask && sessionTask !== "unreadable" ? sessionTask.unknowns?.length ?? 0 : 0;
  const resumeGate = task ? runtimeActionGate("resume", task, sessionTask) : null;
  const stepGate = task ? runtimeActionGate("step_retry", task, sessionTask) : null;

  return (
    <Drawer title={`任务 ${taskId}`} onClose={onClose} testId="task-detail">
      <LoadState value={detail} onReload={reload}>{() => task ? (
        <>
          {unknownCount > 0 ? (
            <div className="inline-alert tone-unknown" role="alert" data-testid="task-unknown">
              <strong>结果未知 · 需核对</strong>（{unknownCount} 项，来自会话 task-state）
              <Link className="btn" to={`/review?ws=${enc(ws)}&source=task&id=${enc(taskId)}${task.session_id ? `&session=${enc(task.session_id)}` : ""}`}>去核对</Link>
            </div>
          ) : null}
          {sessionTask === "unreadable" ? <p className="inline-alert tone-warn" role="alert">会话任务状态不可读，未知项无法确认。</p> : null}
          {action ? (action.o.kind === "http" && action.o.status < 300 ? <ReceiptNote text={`${action.label}已提交`} /> : <FailureNote outcome={action.o} />) : null}
          <div className="row-actions">
            {task.status === "running" || task.status === "pending" ? <Button onClick={() => void post("取消请求", `${base}/cancel`)} data-testid="task-cancel">请求取消</Button> : null}
            <Button onClick={() => void post("续接请求", `${base}/resume`)} disabled={!resumeGate?.allowed} title={resumeGate && !resumeGate.allowed ? resumeGate.reason : undefined} data-testid="task-resume">续接</Button>
            <Button onClick={() => void post("检查点创建", `${base}/checkpoint`, { workspace_id: ws, reason: "manual" })}>创建检查点</Button>
          </div>
          {resumeGate && !resumeGate.allowed ? <p className="muted" data-testid="resume-gate">{resumeGate.reason}</p> : null}
          <Tabs label="任务详情" current={tab} onChange={setTab} tabs={[{ key: "overview", label: "概览" }, { key: "steps", label: "步骤", count: task.steps?.length }, { key: "events", label: "事件" }, { key: "checkpoints", label: "检查点" }, { key: "audit", label: "审计报告" }]} />
          {tab === "overview" ? (
            <KeyValues items={[
              ["运行时状态", runtimeStatusLabel(task.status)],
              ["目标结论", sessionTask && sessionTask !== "unreadable" ? (unknownCount ? "结果未知 · 需核对" : `会话 task-state：${sessionTask.status ?? "未上报"}`) : OUTCOME_FIELD_MISSING],
              ["目标", task.user_goal], ["会话", task.session_id], ["run", task.run_id], ["作业", task.job_id], ["trace", task.trace_id],
              ["创建", fmtTime(task.created_at)], ["更新", fmtTime(task.updated_at)],
            ]} />
          ) : null}
          {tab === "steps" ? (
            <Table rows={task.steps ?? []} rowKey={(s) => s.step_id} empty={<p className="muted">没有步骤记录。</p>} columns={[
              { key: "step", label: "步骤", render: (s) => s.title ?? s.name ?? s.step_id },
              { key: "status", label: "状态", render: (s) => <Chip>{s.status ?? "未上报"}</Chip> },
              { key: "act", label: "", render: (s) => s.status === "failed" ? (
                <Button onClick={() => void post(`步骤 ${s.step_id} 重试`, `${base}/steps/${enc(s.step_id)}/retry`)} disabled={!stepGate?.allowed} title={stepGate && !stepGate.allowed ? stepGate.reason : undefined} data-testid="step-retry">重试此步骤</Button>
              ) : null },
            ]} />
          ) : null}
          {tab === "events" ? <SubList path={`${base}/events`} ws={ws} listKey="events" /> : null}
          {tab === "checkpoints" ? <SubList path={`${base}/checkpoints`} ws={ws} listKey="checkpoints" /> : null}
          {tab === "audit" ? <AuditReport ws={ws} base={base} /> : null}
        </>
      ) : <p className="muted">任务不存在。</p>}</LoadState>
    </Drawer>
  );
}

function SubList({ path, ws, listKey }: { path: string; ws: string; listKey: string }) {
  const [v, reload] = useApi(path, { workspace_id: ws });
  return <LoadState value={v} onReload={reload}>{() => {
    const list = listOf<Record<string, unknown>>(v, listKey);
    return list.length ? <ol className="timeline">{list.map((e, i) => <li key={i}><JsonBlock value={e} /></li>)}</ol> : <p className="muted">没有记录。</p>;
  }}</LoadState>;
}

function AuditReport({ ws, base }: { ws: string; base: string }) {
  const [v, reload] = useApi(`${base}/audit-report`, { workspace_id: ws });
  const [o, setO] = useState<HttpOutcome | null>(null);
  return (
    <>
      <Button onClick={async () => { setO(await api.post(`${base}/audit-report`, {}, { workspace_id: ws })); reload(); }}>生成审计报告</Button>
      {o ? (o.kind === "http" && o.status < 300 ? <ReceiptNote text="审计报告生成请求已提交" /> : <FailureNote outcome={o} />) : null}
      <LoadState value={v} onReload={reload}>{(d) => <JsonBlock value={d} />}</LoadState>
    </>
  );
}

function RunsView({ ws, onOpen }: { ws: string; onOpen: (id: string) => void }) {
  const [runs, reload] = useApi(`/api/workspaces/${enc(ws)}/runs`);
  const [recent] = useApi("/api/runs/recent", { workspace_id: ws });
  return (
    <>
      <LoadState value={runs} onReload={reload}>{() => (
        <Table testId="runs-table" rows={listOf<Record<string, string>>(runs, "runs")} rowKey={(r) => r.run_id} onRowOpen={(r) => onOpen(r.run_id)} empty={<p className="muted">没有运行记录。</p>}
          columns={[
            { key: "id", label: "run", render: (r) => <code>{r.run_id}</code> },
            { key: "status", label: "状态", render: (r) => <Chip>{r.status ?? "未上报"}</Chip> },
            { key: "title", label: "说明", render: (r) => r.title ?? r.goal ?? "—" },
            { key: "time", label: "时间", render: (r) => fmtTime(r.created_at) },
          ]} />
      )}</LoadState>
      <h3>最近运行（跨工作区汇总）</h3>
      <LoadState value={recent}>{() => <p className="muted">{listOf(recent, "runs").length} 条</p>}</LoadState>
    </>
  );
}

function RunDetail({ ws, runId, onClose }: { ws: string; runId: string; onClose: () => void }) {
  const base = `/api/workspaces/${enc(ws)}/runs/${enc(runId)}`;
  const [run, reload] = useApi(base);
  const [view, setView] = useState<"trace" | "report" | "artifacts">("trace");
  // 基线 `${base}/report` 只有 POST（创建），不能 GET 阅读；报告从 /reports 列表按 run_id 取，正文走 /reports/<id>/content。
  const [sub] = useApi(view === "report" ? null : `${base}/${view}`);
  return (
    <Drawer title={`运行 ${runId}`} onClose={onClose} testId="run-detail">
      <LoadState value={run} onReload={reload}>{(d) => <JsonBlock value={d} />}</LoadState>
      <Tabs label="运行详情" current={view} onChange={setView} tabs={[{ key: "trace", label: "追踪" }, { key: "report", label: "报告" }, { key: "artifacts", label: "产出" }]} />
      {view === "report" ? <RunReports ws={ws} runId={runId} /> : <LoadState value={sub}>{(d) => <JsonBlock value={d} />}</LoadState>}
    </Drawer>
  );
}

// ── 报告（A7）：GET /api/workspaces/<ws>/reports 列表；GET …/reports/<artifact_id>/content 正文 ──
export interface ReportRec { artifact_id: string; title?: string; summary?: string; run_id?: string | null; sensitivity?: string; created_at?: string; file_ext?: string }

function reportsOf(v: Parameters<typeof listOf>[0]): ReportRec[] { return listOf<ReportRec>(v, "reports"); }

function ReportsTable({ rows, onOpen, onOpenRun, testId }: { rows: ReportRec[]; onOpen: (id: string) => void; onOpenRun?: (id: string) => void; testId: string }) {
  return (
    <Table testId={testId} rows={rows} rowKey={(r) => r.artifact_id} onRowOpen={(r) => onOpen(r.artifact_id)} empty={<p className="muted">还没有报告。</p>}
      columns={[
        { key: "t", label: "报告", render: (r) => r.title || r.artifact_id },
        { key: "run", label: "运行", render: (r) => r.run_id ? (onOpenRun ? <Button variant="ghost" onClick={(e) => { e.stopPropagation(); onOpenRun(r.run_id!); }}>{r.run_id}</Button> : <code>{r.run_id}</code>) : "—" },
        { key: "s", label: "密级", render: (r) => r.sensitivity ?? "—" },
        { key: "time", label: "时间", render: (r) => fmtTime(r.created_at) },
        { key: "a", label: "", render: (r) => <Button onClick={(e) => { e.stopPropagation(); onOpen(r.artifact_id); }} data-testid={`report-open-${r.artifact_id}`}>阅读</Button> },
      ]} />
  );
}

export function ReportReader({ ws, report, onClose }: { ws: string; report: ReportRec | { artifact_id: string }; onClose: () => void }) {
  const [allowSensitive, setAllowSensitive] = useState(false);
  const [content, reload] = useApi(`/api/workspaces/${enc(ws)}/reports/${enc(report.artifact_id)}/content`, allowSensitive ? { allow_sensitive: 1 } : undefined);
  const r = report as ReportRec;
  return (
    <Drawer title={`报告 · ${r.title || report.artifact_id}`} onClose={onClose} testId="report-reader">
      <KeyValues items={[["报告 id", report.artifact_id], ["运行", r.run_id || "—"], ["密级", r.sensitivity ?? "未上报"], ["时间", fmtTime(r.created_at)]]} />
      {content.state === "error" && content.outcome.kind === "http" && content.outcome.status === 403 ? (
        <div className="inline-alert tone-warn" role="alert" data-testid="report-forbidden">
          正文不可读（后端返回 content not accessible：机密 / 已删除，或敏感报告未声明读取敏感内容）。
          {r.sensitivity === "sensitive" && !allowSensitive ? <Button onClick={() => setAllowSensitive(true)} data-testid="report-allow-sensitive">读取敏感内容</Button> : null}
        </div>
      ) : (
        <LoadState value={content} onReload={reload}>{(d) => {
          const text = (d as { content?: unknown }).content;
          return typeof text === "string" ? <pre className="report-content" data-testid="report-content">{text}</pre> : <p className="muted">后端未返回正文文本。</p>;
        }}</LoadState>
      )}
    </Drawer>
  );
}

function ReportsView({ ws, openId, onOpen, onOpenRun }: { ws: string; openId: string | null; onOpen: (id: string | null) => void; onOpenRun: (id: string) => void }) {
  const [list, reload] = useApi(`/api/workspaces/${enc(ws)}/reports`);
  const rows = reportsOf(list);
  const current = openId ? rows.find((x) => x.artifact_id === openId) ?? { artifact_id: openId } : null;
  return (
    <section data-testid="reports-view">
      <LoadState value={list} onReload={reload}>{() => <ReportsTable testId="reports-table" rows={rows} onOpen={onOpen} onOpenRun={onOpenRun} />}</LoadState>
      {current ? <ReportReader ws={ws} report={current} onClose={() => onOpen(null)} /> : null}
    </section>
  );
}

function RunReports({ ws, runId }: { ws: string; runId: string }) {
  const listPath = `/api/workspaces/${enc(ws)}/reports`;
  const [list, reload] = useApi(listPath);
  const [open, setOpen] = useState<string | null>(null);
  const [created, setCreated] = useState<{ o: HttpOutcome; readback: string | null } | null>(null);
  const rows = reportsOf(list).filter((r) => r.run_id === runId);
  const create = async () => {
    const before = new Set(rows.map((r) => r.artifact_id));
    const o = await api.post(`/api/workspaces/${enc(ws)}/runs/${enc(runId)}/report`, { title: `运行 ${runId} 报告` });
    let readback: string | null = null;
    if (o.kind === "http" && o.status < 300) {
      // 受理 ≠ 已生成：回读报告列表，以列表里是否出现新报告为准。
      const back = await api.get(listPath);
      const now = (bodyOf<{ reports?: ReportRec[] }>(back)?.reports ?? []).filter((r) => r.run_id === runId);
      const fresh = now.filter((r) => !before.has(r.artifact_id));
      readback = fresh.length ? `回读：列表中出现新报告 ${fresh.map((r) => r.title || r.artifact_id).join("、")}` : "回读：报告列表里暂未出现新报告（可能仍在生成，或生成失败），请稍后刷新。";
      reload();
    }
    setCreated({ o, readback });
  };
  return (
    <section data-testid="run-reports">
      <LoadState value={list} onReload={reload}>{() => <ReportsTable testId="run-reports-table" rows={rows} onOpen={setOpen} />}</LoadState>
      <Button onClick={() => void create()} data-testid="run-report-create">请求生成报告</Button>
      {created ? (created.o.kind === "http" && created.o.status < 300
        ? <><ReceiptNote text="生成请求已受理（不代表报告已生成）" /><p className="muted" data-testid="run-report-readback">{created.readback}</p></>
        : <FailureNote outcome={created.o} />) : null}
      {open ? <ReportReader ws={ws} report={rows.find((r) => r.artifact_id === open) ?? { artifact_id: open }} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

function TrajectoriesView({ ws }: { ws: string }) {
  const [v, reload] = useApi("/api/runtime/trajectories", { workspace_id: ws });
  const [open, setOpen] = useState<string | null>(null);
  const [one] = useApi(open ? `/api/runtime/trajectories/${enc(open)}` : null, { workspace_id: ws });
  return (
    <>
      <LoadState value={v} onReload={reload}>{() => (
        <Table rows={listOf<Record<string, string>>(v, "trajectories")} rowKey={(t) => t.trajectory_id ?? t.id} onRowOpen={(t) => setOpen(t.trajectory_id ?? t.id)} empty={<p className="muted">没有轨迹。</p>}
          columns={[{ key: "id", label: "轨迹", render: (t) => <code>{t.trajectory_id ?? t.id}</code> }, { key: "task", label: "任务", render: (t) => t.task_id ?? "—" }, { key: "time", label: "时间", render: (t) => fmtTime(t.created_at) }]} />
      )}</LoadState>
      {open ? <Drawer title={`轨迹 ${open}`} onClose={() => setOpen(null)}><LoadState value={one}>{(d) => <JsonBlock value={d} />}</LoadState></Drawer> : null}
    </>
  );
}
