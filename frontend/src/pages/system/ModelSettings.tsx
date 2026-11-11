import { useId, useRef, useState } from "react";
import { api, bodyOf, enc } from "../../api/client";
import { Button } from "../../components/Button";
import { IconCheckCircle, IconChevronDown, IconEye, IconKey, IconPlus, IconRefresh, IconSparkle, IconTrash, IconWarningCircle, IconBolt, IconEdit } from "../../components/Icon";
import type { HttpOutcome } from "../../contracts/auth";
import { listOf, useApi, type Loadable } from "../../kit/useApi";
import { Chip, ConfirmDialog, Drawer, FailureNote, LoadState, RawData, ReceiptNote, fmtTime } from "../../kit/ui";

export interface Provider {
  provider: string; label?: string; provider_type?: string; protocol?: string; base_url?: string; model?: string;
  key_configured?: boolean; key_preview?: string | null; is_active?: boolean; temperature?: number; max_tokens?: number;
}
export interface LlmStatus {
  provider?: string; model?: string; provider_type?: string; enabled?: boolean; connected?: boolean; key_configured?: boolean;
  health?: { connected?: boolean; checked_at?: string; last_checked_at?: string; last_error?: string | null; last_error_type?: string | null };
  last_success?: { at?: string } | null; recent_failure?: { at?: string; error_type?: string; error_summary?: string } | null;
}

const PROTOCOLS = [["openai_compatible", "OpenAI 兼容"], ["anthropic_messages", "Anthropic Messages"]] as const;
const protocolLabel = (p?: string) => PROTOCOLS.find(([k]) => k === p)?.[1] ?? p ?? "未上报";
const hostOf = (url?: string) => { try { return url ? new URL(url).host : ""; } catch { return url ?? ""; } };
const isLocal = (url?: string) => /^(localhost|127\.|\[::1\])/.test(hostOf(url));
/** 已接入 = 有密钥、当前在用、本机服务（无需密钥）或用户自建的；其余内置预设只出现在「添加」画廊里。 */
export const isConnected = (p: Provider, active: string) => !!p.key_configured || p.provider === active || !!p.is_active || isLocal(p.base_url) || p.provider.startsWith("provider_");

/** 名称首字母 + 由 id 推出的稳定色相，作为服务商的头像（不引入第三方商标图形）。 */
function Avatar({ p, size = 36 }: { p: Pick<Provider, "provider" | "label">; size?: number }) {
  const name = (p.label || p.provider).replace(/[（(].*$/, "").trim();
  let h = 0; for (const ch of p.provider) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return <span className="model-avatar" aria-hidden="true" style={{ width: size, height: size, ["--hue" as string]: String(h) }}>{name.slice(0, /^[A-Za-z]/.test(name) ? 2 : 1)}</span>;
}

type TestState = { phase: "idle" } | { phase: "running" } | { phase: "done"; ok: boolean; ms: number; reply?: string; error?: string; o: HttpOutcome };

async function runProbe(body: Record<string, unknown>): Promise<TestState> {
  const t0 = performance.now();
  const o = await api.post("/api/agent/llm/test", { message: "Reply with OK.", ...body });
  const ms = Math.round(performance.now() - t0);
  const b = bodyOf<{ ok?: boolean; response?: string; fallback_reason?: string; error?: string; errors?: string[] }>(o);
  const ok = o.kind === "http" && o.status < 300 && b?.ok !== false;
  return { phase: "done", ok, ms, reply: b?.response, error: b?.fallback_reason || b?.error || b?.errors?.join("；"), o };
}

function TestResult({ t }: { t: TestState }) {
  if (t.phase === "idle") return null;
  if (t.phase === "running") return <p className="probe is-running" role="status"><span className="probe-pulse" aria-hidden="true" />正在发送一次真实请求…</p>;
  if (t.o.kind !== "http") return <FailureNote outcome={t.o} />;
  return t.ok ? (
    <p className="probe is-ok" role="status" data-testid="llm-test-result"><IconCheckCircle size={16} aria-hidden="true" />连接正常 · {t.ms} ms{t.reply ? <span className="probe-reply">「{t.reply.slice(0, 80)}」</span> : null}</p>
  ) : (
    <p className="probe is-fail" role="alert" data-testid="llm-test-result"><IconWarningCircle size={16} aria-hidden="true" />测试未通过 · {t.ms} ms<span className="probe-reply">{t.error || "服务端未给出原因"}</span></p>
  );
}

export function ModelSettings({ admin, platform }: { admin: boolean; platform: boolean }) {
  const [list, reload] = useApi("/api/agent/llm/providers");
  const [status, reloadStatus] = useApi("/api/agent/llm/status");
  const [sheet, setSheet] = useState<{ provider: Provider; isNew: boolean } | null>(null);
  const [del, setDel] = useState<Provider | null>(null);
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  const [test, setTest] = useState<TestState>({ phase: "idle" });
  const [switching, setSwitching] = useState<string | null>(null);
  const data = list.state === "ok" ? (list.data as { active?: string; providers?: Provider[]; templates?: Provider[] }) : null;
  const active = String(data?.active ?? "");
  const providers = listOf<Provider>(list, "providers");
  const current = providers.find((p) => p.provider === active || p.is_active);
  const connected = providers.filter((p) => isConnected(p, active));
  const gallery = providers.filter((p) => !isConnected(p, active) && p.provider !== "custom");
  const activate = async (p: Provider) => {
    setSwitching(p.provider);
    const o = await api.post("/api/agent/llm/activate", { provider: p.provider });
    setSwitching(null); setR({ label: `切换到 ${p.label ?? p.provider}`, o }); setTest({ phase: "idle" }); reload(); reloadStatus();
  };
  const blank = (type: string): Provider => ({ provider: "", label: "", provider_type: type, base_url: "", model: "" });
  return (
    <div className="models" data-testid="model-settings">
      <CurrentModel current={current} status={status} test={test} onTest={async () => { setTest({ phase: "running" }); setTest(await runProbe({})); reloadStatus(); }}
        onEdit={admin && current ? () => setSheet({ provider: current, isNew: false }) : undefined} />
      {r ? (r.o.kind === "http" && r.o.status < 300 ? <ReceiptNote text={`${r.label}已完成`} /> : <FailureNote outcome={r.o} />) : null}

      <section className="models-section">
        <header className="models-section-head"><h2>已接入的模型服务</h2><span className="muted">{connected.length} 个</span></header>
        <LoadState value={list} onReload={reload}>{() => (
          <ul className="model-grid" data-testid="providers-table">
            {connected.map((p) => {
              const isActive = p.provider === active || p.is_active;
              const needsKey = !p.key_configured && !isLocal(p.base_url);
              return (
                <li key={p.provider} className={`model-card ${isActive ? "is-active" : ""}`}>
                  <header>
                    <Avatar p={p} />
                    <div className="model-card-title"><strong>{p.label ?? p.provider}</strong><span>{hostOf(p.base_url) || "未设置地址"}</span></div>
                    {isActive ? <Chip tone="ok">当前</Chip> : needsKey ? <Chip tone="warn">缺少密钥</Chip> : null}
                  </header>
                  <div className="model-card-model"><IconSparkle size={13} aria-hidden="true" /><code>{p.model || "未选择模型"}</code></div>
                  <div className="model-card-meta">
                    <span>{protocolLabel(p.provider_type ?? p.protocol)}</span>
                    <span><IconKey size={12} aria-hidden="true" />{p.key_configured ? p.key_preview ?? "已配置" : isLocal(p.base_url) ? "本机无需密钥" : "未配置"}</span>
                  </div>
                  {admin ? (
                    <footer>
                      {!isActive ? <Button className="sm" variant="primary" onClick={() => void activate(p)} disabled={switching === p.provider || needsKey} title={needsKey ? "先填写 API Key" : undefined}>{switching === p.provider ? "切换中…" : "设为当前"}</Button> : null}
                      <Button className="sm" onClick={() => setSheet({ provider: p, isNew: false })}><IconEdit size={14} aria-hidden="true" />配置</Button>
                      <span className="grow" />
                      {!isActive && p.provider.startsWith("provider_") ? <Button className="sm" variant="ghost" onClick={() => setDel(p)} aria-label={`删除 ${p.label ?? p.provider}`}><IconTrash size={14} aria-hidden="true" /></Button> : null}
                    </footer>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}</LoadState>
      </section>

      {admin ? (
        <section className="models-section">
          <header className="models-section-head"><h2>添加模型服务</h2><span className="muted">选择服务商，填入密钥即可；保存前可以先测试连通。</span></header>
          <ul className="model-gallery">
            {gallery.map((p) => (
              <li key={p.provider}>
                <button type="button" className="model-tile" onClick={() => setSheet({ provider: p, isNew: false })} data-testid={`provider-add-${p.provider}`}>
                  <Avatar p={p} size={32} />
                  <span className="model-tile-text"><strong>{p.label ?? p.provider}</strong><span>{hostOf(p.base_url)}</span></span>
                  <IconPlus size={16} aria-hidden="true" className="model-tile-plus" />
                </button>
              </li>
            ))}
            <li>
              <button type="button" className="model-tile is-custom" onClick={() => setSheet({ provider: blank("openai_compatible"), isNew: true })} data-testid="provider-new">
                <span className="model-avatar is-custom" aria-hidden="true" style={{ width: 32, height: 32 }}><IconPlus size={16} /></span>
                <span className="model-tile-text"><strong>自定义服务</strong><span>任意 OpenAI 兼容或 Anthropic 接口</span></span>
              </button>
            </li>
          </ul>
        </section>
      ) : <p className="muted">修改模型服务需要管理员权限。</p>}

      {sheet ? <ProviderSheet provider={sheet.provider} isNew={sheet.isNew} platform={platform} active={active}
        onClose={() => setSheet(null)} onSaved={(label, o) => { setR({ label, o }); setSheet(null); setTest({ phase: "idle" }); reload(); reloadStatus(); }} /> : null}
      {del ? <ConfirmDialog title="删除模型服务？" details={<p>将删除「{del.label ?? del.provider}」的配置（含已保存的密钥）。</p>} confirmText={del.label ?? del.provider} confirmLabel="删除"
        onCancel={() => setDel(null)} onConfirm={async () => { const p = del; setDel(null); setR({ label: "删除", o: await api.del(`/api/agent/llm/providers/${enc(p.provider)}`) }); reload(); }} /> : null}
    </div>
  );
}

function CurrentModel({ current, status, test, onTest, onEdit }: { current?: Provider; status: Loadable<unknown>; test: TestState; onTest: () => void; onEdit?: () => void }) {
  const s = status.state === "ok" ? (status.data as LlmStatus) : null;
  const probe = s?.health?.connected;
  const checkedAt = s?.health?.checked_at ?? s?.health?.last_checked_at;
  const tone = probe ? "ok" : probe === false ? "fail" : "unknown";
  return (
    <section className={`model-hero is-${tone}`} aria-label="当前模型">
      <div className="model-hero-main">
        {current ? <Avatar p={current} size={48} /> : <span className="model-avatar" aria-hidden="true" style={{ width: 48, height: 48 }}>?</span>}
        <div className="model-hero-text">
          <span className="model-hero-eyebrow"><span className={`live-indicator is-${tone}`} aria-hidden="true" />{probe ? "正在使用 · 连接正常" : probe === false ? "正在使用 · 最近探测失败" : "正在使用"}</span>
          <h2>{current?.label ?? s?.provider ?? "未选择模型服务"}</h2>
          <p><code>{current?.model || s?.model || "未选择模型"}</code><span>{hostOf(current?.base_url)}</span><span>{protocolLabel(current?.provider_type ?? s?.provider_type)}</span></p>
        </div>
        <div className="model-hero-actions">
          <Button onClick={onTest} disabled={test.phase === "running"}><IconBolt size={15} aria-hidden="true" />{test.phase === "running" ? "测试中…" : "测试连接"}</Button>
          {onEdit ? <Button variant="ghost" onClick={onEdit}>配置</Button> : null}
        </div>
      </div>
      <dl className="model-hero-stats">
        <div><dt>最近成功</dt><dd>{s?.last_success?.at ? fmtTime(s.last_success.at) : "—"}</dd></div>
        <div><dt>最近失败</dt><dd className={s?.recent_failure?.at ? "is-warn" : ""}>{s?.recent_failure?.at ? `${fmtTime(s.recent_failure.at)}${s.recent_failure.error_type ? ` · ${s.recent_failure.error_type}` : ""}` : "无"}</dd></div>
        <div><dt>最近探测</dt><dd>{checkedAt ? fmtTime(checkedAt) : "—"}</dd></div>
        <div><dt>密钥</dt><dd>{current?.key_configured ? current.key_preview ?? "已配置" : isLocal(current?.base_url) ? "本机无需" : "未配置"}</dd></div>
      </dl>
      <TestResult t={test} />
      {s?.health?.last_error ? <p className="model-hero-error"><IconWarningCircle size={14} aria-hidden="true" />{s.health.last_error_type ? `${s.health.last_error_type}：` : ""}{s.health.last_error}</p> : null}
      {status.state === "ok" ? <RawData value={status.data} path="/api/agent/llm/status" label="诊断原文" /> : null}
    </section>
  );
}

function ProviderSheet({ provider, isNew, platform, active, onClose, onSaved }: {
  provider: Provider; isNew: boolean; platform: boolean; active: string; onClose: () => void; onSaved: (label: string, o: HttpOutcome) => void;
}) {
  const [f, setF] = useState({
    label: provider.label ?? "", provider_type: provider.provider_type ?? provider.protocol ?? "openai_compatible",
    base_url: provider.base_url ?? "", model: provider.model ?? "", api_key: "",
    temperature: provider.temperature ?? 0.2, max_tokens: provider.max_tokens ?? 4096,
  });
  const [showKey, setShowKey] = useState(false);
  const [advanced, setAdvanced] = useState(isNew);
  const [test, setTest] = useState<TestState>({ phase: "idle" });
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const keyRef = useRef<HTMLInputElement>(null);
  const ids = { label: useId(), key: useId(), model: useId(), url: useId(), list: `models-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}` };
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => { setF({ ...f, [k]: v }); setTest({ phase: "idle" }); };
  const lockUrl = !isNew && !platform;
  const missing = [!f.label.trim() && "名称", !f.base_url.trim() && "接口地址", !f.model.trim() && "模型"].filter(Boolean) as string[];
  const isActive = provider.provider === active || provider.is_active;
  const fields = () => {
    const body: Record<string, unknown> = { label: f.label.trim(), provider_type: f.provider_type, model: f.model.trim(), temperature: Number(f.temperature), max_tokens: Number(f.max_tokens) };
    if (!lockUrl) body.base_url = f.base_url.trim();
    if (f.api_key) body.api_key = f.api_key;
    return body;
  };
  const probe = async () => {
    setTest({ phase: "running" });
    const draft: Record<string, unknown> = { provider_type: f.provider_type, model: f.model.trim(), base_url: f.base_url.trim() };
    if (!isNew) draft.provider = provider.provider;
    if (f.api_key) draft.api_key = f.api_key;
    setTest(await runProbe(draft));
  };
  const save = async (andActivate: boolean) => {
    setBusy(true); setErrors([]);
    try {
      let o: HttpOutcome;
      let id = provider.provider;
      if (isNew) {
        o = await api.post("/api/agent/llm/providers", fields());
        id = bodyOf<{ config?: { provider?: string } }>(o)?.config?.provider ?? "";
      } else {
        o = await api.post(`/api/agent/llm/providers/${enc(id)}`, fields());
      }
      const okSave = o.kind === "http" && o.status < 300;
      if (!okSave) {
        const b = bodyOf<{ errors?: string[]; error?: string }>(o);
        setErrors(b?.errors ?? (b?.error ? [b.error] : ["保存失败"]));
        return;
      }
      if (andActivate && id && !isActive) {
        const a = await api.post("/api/agent/llm/activate", { provider: id });
        onSaved(`保存并切换到 ${f.label || id}`, a);
      } else onSaved(`保存 ${f.label || id}`, o);
    } finally { setBusy(false); }
  };
  return (
    <Drawer title={isNew ? "添加自定义模型服务" : `配置 ${provider.label ?? provider.provider}`} onClose={onClose} testId="provider-sheet">
      <div className="sheet">
        <div className="sheet-head">
          <Avatar p={isNew ? { provider: "custom", label: f.label || "自定义" } : provider} size={44} />
          <div><strong>{f.label || "新的模型服务"}</strong><span className="muted">{hostOf(f.base_url) || "填写接口地址"} · {protocolLabel(f.provider_type)}</span></div>
        </div>

        {isNew ? (
          <div className="sheet-field">
            <span className="sheet-label">接口协议</span>
            <div className="seg sheet-seg" role="radiogroup" aria-label="接口协议">
              {PROTOCOLS.map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={f.provider_type === k} className={`tab ${f.provider_type === k ? "is-active" : ""}`} onClick={() => set("provider_type", k)}>{label}</button>
              ))}
            </div>
          </div>
        ) : null}
        <label className="sheet-field" htmlFor={ids.label}><span className="sheet-label">名称</span>
          <input id={ids.label} className="input" value={f.label} onChange={(e) => set("label", e.target.value)} placeholder="例如：公司网关 · GPT" data-testid="provider-label" /></label>

        <div className="sheet-field">
          <label className="sheet-label" htmlFor={ids.key}>API Key</label>
          <div className="key-input">
            <IconKey size={15} aria-hidden="true" />
            <input id={ids.key} ref={keyRef} type={showKey ? "text" : "password"} autoComplete="new-password" spellCheck={false} value={f.api_key}
              onChange={(e) => set("api_key", e.target.value)} placeholder={provider.key_configured ? `已保存 ${provider.key_preview ?? ""}，留空不修改` : isLocal(f.base_url) ? "本机服务通常不需要" : "粘贴密钥"} data-testid="provider-key" />
            <button type="button" className="key-toggle" onClick={() => setShowKey((v) => !v)} aria-label={showKey ? "隐藏密钥" : "显示密钥"} aria-pressed={showKey}><IconEye size={15} aria-hidden="true" /></button>
          </div>
          <span className="sheet-hint">密钥只发送到服务端保存，保存后不会回显。</span>
        </div>

        <label className="sheet-field" htmlFor={ids.model}><span className="sheet-label">模型</span>
          <input id={ids.model} className="input mono" list={ids.list} value={f.model} onChange={(e) => set("model", e.target.value)} placeholder="模型名，例如服务商控制台里的 model id" data-testid="provider-model" />
          <datalist id={ids.list}>{[provider.model].filter(Boolean).map((m) => <option key={m} value={m} />)}</datalist></label>

        <button type="button" className="sheet-advanced" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
          <IconChevronDown size={15} aria-hidden="true" />高级设置<span className="muted">接口地址、温度、最大输出</span>
        </button>
        {advanced ? (
          <div className="sheet-adv">
            <label className="sheet-field" htmlFor={ids.url}><span className="sheet-label">接口地址</span>
              <input id={ids.url} className="input mono" value={f.base_url} onChange={(e) => set("base_url", e.target.value)} disabled={lockUrl} placeholder="https://…/v1" data-testid="provider-url" />
              {lockUrl ? <span className="sheet-hint">非平台管理员不能修改已有服务的地址。</span> : null}</label>
            <div className="sheet-row">
              <label className="sheet-field"><span className="sheet-label">温度 <span className="muted">{Number(f.temperature).toFixed(1)}</span></span>
                <input type="range" min={0} max={2} step={0.1} value={f.temperature} onChange={(e) => set("temperature", Number(e.target.value))} aria-label="温度" /></label>
              <label className="sheet-field"><span className="sheet-label">最大输出 tokens</span>
                <input className="input" type="number" min={256} step={256} value={f.max_tokens} onChange={(e) => set("max_tokens", Number(e.target.value))} /></label>
            </div>
          </div>
        ) : null}

        <div className="sheet-test">
          <Button onClick={() => void probe()} disabled={test.phase === "running" || !f.model.trim() || !f.base_url.trim()} data-testid="provider-test">
            <IconRefresh size={15} aria-hidden="true" className={test.phase === "running" ? "spin" : undefined} />测试连接
          </Button>
          <span className="sheet-hint">用当前填写的内容发一条真实请求，不会保存。</span>
        </div>
        <TestResult t={test} />
        {errors.length ? <ul className="sheet-errors" role="alert">{errors.map((e) => <li key={e}>{e}</li>)}</ul> : null}
        {missing.length ? <p className="sheet-hint">还需填写：{missing.join("、")}</p> : null}

        <div className="sheet-foot">
          <Button onClick={onClose}>取消</Button>
          <span className="grow" />
          <Button onClick={() => void save(false)} disabled={busy || missing.length > 0} data-testid="provider-save">保存</Button>
          {!isActive ? <Button variant="primary" onClick={() => void save(true)} disabled={busy || missing.length > 0} data-testid="provider-save-activate">保存并设为当前</Button> : null}
        </div>
      </div>
    </Drawer>
  );
}
