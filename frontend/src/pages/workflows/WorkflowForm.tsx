/**
 * 工作流定义表单。字段对齐后端 workflows/service.validate_definition：
 * name 必填；nodes ≥ 1，每个节点 node_id（字母数字 _ -，唯一）、tool_id（必须是已启用工具）、arguments（对象）、depends_on（只能依赖其他节点、不能成环）。
 * 上一轮的模板写的是 `steps`，后端只认 `nodes`，所以新建必然 400；这里改为真实结构。
 * 「高级：JSON」保留完整定义编辑；保存后 GET /api/workflows/<id> 回读，显示服务端算出的执行层次。
 */
import { useMemo, useState } from "react";
import { api, bodyOf, enc } from "../../api/client";
import { Button } from "../../components/Button";
import type { HttpOutcome } from "../../contracts/auth";
import { AdvancedJsonPanel, Field, FormError, ModeToggle, useAdvancedJson, type FieldErrors } from "../../kit/form";
import { listOf, useApi } from "../../kit/useApi";
import { Dialog, FailureNote } from "../../kit/ui";

export interface WfNode { node_id: string; name?: string; tool_id: string; arguments?: Record<string, unknown>; depends_on?: string[]; when?: unknown }
export interface WorkflowDef { workflow_id: string; name?: string; description?: string; status?: string; version?: number; nodes?: WfNode[]; execution_layers?: string[][]; updated_at?: string; template_id?: string }
type NodeDraft = { node_id: string; name: string; tool_id: string; args: string; depends_on: string[] };
type Draft = { name: string; description: string; status: string; nodes: NodeDraft[] };

const toDraft = (w?: WorkflowDef | null): Draft => ({
  name: w?.name ?? "", description: w?.description ?? "", status: w?.status ?? "active",
  nodes: (w?.nodes ?? []).map((n) => ({ node_id: n.node_id, name: n.name ?? "", tool_id: n.tool_id, args: JSON.stringify(n.arguments ?? {}, null, 2), depends_on: n.depends_on ?? [] })),
});
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function validateWorkflow(d: Draft, tools: Set<string>): { errors: FieldErrors; nodeErrors: Record<number, Partial<Record<"node_id" | "tool_id" | "args" | "depends_on", string>>> } {
  const errors: FieldErrors = {};
  const nodeErrors: Record<number, Partial<Record<"node_id" | "tool_id" | "args" | "depends_on", string>>> = {};
  if (!d.name.trim()) errors.name = "请填写工作流名称";
  if (!d.nodes.length) errors.nodes = "至少添加一个节点";
  const seen = new Set<string>();
  d.nodes.forEach((n, i) => {
    const e: (typeof nodeErrors)[number] = {};
    if (!ID_RE.test(n.node_id)) e.node_id = "节点 id 只能用字母、数字、_ 或 -";
    else if (seen.has(n.node_id)) e.node_id = "节点 id 重复";
    seen.add(n.node_id);
    if (!n.tool_id) e.tool_id = "请选择工具";
    else if (tools.size && !tools.has(n.tool_id)) e.tool_id = "该工具不存在或未启用";
    try { const v = JSON.parse(n.args || "{}"); if (!v || typeof v !== "object" || Array.isArray(v)) e.args = "参数必须是 JSON 对象 {…}"; } catch { e.args = "参数不是合法 JSON"; }
    if (n.depends_on.includes(n.node_id)) e.depends_on = "不能依赖自己";
    if (Object.keys(e).length) nodeErrors[i] = e;
  });
  const ids = new Set(d.nodes.map((n) => n.node_id));
  d.nodes.forEach((n, i) => { const missing = n.depends_on.filter((x) => !ids.has(x)); if (missing.length) nodeErrors[i] = { ...nodeErrors[i], depends_on: `依赖的节点不存在：${missing.join("、")}` }; });
  // 环检测（与后端 _execution_layers 同一算法）
  const deps = new Map(d.nodes.map((n) => [n.node_id, new Set(n.depends_on)]));
  while (deps.size) {
    const ready = [...deps].filter(([, r]) => ![...r].some((x) => deps.has(x))).map(([k]) => k);
    if (!ready.length) { errors.nodes = `依赖关系成环：${[...deps.keys()].join("、")}`; break; }
    ready.forEach((k) => deps.delete(k));
  }
  return { errors, nodeErrors };
}

export const workflowBody = (d: Draft, workflowId?: string): Record<string, unknown> => ({
  ...(workflowId ? { workflow_id: workflowId } : {}), name: d.name.trim(), description: d.description.trim(), status: d.status,
  nodes: d.nodes.map((n) => ({ node_id: n.node_id, name: n.name || n.node_id, tool_id: n.tool_id, arguments: (() => { try { return JSON.parse(n.args || "{}"); } catch { return n.args; } })(), depends_on: n.depends_on })),
});

const SERVER_ERRORS: [RegExp, string, string][] = [
  [/workflow name is required/, "name", "请填写工作流名称"],
  [/must contain 1 to/, "nodes", "节点数量不在允许范围内（至少 1 个）"],
  [/unknown or disabled workflow tool: ?(.*)/, "nodes", "有节点使用了不存在或未启用的工具"],
  [/duplicate workflow node/, "nodes", "节点 id 重复"],
  [/invalid dependencies|cycle|references nodes outside/, "nodes", "节点依赖不合法（依赖不存在、成环，或参数引用了非上游节点）"],
  [/static secret/, "nodes", "节点参数里不能写明文密钥，请改用密钥引用"],
  [/status must be/, "status", "状态只能是草稿 / 启用 / 归档"],
];

export function WorkflowFormDialog({ ws, workflow, onClose, onSaved }: { ws: string; workflow?: WorkflowDef | null; onClose: () => void; onSaved: (r: { readback: WorkflowDef | null; outcome: HttpOutcome }) => void }) {
  const [catalog] = useApi("/api/tools/catalog", { workspace_id: ws });
  const tools = useMemo(() => listOf<{ tool_id: string; display_name?: string; enabled?: boolean; category?: string }>(catalog, "tools").filter((t) => t.enabled !== false), [catalog]);
  const toolIds = useMemo(() => new Set(tools.map((t) => t.tool_id)), [tools]);
  const [d, setD] = useState<Draft>(toDraft(workflow));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [nodeErrors, setNodeErrors] = useState<ReturnType<typeof validateWorkflow>["nodeErrors"]>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<HttpOutcome | null>(null);
  const fromJson = (v: Record<string, unknown>): Draft | string => {
    if (v.nodes !== undefined && !Array.isArray(v.nodes)) return "nodes 必须是数组";
    return toDraft(v as unknown as WorkflowDef);
  };
  const adv = useAdvancedJson(() => workflowBody(d, workflow?.workflow_id), (v) => { const r = fromJson(v); if (typeof r === "string") return r; setD(r); return r; });
  const setNode = (i: number, patch: Partial<NodeDraft>) => { setD({ ...d, nodes: d.nodes.map((n, j) => (j === i ? { ...n, ...patch } : n)) }); setNodeErrors({ ...nodeErrors, [i]: {} }); };
  const save = async () => {
    let draft = d;
    if (adv.mode === "json") {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(adv.text || "{}"); } catch (e) { adv.setError(`JSON 格式不正确：${(e as Error).message}`); return; }
      const r = fromJson(parsed); if (typeof r === "string") { adv.setError(r); return; }
      draft = r;
    }
    const v = validateWorkflow(draft, toolIds);
    setErrors(v.errors); setNodeErrors(v.nodeErrors);
    if (Object.keys(v.errors).length || Object.keys(v.nodeErrors).length) return;
    setBusy(true); setFailure(null);
    const body = { ...workflowBody(draft, workflow?.workflow_id), workspace_id: ws };
    const o = workflow ? await api.put(`/api/workflows/${enc(workflow.workflow_id)}`, body, { workspace_id: ws }) : await api.post("/api/workflows", body);
    if (o.kind !== "http" || o.status >= 300) {
      setBusy(false); setFailure(o);
      const raw = o.kind === "http" ? String((o.body as { error?: string })?.error ?? "") : "";
      const hit = SERVER_ERRORS.find(([re]) => re.test(raw));
      setErrors(hit ? { [hit[1]]: `${hit[2]}（${raw}）` } : { _form: raw ? `保存失败：${raw}` : "保存失败" });
      return;
    }
    const id = bodyOf<{ workflow?: WorkflowDef }>(o)?.workflow?.workflow_id ?? workflow?.workflow_id;
    const back = id ? await api.get(`/api/workflows/${enc(id)}`, { workspace_id: ws }) : null;
    setBusy(false);
    onSaved({ readback: back && back.kind === "http" && back.status === 200 ? (bodyOf<{ workflow?: WorkflowDef }>(back)?.workflow ?? null) : null, outcome: o });
  };
  return (
    <Dialog wide title={workflow ? `编辑工作流 · ${workflow.name ?? workflow.workflow_id}` : "新建工作流"} onClose={onClose} testId="workflow-form"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={busy} onClick={() => void save()} data-testid="workflow-save">{busy ? "保存中…" : "保存并回读"}</Button></>}>
      <div className="form-head"><p className="form-hint">工作流是工具节点组成的有向无环图；失败节点不会中止独立分支。参数里可用 <code>{"${nodes.<上游节点>.…}"}</code> 引用上游结果。</p><ModeToggle mode={adv.mode} onToggle={adv.toggle} /></div>
      <FormError text={errors._form} />
      {adv.mode === "json" ? <AdvancedJsonPanel text={adv.text} onChange={adv.setText} error={adv.error} note="完整定义（POST/PUT /api/workflows）：name、description、status、nodes[]。" /> : (
        <div className="form-grid">
          <Field label="名称" required error={errors.name}>{(a) => <input {...a} value={d.name} onChange={(e) => { setD({ ...d, name: e.target.value }); setErrors({ ...errors, name: undefined }); }} data-testid="workflow-name" />}</Field>
          <Field label="状态" error={errors.status}>{(a) => <select {...a} value={d.status} onChange={(e) => setD({ ...d, status: e.target.value })} data-testid="workflow-status"><option value="active">启用</option><option value="draft">草稿</option><option value="archived">归档</option></select>}</Field>
          <Field full label="说明（可选）">{(a) => <input {...a} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />}</Field>
          <Field full label={`节点（${d.nodes.length}）`} required error={errors.nodes}>{(a) => (
            <div className="wf-nodes" id={a.id} data-testid="workflow-nodes">
              {d.nodes.map((n, i) => {
                const ne = nodeErrors[i] ?? {};
                return (
                  <fieldset key={i} className="wf-node" data-testid="workflow-node">
                    <legend>节点 {i + 1}</legend>
                    <div className="form-grid">
                      <Field label="节点 id" required error={ne.node_id}>{(b) => <input {...b} value={n.node_id} onChange={(e) => setNode(i, { node_id: e.target.value })} data-testid="wf-node-id" />}</Field>
                      <Field label="显示名">{(b) => <input {...b} value={n.name} onChange={(e) => setNode(i, { name: e.target.value })} />}</Field>
                      <Field full label="工具" required error={ne.tool_id}>{(b) => <select {...b} value={n.tool_id} onChange={(e) => setNode(i, { tool_id: e.target.value })} data-testid="wf-node-tool"><option value="">选择工具</option>{tools.map((t) => <option key={t.tool_id} value={t.tool_id}>{t.display_name ? `${t.display_name}（${t.tool_id}）` : t.tool_id}</option>)}</select>}</Field>
                      <Field full label="依赖（先执行）" error={ne.depends_on}>{(b) => (
                        <div className="form-checks" id={b.id}>{d.nodes.filter((_, j) => j !== i).map((o) => o.node_id).filter(Boolean).map((id) => <label key={id}><input type="checkbox" checked={n.depends_on.includes(id)} onChange={(e) => setNode(i, { depends_on: e.target.checked ? [...n.depends_on, id] : n.depends_on.filter((x) => x !== id) })} /> {id}</label>)}{d.nodes.length < 2 ? <span className="muted">无其他节点</span> : null}</div>
                      )}</Field>
                      <Field full label="参数（JSON 对象）" error={ne.args}>{(b) => <textarea {...b} rows={3} value={n.args} onChange={(e) => setNode(i, { args: e.target.value })} data-testid="wf-node-args" />}</Field>
                    </div>
                    <Button variant="ghost" className="sm" onClick={() => setD({ ...d, nodes: d.nodes.filter((_, j) => j !== i).map((x) => ({ ...x, depends_on: x.depends_on.filter((y) => y !== n.node_id) })) })}>删除节点</Button>
                  </fieldset>
                );
              })}
              <Button className="sm" onClick={() => { setD({ ...d, nodes: [...d.nodes, { node_id: `node_${d.nodes.length + 1}`, name: "", tool_id: "", args: "{}", depends_on: d.nodes.length ? [d.nodes[d.nodes.length - 1].node_id] : [] }] }); setErrors({ ...errors, nodes: undefined }); }} data-testid="workflow-add-node">添加节点</Button>
            </div>
          )}</Field>
        </div>
      )}
      {failure && !Object.keys(errors).length ? <FailureNote outcome={failure} /> : null}
    </Dialog>
  );
}
