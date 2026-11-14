/**
 * 按工具的 input_schema（JSON Schema 子集）生成参数表单，让用户点选 / 填写，而不是手写 JSON。
 * - enum → 下拉；boolean → 是 / 否 / 不填；integer / number → 数字框；string → 文本框；
 * - 字符串数组 → 每行一项；其余复杂结构（对象、oneOf、对象数组）才退回这一项的 JSON 小框。
 * 必填项、action 和已经有值的参数放在前面，其余收在「更多参数」里。
 * 值为空即不写入（不往请求里塞空字符串）；schema 之外已有的键原样保留。
 */
import { useId, useState } from "react";

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

/** 常见参数名的中文标签；没收录的显示原名。 */
const LABELS: Record<string, string> = {
  action: "操作", query: "搜索内容", url: "网址", path: "路径", filepath: "文件路径", content: "内容", text: "文本", title: "标题",
  name: "名称", description: "说明", command: "命令", cwd: "工作目录", timeout: "超时（秒）", max_results: "最多结果数", top_k: "取前几条",
  location: "地点", locations: "地点列表", days: "天数", language: "语言", domains: "限定域名", allowed_domains: "允许的域名", blocked_domains: "排除的域名",
  depth: "深度", source: "来源", recency: "时间范围", site: "站点", vendor: "厂商", units: "单位", seconds: "秒数", review: "检查内容",
  memory_id: "记忆 ID", tags: "标签", scope: "范围", format: "格式", limit: "数量上限", offset: "起始位置", device_id: "设备", device_ids: "设备",
  summary: "摘要", authority_profile: "来源类型", extract_mode: "提取方式", latitude: "纬度", longitude: "经度", safe_search: "安全搜索", max_length: "最大长度", file_id: "文件", filename: "文件名", encoding: "编码", pattern: "匹配规则", mode: "模式", id: "ID", key: "键", value: "值",
};
export const paramLabel = (k: string) => LABELS[k] ?? k;

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
export function schemaProblem(schema: JsonSchema | undefined, value: Record<string, unknown>): string | null {
  if (!schema?.properties) return null;
  for (const k of schema.required ?? []) if (isEmpty(value[k])) return `请填写「${paramLabel(k)}」`;
  for (const [k, s] of Object.entries(schema.properties)) {
    const v = value[k];
    if (isEmpty(v) || typeof v !== "number") continue;
    if (s.minimum !== undefined && v < s.minimum) return `「${paramLabel(k)}」不能小于 ${s.minimum}`;
    if (s.maximum !== undefined && v > s.maximum) return `「${paramLabel(k)}」不能大于 ${s.maximum}`;
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

function ParamField({ name, schema, value, required, onChange }: { name: string; schema: JsonSchema; value: unknown; required: boolean; onChange: (v: unknown) => void }) {
  const id = useId();
  const kind = kindOf(schema);
  const label = paramLabel(name);
  const ref = typeof value === "string" && /\$\{[^}]+\}/.test(value);
  let control;
  if (kind === "enum" && !ref) {
    control = (
      <select id={id} value={value === undefined ? "" : String(value)} onChange={(e) => {
        const raw = e.target.value; const hit = schema.enum!.find((x) => String(x) === raw); onChange(raw === "" ? undefined : hit);
      }} data-param={name}>
        <option value="">{required ? "请选择" : "不填（用默认）"}</option>
        {schema.enum!.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
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
  const range = schema.minimum !== undefined || schema.maximum !== undefined ? `范围 ${schema.minimum ?? "…"} – ${schema.maximum ?? "…"}` : "";
  const hint = [schema.description, range, kind === "json" ? "这一项结构较复杂，用 JSON 填写。" : ""].filter(Boolean).join(" ");
  return (
    <div className="form-field schema-field">
      <label htmlFor={id}>{label}{label !== name ? <span className="schema-key">{name}</span> : null}{required ? <span className="req" aria-hidden="true"> *</span> : null}</label>
      {control}
      {hint ? <p className="form-hint">{hint}</p> : null}
    </div>
  );
}

export function SchemaFields({ schema, value, onChange, testId }: { schema: JsonSchema; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; testId?: string }) {
  const props = Object.entries(schema.properties ?? {}).filter(([k]) => !HIDDEN.has(k));
  const required = new Set(schema.required ?? []);
  const primary = props.filter(([k]) => required.has(k) || k === "action" || !isEmpty(value[k]));
  const rest = props.filter((p) => !primary.includes(p));
  const set = (k: string, v: unknown) => {
    const next = { ...value };
    if (isEmpty(v)) delete next[k]; else next[k] = v;
    onChange(next);
  };
  const field = ([k, s]: [string, JsonSchema]) => <ParamField key={k} name={k} schema={s} value={value[k]} required={required.has(k)} onChange={(v) => set(k, v)} />;
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
