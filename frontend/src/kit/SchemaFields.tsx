/**
 * 按工具的 input_schema（JSON Schema 子集）生成参数表单，让用户点选 / 填写，而不是手写 JSON。
 * - enum → 下拉；boolean → 是 / 否 / 不填；integer / number → 数字框；string → 文本框；
 * - 字符串数组 → 每行一项；其余复杂结构（对象、oneOf、对象数组）才退回这一项的 JSON 小框。
 * 必填项、action 和已经有值的参数放在前面，其余收在「更多参数」里。
 * 值为空即不写入（不往请求里塞空字符串）；schema 之外已有的键原样保留。
 */
import { useId, useState } from "react";
import docs from "./toolParamDocs.zh.json";

export interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  description?: string;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  oneOf?: unknown[];
  anyOf?: unknown[];
}

const HIDDEN = new Set(["workspace_id"]);

/**
 * 中文名称、说明与选项来自 toolParamDocs.zh.json。后端 schema 的英文 description 是写给模型的，界面不显示；
 * 没有中文说明的参数就不显示说明，未收录的名称 / 选项原样显示。
 */
type ParamDoc = { label?: string; hint?: string };
type ToolDoc = { label?: string; params?: Record<string, ParamDoc>; options?: Record<string, Record<string, string>> };
const DOCS = docs as unknown as { labels: Record<string, string>; tools: Record<string, ToolDoc> };
export const paramLabel = (k: string, toolId?: string) => (toolId && DOCS.tools[toolId]?.params?.[k]?.label) || DOCS.labels[k] || k;
export const paramHint = (k: string, toolId?: string) => (toolId && DOCS.tools[toolId]?.params?.[k]?.hint) || "";
export const optionLabel = (k: string, v: unknown, toolId?: string) => (toolId && DOCS.tools[toolId]?.options?.[k]?.[String(v)]) || String(v);
/** 工具下拉里的名字：中文名为主，原 id 放括号里便于对照。 */
export const toolLabel = (toolId: string, displayName?: string) => {
  const zh = DOCS.tools[toolId]?.label || displayName;
  return zh ? `${zh}（${toolId}）` : toolId;
};

type Kind = "enum" | "bool" | "number" | "string" | "lines" | "json";
function kindOf(s: JsonSchema): Kind {
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== "null") : s.type;
  if (s.enum?.length && s.enum.every((v) => typeof v === "string" || typeof v === "number")) return "enum";
  if (s.oneOf || s.anyOf) return "json";
  if (t === "boolean") return "bool";
  if (t === "integer" || t === "number") return "number";
  if (t === "string" || (!t && !s.properties && !s.items)) return "string";
  if (t === "array" && s.items && (s.items.type === "string" || s.items.type === "number" || s.items.type === "integer") && !s.items.enum) return "lines";
  return "json";
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** 按 schema 校验当前值，返回第一处问题（中文）；没问题返回 null。 */
export function schemaProblem(schema: JsonSchema | undefined, value: Record<string, unknown>, toolId?: string): string | null {
  if (!schema?.properties) return null;
  for (const k of schema.required ?? []) if (isEmpty(value[k])) return `请填写「${paramLabel(k, toolId)}」`;
  for (const [k, s] of Object.entries(schema.properties)) {
    const v = value[k];
    if (isEmpty(v) || typeof v !== "number") continue;
    if (s.minimum !== undefined && v < s.minimum) return `「${paramLabel(k, toolId)}」不能小于 ${s.minimum}`;
    if (s.maximum !== undefined && v > s.maximum) return `「${paramLabel(k, toolId)}」不能大于 ${s.maximum}`;
  }
  return null;
}

/** schema 能不能用表单表达：有 properties 就行（复杂字段单独退回 JSON 小框）。 */
export const schemaUsable = (s?: JsonSchema | null): s is JsonSchema => !!s && !!s.properties && Object.keys(s.properties).length > 0;

function JsonCell({ id, value, onChange }: { id: string; value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(() => (isEmpty(value) ? "" : JSON.stringify(value, null, 2)));
  const [bad, setBad] = useState(false);
  return (
    <>
      <textarea id={id} className="code-input" rows={3} value={text} spellCheck={false}
        onChange={(e) => {
          const t = e.target.value; setText(t);
          if (!t.trim()) { setBad(false); onChange(undefined); return; }
          try { onChange(JSON.parse(t)); setBad(false); } catch { setBad(true); }
        }} />
      {bad ? <p className="form-error" role="alert">这一项需要合法的 JSON。</p> : null}
    </>
  );
}

function ParamField({ name, schema, value, required, onChange, toolId }: { name: string; schema: JsonSchema; value: unknown; required: boolean; onChange: (v: unknown) => void; toolId?: string }) {
  const id = useId();
  const kind = kindOf(schema);
  const label = paramLabel(name, toolId);
  const ref = typeof value === "string" && /\$\{[^}]+\}/.test(value);
  let control;
  if (kind === "enum" && !ref) {
    control = (
      <select id={id} value={value === undefined ? "" : String(value)} onChange={(e) => {
        const raw = e.target.value; const hit = schema.enum!.find((x) => String(x) === raw); onChange(raw === "" ? undefined : hit);
      }} data-param={name}>
        <option value="">{required ? "请选择" : "不填（用默认）"}</option>
        {schema.enum!.map((o) => <option key={String(o)} value={String(o)}>{optionLabel(name, o, toolId)}</option>)}
      </select>
    );
  } else if (kind === "bool" && !ref) {
    control = (
      <select id={id} value={value === true ? "true" : value === false ? "false" : ""} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "true")} data-param={name}>
        <option value="">不填（用默认）</option><option value="true">是</option><option value="false">否</option>
      </select>
    );
  } else if (kind === "number" && !ref) {
    control = <input id={id} type="number" inputMode="decimal" min={schema.minimum} max={schema.maximum} step={(Array.isArray(schema.type) ? schema.type.includes("integer") : schema.type === "integer") ? 1 : "any"}
      value={typeof value === "number" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} data-param={name} />;
  } else if (kind === "lines") {
    const items = Array.isArray(value) ? value : [];
    control = <textarea id={id} className="is-prose schema-lines" rows={Math.min(5, Math.max(2, items.length + 1))} value={items.join("\n")} placeholder="每行一项"
      onChange={(e) => { const list = e.target.value.split("\n").map((x) => x.trim()).filter(Boolean); const num = schema.items?.type !== "string"; onChange(list.length ? (num ? list.map(Number) : list) : undefined); }} data-param={name} />;
  } else if (kind === "json") {
    control = <JsonCell id={id} value={value} onChange={onChange} />;
  } else {
    control = <input id={id} value={value === undefined || value === null ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} data-param={name} />;
  }
  const range = schema.minimum !== undefined || schema.maximum !== undefined ? `范围 ${schema.minimum ?? "…"} – ${schema.maximum ?? "…"}。` : "";
  const hint = [paramHint(name, toolId), range, kind === "json" ? "这一项结构较复杂，用 JSON 填写。" : ""].filter(Boolean).join(" ");
  return (
    <div className="form-field schema-field">
      <label htmlFor={id}>{label}{label !== name ? <span className="schema-key">{name}</span> : null}{required ? <span className="req" aria-hidden="true"> *</span> : null}</label>
      {control}
      {hint ? <p className="form-hint">{hint}</p> : null}
    </div>
  );
}

export function SchemaFields({ schema, value, onChange, testId, toolId }: { schema: JsonSchema; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; testId?: string; toolId?: string }) {
  const props = Object.entries(schema.properties ?? {}).filter(([k]) => !HIDDEN.has(k));
  const required = new Set(schema.required ?? []);
  const primary = props.filter(([k]) => required.has(k) || k === "action" || !isEmpty(value[k]));
  const rest = props.filter((p) => !primary.includes(p));
  const set = (k: string, v: unknown) => {
    const next = { ...value };
    if (isEmpty(v)) delete next[k]; else next[k] = v;
    onChange(next);
  };
  const field = ([k, s]: [string, JsonSchema]) => <ParamField key={k} name={k} schema={s} value={value[k]} required={required.has(k)} onChange={(v) => set(k, v)} toolId={toolId} />;
  return (
    <div className="schema-fields" data-testid={testId}>
      {primary.length ? <div className="schema-grid">{primary.map(field)}</div> : <p className="muted">这个工具没有必填参数。</p>}
      {rest.length ? (
        <details className="schema-more">
          <summary>更多参数（{rest.length}）</summary>
          <div className="schema-grid">{rest.map(field)}</div>
        </details>
      ) : null}
    </div>
  );
}

/** 找出工作流节点参数里引用的 `${input.名字…}`，按出现顺序去重。 */
export function workflowInputNames(nodes: { arguments?: unknown; when?: unknown }[] | undefined): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\$\{\s*input\.([A-Za-z0-9_-]+)/g)) if (!out.includes(m[1])) out.push(m[1]);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  (nodes ?? []).forEach((n) => { walk(n.arguments); walk(n.when); });
  return out;
}
