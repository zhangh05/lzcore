/**
 * 把后端对象读成「中文状态 + 摘要」：顶层标量按中文标签逐项列出（未登记的键保留原名，不丢字段），
 * 嵌套对象 / 数组只给条数，完整原文折叠在「诊断原文」里。只做展示翻译，不改写、不推断数值。
 */
import type { ReactNode } from "react";
import { KeyValues, RawData, fmtTime } from "./ui";
import { FIELD_ZH, VALUE_ZH } from "./fieldLabels";
export { FIELD_ZH, VALUE_ZH };

const isTime = (k: string) => /(_at|^at)$/.test(k);
function valueText(k: string, v: unknown): ReactNode {
  if (v === null || v === undefined || v === "") return <span className="muted">未上报</span>;
  if (typeof v === "boolean") return VALUE_ZH[String(v)];
  if (typeof v === "string" && isTime(k)) return fmtTime(v);
  if (typeof v === "string" || typeof v === "number") {
    const zh = VALUE_ZH[String(v)];
    return zh && typeof v === "string" ? `${zh}（${v}）` : String(v);
  }
  if (Array.isArray(v)) return v.length ? `${v.length} 项（见诊断原文）` : "无";
  return `${Object.keys(v as object).length} 个字段（见诊断原文）`;
}
export const fieldLabel = (k: string) => FIELD_ZH[k] ?? k;

export function FactSummary({ value, title, rawLabel = "诊断原文", testId, order }: { value: unknown; title?: string; rawLabel?: string; testId?: string; order?: string[] }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return <div data-testid={testId}>{title ? <h4>{title}</h4> : null}<p>{Array.isArray(value) ? `${value.length} 项` : String(value ?? "未上报")}</p><RawData value={value} label={rawLabel} /></div>;
  }
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o);
  const sorted = order ? [...order.filter((k) => k in o), ...keys.filter((k) => !order.includes(k))] : keys;
  return (
    <div className="fact-summary" data-testid={testId}>
      {title ? <h4>{title}</h4> : null}
      <KeyValues items={sorted.map((k) => [fieldLabel(k), valueText(k, o[k])] as [string, ReactNode])} />
      <RawData value={value} label={rawLabel} />
    </div>
  );
}
