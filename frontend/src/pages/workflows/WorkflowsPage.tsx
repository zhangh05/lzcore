import { useState } from "react";
import { api, bodyOf, enc } from "../../api/client";
import { useShell, withWorkspace } from "../../app/shellContext";
import { Button } from "../../components/Button";
import { PageHeader } from "../../components/EmptyState";
import type { HttpOutcome } from "../../contracts/auth";
import { NAMES } from "../../contracts/naming";
import { listOf, useApi } from "../../kit/useApi";
import { Chip, ConfirmDialog, Dialog, Drawer, FailureNote, KeyValues, LoadState, RawData, ReceiptNote, Table, Tabs, fmtTime, useUrlTab } from "../../kit/ui";
import { Link, useSearchParams } from "../../router";
import { WorkflowFormDialog, type WorkflowDef } from "./WorkflowForm";
import { FactSummary } from "../../kit/factSummary";

type Workflow = WorkflowDef;
interface WfNodeResult { node_id: string; tool_id?: string; status?: string; summary?: string; output?: unknown; errors?: string[]; duration_ms?: number }
interface WfRun { run_id: string; workflow_id?: string; status?: string; task_id?: string; job_id?: string; session_id?: string; nodes?: WfNodeResult[]; started_at?: string; finished_at?: string; error?: string }

const RUN_STATUS_LABEL: Record<string, string> = { queued: "已入队", running: "运行中", succeeded: "运行已结束", failed: "运行报错", cancelled: "已取消", cancel_requested: "已请求取消 · 等待终态" };
const NODE_STATUS_LABEL: Record<string, string> = { succeeded: "工具执行成功", dry_run: "演练完成", failed: "执行失败", skipped: "已跳过", cancelled: "已取消", running: "执行中", execution_unknown: "执行结果未知" };

function Result({ r }: { r: { label: string; o: HttpOutcome } | null }) {
  if (!r) return null;
  return r.o.kind === "http" && r.o.status < 300 ? <ReceiptNote text={`${r.label}已提交`} /> : <FailureNote outcome={r.o} />;
}

/** 工作流独立界面：工作流（CRUD + 运行入队）、模板（实例化）、运行（详情 + 取消，链到任务）。 */
export function WorkflowsPage() {
  const { workspaceId: ws } = useShell();
  const [tab, setTab] = useUrlTab(["workflows", "templates", "runs"] as const, "workflows");
  const [params, setParams] = useSearchParams();
  const openRun = params.get("run");
  const setRun = (id: string | null) => { const n = new URLSearchParams(params); if (id) n.set("run", id); else n.delete("run"); setParams(n); };
  if (!ws) return null;
  return (
    <div className="page" data-testid="workflows-page">
      <PageHeader title={NAMES.workflows} subtitle="把多个步骤编排成可重复运行的流程。" />
      <Tabs label="工作流" current={tab} onChange={setTab} tabs={[{ key: "workflows", label: "工作流" }, { key: "templates", label: "模板" }, { key: "runs", label: "运行" }]} />
      {tab === "workflows" ? <WorkflowList ws={ws} onRun={setRun} /> : null}
      {tab === "templates" ? <Templates ws={ws} /> : null}
      {tab === "runs" ? <RunsList ws={ws} onOpen={setRun} /> : null}
      {openRun ? <RunDetail ws={ws} runId={openRun} onClose={() => setRun(null)} /> : null}
    </div>
  );
}

function WorkflowList({ ws }: { ws: string; onRun: (id: string) => void }) {
  const [list, reload] = useApi("/api/workflows", { workspace_id: ws });
  const [edit, setEdit] = useState<WorkflowDef | "new" | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [del, setDel] = useState<Workflow | null>(null);
  const [run, setRun] = useState<Workflow | null>(null);
  const [inputs, setInputs] = useState("{}");
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  return (
    <>
      <div className="row-actions"><Button variant="primary" onClick={() => setEdit("new")} data-testid="workflow-new">新建工作流</Button></div>
      {saved ? <p className="readback-note" role="status" data-testid="workflow-readback">{saved}</p> : null}
      <Result r={r} />
      {r && r.o.kind === "http" && r.o.status === 202 ? <p className="muted">已入队的作业：<code>{String(bodyOf<{ job?: { job_id?: string } }>(r.o)?.job?.job_id ?? "未返回")}</code>，可在「{NAMES.tasks}」的作业队列中查看。</p> : null}
      <LoadState value={list} onReload={reload}>{() => (
        <Table testId="workflows-table" rows={listOf<Workflow>(list, "workflows")} rowKey={(w) => w.workflow_id} empty={<p className="muted">还没有工作流，可以从「模板」实例化一个。</p>}
          columns={[
            { key: "n", label: "工作流", render: (w) => w.name ?? w.workflow_id },
            { key: "s", label: "节点 / 层次", render: (w) => `${w.nodes?.length ?? 0} 个节点 · ${w.execution_layers?.length ?? "?"} 层` },
            { key: "st", label: "状态", render: (w) => <Chip tone={w.status === "active" ? "ok" : "neutral"}>{w.status === "active" ? "启用" : w.status === "draft" ? "草稿" : w.status ?? "未上报"}</Chip> },
            { key: "t", label: "更新", render: (w) => fmtTime(w.updated_at) },
            { key: "a", label: "", render: (w) => <span className="row-actions">
              <Button onClick={() => { setRun(w); setInputs("{}"); }}>运行</Button>
              <Button onClick={async () => { const o = await api.get(`/api/workflows/${enc(w.workflow_id)}`, { workspace_id: ws }); setEdit(bodyOf<{ workflow?: WorkflowDef }>(o)?.workflow ?? w); }}>编辑</Button>
              <Button variant="ghost" onClick={() => setDel(w)}>删除</Button></span> },
          ]} />
      )}</LoadState>
      {edit ? <WorkflowFormDialog ws={ws} workflow={edit === "new" ? null : edit} onClose={() => setEdit(null)}
        onSaved={({ readback }) => { setEdit(null); setSaved(readback ? `已保存并回读：「${readback.name}」v${readback.version ?? 1} · ${readback.nodes?.length ?? 0} 个节点 · 执行层次 ${(readback.execution_layers ?? []).map((l) => l.join("+")).join(" → ") || "未上报"}` : "已保存；回读失败，请刷新列表核对。"); reload(); }} /> : null}
      {run ? <Dialog title={`运行 ${run.name ?? run.workflow_id}`} onClose={() => setRun(null)} footer={<>
        <Button onClick={() => setRun(null)}>取消</Button>
        <Button variant="primary" onClick={async () => {
          let parsed: unknown; try { parsed = JSON.parse(inputs); } catch { setJsonError("输入 JSON 格式不正确"); return; }
          setJsonError(null); const w = run; setRun(null);
          setR({ label: "运行入队", o: await api.post(`/api/workflows/${enc(w.workflow_id)}/runs`, { workspace_id: ws, inputs: parsed, enqueue: true }, { workspace_id: ws }) });
        }}>入队运行</Button></>}>
        <p className="muted">以作业方式入队（enqueue），不在请求里同步执行。</p>
        <label className="field"><span>输入（JSON）</span><textarea rows={6} value={inputs} onChange={(e) => setInputs(e.target.value)} /></label>
        {jsonError ? <p className="form-error" role="alert">{jsonError}</p> : null}
      </Dialog> : null}
      {del ? <ConfirmDialog title="删除工作流？" details={<p>将删除「{del.name ?? del.workflow_id}」。已有运行记录保留。</p>} confirmText={del.workflow_id} confirmLabel="删除"
        onCancel={() => setDel(null)} onConfirm={async () => { const w = del; setDel(null); setR({ label: "删除", o: await api.del(`/api/workflows/${enc(w.workflow_id)}`, { workspace_id: ws, confirm: "delete" }, { workspace_id: ws }) }); reload(); }} /> : null}
    </>
  );
}

function Templates({ ws }: { ws: string }) {
  const [list, reload] = useApi("/api/workflow-templates");
  const [inst, setInst] = useState<{ template_id: string; name: string } | null>(null);
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  return (
    <>
      <Result r={r} />
      <LoadState value={list} onReload={reload}>{() => (
        <Table testId="templates-table" rows={listOf<{ template_id: string; name?: string; description?: string }>(list, "templates")} rowKey={(t) => t.template_id}
          columns={[{ key: "n", label: "模板", render: (t) => t.name ?? t.template_id }, { key: "d", label: "说明", render: (t) => t.description ?? "—" },
            { key: "a", label: "", render: (t) => <Button onClick={() => setInst({ template_id: t.template_id, name: t.name ?? "" })} data-testid="instantiate">实例化</Button> }]} />
      )}</LoadState>
      {inst ? <Dialog title="从模板实例化" onClose={() => setInst(null)} footer={<><Button onClick={() => setInst(null)}>取消</Button>
        <Button variant="primary" onClick={async () => { const x = inst; setInst(null); setR({ label: "实例化", o: await api.post(`/api/workflow-templates/${enc(x.template_id)}/instantiate`, { workspace_id: ws, name: x.name }) }); }}>创建</Button></>}>
        <label className="field"><span>名称</span><input value={inst.name} onChange={(e) => setInst({ ...inst, name: e.target.value })} /></label>
      </Dialog> : null}
    </>
  );
}

function RunsList({ ws, onOpen }: { ws: string; onOpen: (id: string) => void }) {
  const [wfs] = useApi("/api/workflows", { workspace_id: ws });
  const [wf, setWf] = useState("");
  const list = listOf<Workflow>(wfs, "workflows");
  const current = wf || list[0]?.workflow_id || "";
  const [runs, reload] = useApi(current ? `/api/workflows/${enc(current)}/runs` : null, { workspace_id: ws });
  return (
    <>
      <label className="field-inline">工作流 <select value={current} onChange={(e) => setWf(e.target.value)} aria-label="选择工作流">{list.map((w) => <option key={w.workflow_id} value={w.workflow_id}>{w.name ?? w.workflow_id}</option>)}</select></label>
      {!current ? <p className="muted">还没有工作流。</p> : (
        <LoadState value={runs} onReload={reload}>{() => (
          <Table testId="wf-runs-table" rows={listOf<WfRun>(runs, "runs")} rowKey={(r) => r.run_id} onRowOpen={(r) => onOpen(r.run_id)} empty={<p className="muted">没有运行记录。</p>}
            columns={[{ key: "id", label: "运行", render: (r) => <code>{r.run_id}</code> }, { key: "s", label: "状态", render: (r) => <Chip>{RUN_STATUS_LABEL[r.status ?? ""] ?? r.status ?? "未上报"}</Chip> }, { key: "t", label: "开始时间", render: (r) => fmtTime(r.started_at) }]} />
        )}</LoadState>
      )}
    </>
  );
}

function RunDetail({ ws, runId, onClose }: { ws: string; runId: string; onClose: () => void }) {
  const [run, reload] = useApi(`/api/workflow-runs/${enc(runId)}`, { workspace_id: ws });
  const [confirm, setConfirm] = useState(false);
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  const data = run.state === "ok" ? (run.data as { run?: WfRun }).run : undefined;
  return (
    <Drawer title={`工作流运行 ${runId}`} onClose={onClose} testId="wf-run-detail">
      <LoadState value={run} onReload={reload}>{() => data ? (
        <>
          <KeyValues items={[["状态", RUN_STATUS_LABEL[data.status ?? ""] ?? data.status ?? "未上报"], ["工作流", data.workflow_id], ["开始时间", fmtTime(data.started_at)], ["结束时间", fmtTime(data.finished_at)], ["错误", data.error]]} />
          <div className="row-actions">
            {data.task_id ? <Link className="btn" to={withWorkspace(`/tasks?task=${enc(data.task_id)}`, ws)} data-testid="run-task-link">查看关联任务</Link> : <span className="muted">运行未关联运行时任务。</span>}
            {data.session_id ? <Link className="btn" to={withWorkspace(`/workbench?session=${enc(data.session_id)}`, ws)}>打开会话</Link> : null}
            {data.status === "running" || data.status === "queued" ? <Button variant="danger" onClick={() => setConfirm(true)}>请求取消</Button> : null}
          </div>
          <Result r={r} />
          <h3>步骤</h3>
          {data.nodes?.length ? <ol className="stage-list">{data.nodes.map((s) => <li key={s.node_id}>
            <strong>{s.node_id}</strong> <Chip>{NODE_STATUS_LABEL[s.status ?? ""] ?? s.status ?? "未上报"}</Chip>
            <KeyValues items={[["工具", s.tool_id], ["耗时", s.duration_ms === undefined ? "未上报" : `${s.duration_ms} ms`]]} />
            {s.summary ? <p>{s.summary}</p> : null}
            {s.errors?.length ? <ul className="form-error">{s.errors.map((error, i) => <li key={i}>{error}</li>)}</ul> : null}
            {s.output !== undefined ? <FactSummary value={s.output} title="节点输出" rawLabel="节点输出诊断原文" /> : null}
          </li>)}</ol> : <p className="muted">尚无节点执行记录。</p>}
          <RawData value={data} label="运行记录诊断原文" />
        </>
      ) : <p className="muted">运行不存在。</p>}</LoadState>
      {confirm ? <ConfirmDialog title="取消这次运行？" details={<p>已执行的步骤不会回滚。</p>} confirmLabel="请求取消" onCancel={() => setConfirm(false)}
        onConfirm={async () => { setConfirm(false); setR({ label: "取消请求", o: await api.post(`/api/workflow-runs/${enc(runId)}/cancel`, { workspace_id: ws }) }); reload(); }} /> : null}
    </Drawer>
  );
}
