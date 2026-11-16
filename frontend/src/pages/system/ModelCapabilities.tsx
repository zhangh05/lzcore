/**
 * 模型能力：像 LobeChat / Cherry Studio 那样，每个模型都有「识图 / 深度思考 / 上下文」等能力开关。
 * - 自动值来自后端模型目录（models.dev，按接口地址与模型名匹配），目录不认识的模型按保守默认。
 * - 用户可以逐项改成「支持 / 不支持」；识图还能一键检测：发一张纯色图，看模型能不能说出颜色。
 */
import { useEffect, useRef, useState } from "react";
import { api, bodyOf } from "../../api/client";
import { Button } from "../../components/Button";
import { IconEye } from "../../components/Icon";
import { Input } from "../../components/arc/input/input";
import SegmentedControl from "../../components/arc/segmented-control/segmented-control";
import { Chip } from "../../kit/ui";
import { formatTokens, SOURCE_LABEL, thinkingLabel, type CapabilityOverrides, type CapabilitySource, type ModelProfile } from "../../kit/modelProfile";

/** 服务卡片上的能力徽标。 */
export function CapabilityChips({ profile }: { profile?: ModelProfile | null }) {
  if (!profile) return null;
  return (
    <div className="model-caps" data-testid="model-caps">
      {profile.vision ? <Chip tone="info">识图</Chip> : null}
      {profile.reasoning ? <Chip tone="info">深度思考</Chip> : null}
      {profile.context_window ? <Chip>上下文 {formatTokens(profile.context_window)}</Chip> : null}
      {!profile.tools ? <Chip tone="warn">不支持工具调用</Chip> : null}
      <span className="model-caps-source">{profile.catalog_ref ? "能力来自内置模型目录" : "目录中没有这个模型，能力按默认"}</span>
    </div>
  );
}

type Tri = "auto" | "on" | "off";
const toTri = (v: boolean | null | undefined): Tri => (v === true ? "on" : v === false ? "off" : "auto");
const fromTri = (v: string): boolean | null => (v === "on" ? true : v === "off" ? false : null);
const TRI_OPTIONS = [{ value: "auto", label: "自动" }, { value: "on", label: "支持" }, { value: "off", label: "不支持" }];

export interface CapabilityDraft { provider?: string; model: string; base_url: string; provider_type: string; api_key?: string }
type Detect = { phase: "idle" } | { phase: "running" } | { phase: "done"; text: string; tone: "ok" | "warn" | "fail" };

export function CapabilitySettings({ draft, overrides, onOverrides, thinking, onThinking }: {
  draft: CapabilityDraft; overrides: CapabilityOverrides; onOverrides: (next: CapabilityOverrides) => void;
  thinking: string; onThinking: (next: string) => void;
}) {
  const [auto, setAuto] = useState<ModelProfile | null>(null);
  const [detect, setDetect] = useState<Detect>({ phase: "idle" });
  const seq = useRef(0);
  const model = draft.model.trim();

  // 自动值：随模型 / 地址 / 协议变化向后端查一次（不带手动设置，看「自动」会是什么）。
  useEffect(() => {
    if (!model) { setAuto(null); return; }
    const n = ++seq.current;
    const t = window.setTimeout(async () => {
      const o = await api.post("/api/agent/llm/profile", { model, base_url: draft.base_url.trim(), provider_type: draft.provider_type, ...(draft.provider ? { provider: draft.provider } : {}) });
      if (n === seq.current) setAuto(bodyOf<{ profile?: ModelProfile }>(o)?.profile ?? null);
    }, 300);
    return () => window.clearTimeout(t);
  }, [model, draft.base_url, draft.provider_type, draft.provider]);
  useEffect(() => setDetect({ phase: "idle" }), [model, draft.base_url]);

  if (!model) return <p className="sheet-hint" data-testid="capabilities-empty">选好模型后，这里会显示它的能力。</p>;

  const set = (patch: CapabilityOverrides) => onOverrides({ ...overrides, ...patch });
  const autoHint = (on: boolean | undefined, source?: CapabilitySource) => auto ? `自动：${on ? "支持" : "不支持"} · ${SOURCE_LABEL[source ?? "unknown"]}` : "正在识别…";
  const reasoning = overrides.reasoning ?? auto?.reasoning ?? false;
  const thinkingOptions = overrides.reasoning === false ? [] : auto?.thinking_options ?? [];

  const runDetect = async () => {
    setDetect({ phase: "running" });
    const body: Record<string, unknown> = { probe: "vision", provider_type: draft.provider_type, model, base_url: draft.base_url.trim() };
    if (draft.provider) body.provider = draft.provider;
    if (draft.api_key) body.api_key = draft.api_key;
    const o = await api.post("/api/agent/llm/test", body);
    const b = bodyOf<{ ok?: boolean; vision?: boolean; expected?: string; response?: string; fallback_reason?: string; error?: string; errors?: string[] }>(o);
    if (!(o.kind === "http" && o.status < 300) || !b?.ok) {
      const reason = b?.fallback_reason || b?.error || b?.errors?.join("；") || (o.kind === "http" ? `HTTP ${o.status}` : "无法连接服务端");
      setDetect({ phase: "done", tone: "fail", text: `带图请求失败：${reason}。很多不识图的模型会直接拒绝图片；也可能是网络或配额问题，可以稍后再试。` });
      return;
    }
    const color = { red: "红色", green: "绿色", blue: "蓝色", yellow: "黄色" }[b.expected ?? ""] ?? b.expected;
    if (b.vision) {
      set({ vision: auto?.vision ? null : true });
      setDetect({ phase: "done", tone: "ok", text: `检测通过：模型认出了图片是${color}。${auto?.vision ? "与自动识别一致。" : "已设为「支持」，保存后生效。"}` });
    } else {
      setDetect({ phase: "done", tone: "warn", text: `模型没认出图片（应为${color}，回答「${(b.response ?? "").slice(0, 40)}」），看来不支持识图。` });
    }
  };

  return (
    <div className="caps" data-testid="capability-settings">
      <div className="caps-row">
        <div className="caps-text"><strong>识图</strong><span>{autoHint(auto?.vision, auto?.sources.vision)}</span></div>
        <SegmentedControl label="识图" value={toTri(overrides.vision)} onValueChange={(v) => set({ vision: fromTri(v) })} options={TRI_OPTIONS} />
        <div className="caps-detect">
          <Button className="sm" variant="ghost" onClick={() => void runDetect()} loading={detect.phase === "running"} disabled={!draft.base_url.trim()} data-testid="detect-vision">
            <IconEye size={14} aria-hidden="true" />检测识图
          </Button>
          {detect.phase === "done" ? <span className={`caps-detect-result tone-${detect.tone}`} role="status" data-testid="detect-vision-result">{detect.text}</span> : null}
        </div>
      </div>
      <div className="caps-row">
        <div className="caps-text"><strong>深度思考</strong><span>{autoHint(auto?.reasoning, auto?.sources.reasoning)}</span></div>
        <SegmentedControl label="深度思考" value={toTri(overrides.reasoning)} onValueChange={(v) => set({ reasoning: fromTri(v) })} options={TRI_OPTIONS} />
      </div>
      {reasoning && thinkingOptions.length ? (
        <label className="caps-row caps-select">
          <span className="caps-text"><strong>默认思考档位</strong><span>对话里没选档位时使用。</span></span>
          <select value={thinkingOptions.includes(thinking) ? thinking : "provider_default"} onChange={(e) => onThinking(e.target.value)} data-testid="provider-thinking">
            <option value="provider_default">服务商默认</option>
            {thinkingOptions.map((t) => <option key={t} value={t} disabled={t === "disabled" && auto?.thinking_required}>{thinkingLabel(t)}</option>)}
          </select>
        </label>
      ) : null}
      <div className="caps-row">
        <div className="caps-text"><strong>温度参数</strong><span>{auto ? (auto.temperature ? autoHint(true, auto.sources.temperature) : `自动：不发送温度 · ${SOURCE_LABEL[auto.sources.temperature ?? "unknown"]}（推理模型通常只接受默认温度）`) : "正在识别…"}</span></div>
        <SegmentedControl label="温度参数" value={toTri(overrides.temperature)} onValueChange={(v) => set({ temperature: fromTri(v) })} options={TRI_OPTIONS} />
      </div>
      <Input label="上下文长度（tokens）" type="number" min={1000} step={1000} value={overrides.context_window ?? ""} data-testid="provider-context-window"
        onChange={(e) => set({ context_window: e.target.value ? Number(e.target.value) : null })}
        placeholder={auto ? `自动：${auto.context_window}` : ""}
        description={auto ? `留空使用自动值 ${formatTokens(auto.context_window)}（${SOURCE_LABEL[auto.sources.context_window ?? "unknown"]}）。` : undefined} />
    </div>
  );
}
