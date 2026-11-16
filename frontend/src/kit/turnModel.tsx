/**
 * 本轮用哪个模型：列出全部已接入的服务（有模型，且有密钥或是本机服务），直接选；
 * 没选过时用列表第一个（系统默认）。接口不可用时整组隐藏。工作台输入框与拓扑绘图助手共用。
 */
import { useState } from "react";
import { useApi, listOf } from "./useApi";

export type ThinkingMode = "provider_default" | "adaptive" | "disabled";
export interface ModelSelection { provider: string; thinking: ThinkingMode }
export interface TurnModel { provider: string; label: string; model: string; is_active: boolean; supports_thinking: boolean; requires_thinking: boolean; supports_vision?: boolean }
const THINKING_LABEL: Record<ThinkingMode, string> = { provider_default: "思考：默认", adaptive: "思考：自适应", disabled: "思考：关闭" };

/** 上次在这个工作区选的模型；只是本机偏好，读写失败就当没选过。 */
function rememberedModel(ws: string): ModelSelection | null {
  try {
    const raw = JSON.parse(localStorage.getItem(`lzcore.composer.model:${ws}`) || "null");
    return raw && typeof raw.provider === "string" ? { provider: raw.provider, thinking: raw.thinking ?? "provider_default" } : null;
  } catch { return null; }
}
function rememberModel(ws: string, value: ModelSelection | null) {
  try {
    if (value) localStorage.setItem(`lzcore.composer.model:${ws}`, JSON.stringify(value));
    else localStorage.removeItem(`lzcore.composer.model:${ws}`);
  } catch { /* 偏好写不进去不影响发送 */ }
}

export function useTurnModel(ws: string) {
  const [modelsRes] = useApi("/api/workbench/models");
  const models = modelsRes.state === "ok" ? listOf<TurnModel>(modelsRes, "models").filter((m) => m.provider && m.model) : [];
  const [modelPick, setModelPick] = useState<ModelSelection | null>(() => rememberedModel(ws));
  const chosen = modelPick ? models.find((m) => m.provider === modelPick.provider) : undefined;
  const effective = chosen ?? models.find((m) => m.is_active) ?? models[0];
  const thinking: ThinkingMode = effective?.supports_thinking && modelPick?.thinking ? modelPick.thinking : "provider_default";
  const pickModel = (next: ModelSelection | null) => { setModelPick(next); rememberModel(ws, next); };
  /** 只有偏离系统默认时才随消息发出。 */
  const modelSelection: ModelSelection | undefined = effective && (chosen || !effective.is_active || thinking !== "provider_default")
    ? { provider: effective.provider, thinking } : undefined;
  return { models, chosen, effective, thinking, modelPick, pickModel, modelSelection };
}

export type TurnModelState = ReturnType<typeof useTurnModel>;

/** 模型 + 思考强度两个下拉；样式由调用方的 chipClassName 决定。 */
export function TurnModelSelects({ state, disabled, chipClassName }: { state: TurnModelState; disabled: boolean; chipClassName: string }) {
  const { models, chosen, effective, thinking, modelPick, pickModel } = state;
  return (
    <>
      {models.length ? (
        <label className={chipClassName} title={effective ? `${effective.label} · ${effective.model}` : "模型"}>
          <span className="sr-only">模型</span>
          <select value={effective?.provider ?? ""} aria-label="模型" data-testid="model-select" disabled={disabled}
            onChange={(e) => pickModel({ provider: e.target.value, thinking: modelPick?.thinking ?? "provider_default" })}>
            {models.map((m) => <option key={m.provider} value={m.provider}>{m.model} · {m.label}</option>)}
          </select>
        </label>
      ) : null}
      {effective?.supports_thinking ? (
        <label className={chipClassName} title="思考强度">
          <span className="sr-only">思考强度</span>
          <select value={thinking} aria-label="思考强度" data-testid="thinking-select" disabled={disabled}
            onChange={(e) => pickModel({ provider: (chosen ?? effective).provider, thinking: e.target.value as ThinkingMode })}>
            {(Object.keys(THINKING_LABEL) as ThinkingMode[]).map((k) => <option key={k} value={k} disabled={k === "disabled" && effective.requires_thinking}>{THINKING_LABEL[k]}</option>)}
          </select>
        </label>
      ) : null}
    </>
  );
}
