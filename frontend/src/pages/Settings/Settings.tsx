/**
 * Settings — LLM Provider configuration (v2).
 *
 * Layout: left provider sidebar (cards) → right form panel.
 * Each provider has its own config file; click to edit, "应用" to activate.
 */

import { useCallback, useEffect, useState } from "react";
import { settingsApi } from "../../api";
import { Badge, EmptyState, LoadingState } from "../../components/common";
import { Button, Input, Select, FormField } from "../../components/ui";
import { confirm } from "../../components/ConfirmDialog";
import { useSessionStore } from "../../stores/session";
import { useToastStore } from "../../stores/toast";
import { isApiError } from "../../types";
import type { ProviderConfig, LlmTestResult } from "../../types";
import { sanitizeAssistantText } from "../../utils/displayText";
import { formatDate } from "../../utils/format";
import { IconAlert, IconBolt, IconBrain, IconCheck, IconClock, IconProbe, IconSave, IconTrash } from "../../components/Icon";

const NEW_PROVIDER = "__new__";
const protocolLabel = (type?: ProviderConfig["provider_type"]) =>
  type === "anthropic_messages" ? "Anthropic Messages" : "OpenAI 兼容";
const emptyProvider = (): Partial<ProviderConfig> => ({
  label: "", provider_type: "openai_compatible", enabled: true,
  base_url: "", model: "", temperature: 0.2, max_tokens: 4096,
  top_p: null, thinking: "provider_default", safe_mode: true,
  prompt_cache_enabled: true, key_configured: false, is_active: false,
});

/* ──────────────────────── Settings Page ──────────────────────── */

export function Settings() {
  const toast = useToastStore((s) => s.show);
  const currentWorkspaceId = useSessionStore((s) => s.currentWorkspaceId);

  // ── State ──
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [templates, setTemplates] = useState<ProviderConfig[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<ProviderConfig> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LlmTestResult | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const [apiKeyRevealed, setApiKeyRevealed] = useState(false);
  const [clearKeyOnSave, setClearKeyOnSave] = useState(false);

  // ── Workspace long-term memory setting ──
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [memorySaving, setMemorySaving] = useState(false);
  const [memoryLoaded, setMemoryLoaded] = useState(false);

  // ── Load workspace settings on mount ──
  useEffect(() => {
    const ctrl = new AbortController();
    if (!currentWorkspaceId) {
      setMemoryLoaded(true);
      return () => ctrl.abort();
    }
    setMemoryLoaded(false);
    settingsApi.workspaceSettings(currentWorkspaceId, ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;
        setMemoryEnabled(res?.workspace?.memory_enabled !== false);
        setMemoryLoaded(true);
      })
      .catch(() => {
        if (ctrl.signal.aborted) return;
        setMemoryLoaded(true);
      });
    return () => ctrl.abort();
  }, [currentWorkspaceId]);

  // ── Load on mount ──
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    settingsApi.providersList(ctrl.signal)
      .then((res) => {
        if (ctrl.signal.aborted) return;

        const list = Array.isArray(res?.providers) ? res.providers : [];
        const active = res?.active ?? "";
        const templates = res.templates ?? [];
        const hasProtocol = (provider: ProviderConfig) =>
          provider.provider_type === "openai_compatible" || provider.provider_type === "anthropic_messages";
        // The server resolves legacy configurations. Guessing a transport here
        // can silently overwrite a working Messages configuration when a newer
        // frontend talks to an older backend that ignores protocol changes.
        if ([...list, ...templates].some(provider => !hasProtocol(provider))) {
          setError("模型配置接口未返回有效的接口协议。请通过官方脚本重启后端服务，再刷新此页面。");
          return;
        }
        setTemplates(templates);

        if (list.length === 0) {
          setProviders([]);
          setActiveId("");
          setSelectedId(NEW_PROVIDER);
          setDraft(emptyProvider());
          setLoading(false);
          return;
        }

        setProviders(list);
        setActiveId(active);
        const act = list.find((p) => p.is_active) ?? list[0];
        if (act) {
          setSelectedId(act.provider);
          setDraft({ ...act });
        }
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(isApiError(e) ? e.message : String(e));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => {
      ctrl.abort();
    };
  }, []);

  function resetKeyDraft() {
    setTestResult(null);
    setApiKeyDirty(false);
    setApiKeyDraft("");
    setClearKeyOnSave(false);
    setApiKeyRevealed(false);
  }

  function selectProvider(providerId: string) {
    const cached = providers.find(p => p.provider === providerId);
    if (!cached) return;
    setSelectedId(providerId);
    setDraft({ ...cached });
    resetKeyDraft();
  }

  function addProvider() {
    setSelectedId(NEW_PROVIDER);
    setDraft(emptyProvider());
    resetKeyDraft();
  }

  function updateConnection(change: Partial<ProviderConfig>) {
    setDraft(previous => ({ ...previous, ...change }));
    setTestResult(null);
  }

  function useTemplate(providerId: string) {
    const template = templates.find(p => p.provider === providerId);
    if (!template) return;
    setDraft({ ...template, provider: undefined, is_builtin: false, label: template.label,
      key_configured: false, key_preview: null, is_active: false });
    resetKeyDraft();
  }

  const refreshProvider = useCallback((config: ProviderConfig) => {
    setProviders(prev => {
      const exists = prev.some(p => p.provider === config.provider);
      const list = exists ? prev.map(p => p.provider === config.provider ? config : p) : [...prev, config];
      return config.is_active ? list.map(p => ({ ...p, is_active: p.provider === config.provider })) : list;
    });
    if (config.is_active) setActiveId(config.provider);
  }, []);

  async function persistProvider(activate: boolean) {
    if (!draft || !selectedId) return;
    if (!draft.label?.trim() || !draft.base_url?.trim() || !draft.model?.trim()) {
      toast({ kind: "warning", title: "请填写厂商名称、服务地址和模型名称" });
      return;
    }
    if (activate) setApplying(true); else setSaving(true);
    try {
      const payload = {
        label: draft.label.trim(), provider_type: draft.provider_type ?? "openai_compatible",
        enabled: draft.enabled, base_url: draft.base_url.trim(), model: draft.model.trim(),
        temperature: draft.temperature, max_tokens: draft.max_tokens,
        top_p: draft.top_p ?? null, thinking: draft.thinking ?? "provider_default",
        safe_mode: draft.safe_mode, prompt_cache_enabled: draft.prompt_cache_enabled,
        ...(apiKeyDirty && clearKeyOnSave ? { clear_api_key: true } : {}),
        ...(apiKeyDirty && apiKeyDraft ? { api_key: apiKeyDraft } : {}),
      };
      let providerId = selectedId;
      if (providerId === NEW_PROVIDER) {
        const created = await settingsApi.providerCreate(payload);
        providerId = created.config.provider;
        refreshProvider(created.config);
        setSelectedId(providerId);
        setDraft({ ...created.config });
        resetKeyDraft();
        if (!activate) {
          toast({ kind: "success", title: `${created.config.label} 已添加` });
          return;
        }
      }
      const res = activate
        ? await settingsApi.llmActivate(providerId, selectedId === NEW_PROVIDER ? undefined : payload)
        : await settingsApi.providerSave(providerId, payload);
      refreshProvider(res.config);
      setDraft({ ...res.config });
      resetKeyDraft();
      toast({ kind: "success", title: activate ? `已应用 ${res.config.label}` : `${res.config.label} 配置已保存` });
    } catch (e: unknown) {
      toast({ kind: "error", title: activate ? "应用失败" : "保存失败", body: isApiError(e) ? e.message : String(e) });
    } finally {
      setSaving(false);
      setApplying(false);
    }
  }
  const onSave = () => persistProvider(false);
  const onApply = () => persistProvider(true);

  async function onTest() {
    if (!draft || !selectedId) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await settingsApi.llmTest({
        message: "Reply with OK.",
        base_url: draft.base_url ?? undefined,
        model: draft.model ?? undefined,
        provider: selectedId === NEW_PROVIDER ? "custom" : selectedId,
        provider_type: draft.provider_type,
        clear_api_key: clearKeyOnSave || (selectedId === NEW_PROVIDER && !apiKeyDraft),
        api_key: apiKeyDirty ? (clearKeyOnSave ? undefined : (apiKeyDraft || undefined)) : undefined,
      });
      setTestResult(res);
      toast({
        kind: res.llm_used ? "success" : "warning",
        title: res.llm_used ? "模型服务可用" : "模型服务不可用",
        body: res.fallback_reason ? `原因：${res.fallback_reason}` : `模型：${res.model ?? "未知"}`,
      });
    } catch (e: unknown) {
      toast({ kind: "error", title: "测试请求失败", body: isApiError(e) ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  }

  async function onReset() {
    if (!selectedId) return;
    const label = draft?.label ?? selectedId;
    const custom = draft?.is_builtin === false;
    const ok = await confirm({ title: custom ? `确认删除 ${label}？` : `确认重置 ${label} 配置？`,
      body: custom ? "删除厂商配置及保存的密钥。" : "将恢复为默认值，并清除保存的密钥。",
      destructive: true, confirmLabel: custom ? "删除" : "重置" });
    if (!ok) return;
    setSaving(true);
    try {
      await settingsApi.providerDelete(selectedId);
      if (custom) {
        const remaining = providers.filter(p => p.provider !== selectedId);
        setProviders(remaining);
        const next = remaining.find(p => p.provider === activeId) ?? remaining[0];
        setSelectedId(next?.provider ?? NEW_PROVIDER);
        setDraft(next ? { ...next } : emptyProvider());
        resetKeyDraft();
        toast({ kind: "success", title: `${label} 已删除` });
        return;
      }
      const res = await settingsApi.providerGet(selectedId);
      refreshProvider(res.config);
      setDraft({ ...res.config });
      setApiKeyDirty(false);
      setApiKeyDraft("");
      setClearKeyOnSave(false);
      setTestResult(null);
      toast({ kind: "success", title: `${label} 已重置为默认配置` });
    } catch (e: unknown) {
      toast({ kind: "error", title: "重置失败", body: isApiError(e) ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  // ── Memory gating toggle ──
  async function onMemoryEnabledChange(enabled: boolean) {
    if (!currentWorkspaceId) {
      toast({ kind: "warning", title: "未选择工作区", body: "请先在左侧选择工作区" });
      return;
    }
    setMemorySaving(true);
    try {
      await settingsApi.updateWorkspaceSettings({ memory_enabled: enabled }, currentWorkspaceId);
      setMemoryEnabled(enabled);
      toast({
        kind: "success",
        title: enabled ? "已启用长期记忆" : "已关闭自动长期记忆",
      });
    } catch (e: unknown) {
      toast({
        kind: "error",
        title: "设置失败",
        body: isApiError(e) ? e.message : String(e),
      });
    } finally {
      setMemorySaving(false);
    }
  }
  const isNew = selectedId === NEW_PROVIDER;
  const isActiveProvider = selectedId === activeId;
  const isBusy = saving || applying || testing;

  // ── Render states ──

  if (loading) {
    return (
      <div className="page settings-page" data-testid="page-settings">
        <PageHeader />
        <div className="page-body"><LoadingState skeleton="list" /></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page settings-page" data-testid="page-settings">
        <PageHeader />
        <div className="page-body">
          <div className="card card-danger-border settings-error-text">{error}</div>
        </div>
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="page settings-page" data-testid="page-settings">
        <PageHeader />
        <div className="page-body"><EmptyState text="未读取到模型服务配置" /></div>
      </div>
    );
  }

  return (
    <div className="page settings-page" data-testid="page-settings">
      <PageHeader activeLabel={providers.find(p => p.provider === activeId)?.label} />
      <div className="page-body no-pad">
        <details className="settings-help">
          <summary>使用帮助</summary>
          <div className="settings-help-body">
            添加模型厂商 → 选择接口协议 → 填写地址、密钥和模型 → 测试连接 → 保存或应用。保存保留配置，应用切换当前厂商。
          </div>
        </details>
        <div className="settings-layout">
          {/* ── Left: Provider sidebar ── */}
          <aside className="provider-sidebar" data-testid="provider-sidebar">
            <div className="provider-sidebar-heading"><span>模型厂商</span>
              <Button type="button" onClick={addProvider} disabled={isBusy} data-testid="btn-add-provider">＋ 添加厂商</Button>
            </div>
            <div className="provider-list">
            {providers.map((prov) => {
              const active = prov.provider === activeId;
              const selected = prov.provider === selectedId;
              return (
                <button
                  key={prov.provider}
                  type="button"
                  className={"provider-card" + (active ? " active" : "") + (selected ? " selected" : "")}
                  onClick={() => selectProvider(prov.provider)}
                  disabled={isBusy}
                  aria-pressed={selected}
                  data-testid={`provider-${prov.provider}`}
                >
                  <div className="provider-card-top">
                    <span className="provider-card-label">{prov.label}</span>
                    {active && <Badge kind="ok">当前</Badge>}
                  </div>
                  <div className="provider-card-hint">{protocolLabel(prov.provider_type)}</div>
                  <div className="provider-card-meta">
                    {prov?.key_configured ? (
                      <span className="success-text text-xs"><IconCheck size={12} aria-hidden="true" /> 密钥已配置</span>
                    ) : (
                      <span className="muted text-xs">未配置密钥</span>
                    )}
                  </div>
                </button>
              );
            })}
            </div>
          </aside>

          {/* ── Right: Form panel ── */}
          <section className="settings-form-panel">
            {draft && (
              <div className="settings-form-card" data-testid="form-card">
                {/* Header */}
                <div className="settings-form-header">
                  <div>
                    <h2 className="settings-form-title">
                      {isNew ? "添加模型厂商" : draft.label}
                      {isActiveProvider && (
                        <span className="badge ok ml-2">当前活跃</span>
                      )}
                    </h2>
                    <div className="muted text-xs">{isNew ? "选择协议后，填写厂商的接入信息" : protocolLabel(draft.provider_type)}</div>
                  </div>
                  <div className="settings-toggle-row">
                    <ToggleField
                      label="启用"
                      hint={draft.enabled ? "模型服务已启用" : "模型服务已关闭"}
                      checked={!!draft.enabled}
                      onChange={(v) => setDraft({ ...draft, enabled: v })}
                      disabled={isBusy}
                      testid="toggle-enabled"
                    />
                  </div>
                </div>

                <fieldset className="settings-fields" disabled={isBusy}>
                {isNew && templates.length > 0 && <div className="settings-row">
                  <FormField label="快速填入" hint="模板只填入接入信息；可修改名称和地址，添加独立厂商。">
                    <Select aria-label="快速填入" value="" onChange={e => useTemplate(e.target.value)}>
                      <option value="">手动填写</option>
                      {templates.map(template => <option key={template.provider} value={template.provider}>{template.label}</option>)}
                    </Select>
                  </FormField>
                </div>}
                <div className="settings-row-grid">
                  <TextField label="厂商名称" value={draft.label ?? ""} onChange={label => setDraft({ ...draft, label })}
                    testid="field-provider-label" placeholder="例如：公司模型网关" />
                  <FormField label="接口协议">
                    <Select aria-label="接口协议" data-testid="field-provider-type" value={draft.provider_type ?? "openai_compatible"}
                      onChange={e => updateConnection({ provider_type: e.target.value as ProviderConfig["provider_type"] })}>
                      <option value="openai_compatible">OpenAI 兼容 · Chat Completions</option>
                      <option value="anthropic_messages">Anthropic · Messages</option>
                    </Select>
                  </FormField>
                </div>
                {/* Fields */}
                <div className="settings-row">
                  <TextField label="服务地址" value={draft.base_url ?? ""} onChange={(v) => updateConnection({ base_url: v })} testid="field-base_url" placeholder="https://网关地址/v1" />
                </div>

                <div className="settings-row">
                  <TextField label="模型名称" value={draft.model ?? ""} onChange={(v) => updateConnection({ model: v,
                    thinking: v.toLowerCase().startsWith("minimax-m3.1") && draft.thinking === "disabled" ? "provider_default" : draft.thinking,
                  })} testid="field-model" placeholder="模型名称" />
                </div>

                <div className="settings-row">
                  <ApiKeyField
                    configured={!!draft.key_configured}
                    preview={draft.key_preview}
                    revealed={apiKeyRevealed}
                    onRevealToggle={() => setApiKeyRevealed((v) => !v)}
                    draft={apiKeyDraft}
                    onDraftChange={(v) => { setApiKeyDraft(v); setApiKeyDirty(true); setClearKeyOnSave(false); setTestResult(null); }}
                    clearRequested={clearKeyOnSave}
                    onClearToggle={(v) => {
                      setClearKeyOnSave(v);
                      setTestResult(null);
                      if (v) { setApiKeyDraft(""); setApiKeyDirty(true); }
                    }}
                  />
                </div>

                <div className="settings-row-grid">
                  <NumberField label="生成随机度" value={draft.temperature ?? 0.2} min={0} max={2} step={0.1} onChange={(v) => setDraft({ ...draft, temperature: v })} testid="field-temperature" />
                  <NumberField label="最大输出长度" value={draft.max_tokens ?? 4096} min={1} max={128000} step={100} onChange={(v) => setDraft({ ...draft, max_tokens: v })} testid="field-max_tokens" />
                </div>

                <div className="settings-row settings-row-compact">
                  <ToggleField
                    label="安全模式"
                    hint="阻止伪造执行结果或泄露敏感输出"
                    checked={!!draft.safe_mode}
                    onChange={(v) => setDraft({ ...draft, safe_mode: v })}
                    testid="toggle-safe_mode"
                  />
                  <ToggleField
                    label="提示词缓存"
                    hint="按模型服务能力复用稳定前缀；历史、当前请求与按需 Skill 保持动态装配"
                    checked={draft.prompt_cache_enabled !== false}
                    onChange={(v) => setDraft({ ...draft, prompt_cache_enabled: v })}
                    testid="toggle-prompt_cache"
                  />
                </div>

                <div className="settings-row-grid">
                  <FormField label="Top P（留空使用服务商默认）"><Input type="number" min="0.01" max="1" step="0.05" aria-label="Top P"
                    value={draft.top_p ?? ""} onChange={e => setDraft({...draft, top_p: e.target.value === "" ? null : Number(e.target.value)})}/></FormField>
                  {draft.model?.toLowerCase().startsWith("minimax-m3") && <FormField label="模型思考" hint="复杂设计可启用；思考占用输出额度，通常会增加等待时间。">
                    <Select aria-label="模型思考" value={draft.thinking ?? "provider_default"}
                      onChange={e => setDraft({...draft, thinking: e.target.value as ProviderConfig["thinking"]})}>
                      <option value="provider_default">服务商默认</option><option value="adaptive">启用自适应思考</option>
                      {!draft.model?.toLowerCase().startsWith("minimax-m3.1") && <option value="disabled">关闭思考</option>}
                    </Select></FormField>}
                </div>

                </fieldset>

                {/* Test result */}
                {testResult && (
                  <div
                    className={"card mt-3 settings-test-result " + (testResult.llm_used ? "card-ok-border" : "card-warn-border")}
                    data-testid="test-result"
                  >
                    <div className="mb-1">
                      <strong className="settings-result-heading">{testResult.llm_used ? <IconCheck size={14} aria-hidden="true" /> : <IconAlert size={14} aria-hidden="true" />}{testResult.llm_used ? "模型服务可用" : "模型服务不可用"}</strong>
                      <span className="muted ml-2">
                        服务商：{testResult.provider ?? "未知"} · 模型：{testResult.model ?? "未知"} · 配置来源：{testResult.config_source}
                      </span>
                    </div>
                    {testResult.fallback_reason && (
                      <div className="muted mb-1">备用处理原因：{testResult.fallback_reason}</div>
                    )}
                    {testResult.response && (
                      <pre className="test-result-pre">
                        {sanitizeAssistantText(testResult.response)}
                      </pre>
                    )}
                    {testResult.warnings?.length > 0 && (
                      <div className="muted text-xs mt-1">
                        提示：{testResult.warnings.join("；")}
                      </div>
                    )}
                  </div>
                )}

                {/* Actions */}
                <div className="settings-actions">
                  <Button type="button" onClick={onTest} disabled={isBusy} data-testid="btn-test-llm">
                    <IconProbe size={15} aria-hidden="true" />{testing ? "测试中…" : "测试连接"}
                  </Button>
                  <Button type="button" onClick={onSave} disabled={isBusy} data-testid="btn-save-llm">
                    <IconSave size={15} aria-hidden="true" />{saving ? "保存中…" : "保存"}
                  </Button>
                  <Button type="button" variant="primary" onClick={onApply} disabled={isBusy} data-testid="btn-apply-llm">
                    <IconBolt size={15} aria-hidden="true" />{applying ? "应用中…" : "应用"}
                  </Button>
                  <span className="spacer" />
                  {draft.updated_at && (
                    <span className="muted text-xs" data-testid="last-updated">
                      {formatDate(draft.updated_at, "compact")}
                    </span>
                  )}
                  <Button
                    type="button" variant="danger-ghost" onClick={onReset}
                    disabled={isBusy || isNew || (draft.is_builtin === false && isActiveProvider)}
                    title={draft.is_builtin === false && isActiveProvider ? "先应用其他厂商，再删除当前厂商" : undefined} data-testid="btn-reset-llm"
                  >
                    <IconTrash size={15} aria-hidden="true" />{draft.is_builtin === false ? "删除厂商" : "重置"}
                  </Button>
                </div>
              </div>
            )}

            <LongTermMemoryCard
              enabled={memoryEnabled}
              loading={memorySaving}
              loaded={memoryLoaded}
              onChange={onMemoryEnabledChange}
            />
          </section>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────── Sub-components ──────────────────────── */

function PageHeader({ activeLabel }: { activeLabel?: string }) {
  return (
    <div className="page-header">
      <div>
        <h1>系统设置</h1>
        <div className="subtitle">
          配置模型服务、访问密钥和长期记忆
          {activeLabel && (
            <span className="badge ok ml-2 text-xs">
              {activeLabel}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function TextField({ label, value, onChange, testid, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; testid?: string; placeholder?: string;
}) {
  return (
    <FormField label={label}>
      <Input type="text" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} data-testid={testid} spellCheck={false} autoComplete="off" placeholder={placeholder} />
    </FormField>
  );
}

function NumberField({ label, value, min, max, step, onChange, testid }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; testid?: string;
}) {
  return (
    <FormField label={label}>
      <Input type="number" aria-label={label} value={value} min={min} max={max} step={step} onChange={(e) => { const n = Number(e.target.value); if (!Number.isNaN(n)) onChange(n); }} data-testid={testid} />
    </FormField>
  );
}

function ToggleField({ label, hint, checked, onChange, testid, disabled }: {
  label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; testid?: string; disabled?: boolean;
}) {
  return (
    <FormField label={label}>
      <button
        type="button"
        className={"toggle" + (checked ? " on" : "")}
        onClick={() => onChange(!checked)}
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        data-testid={testid}
      >
        <span className="toggle-knob" />
        <span className="toggle-label">{hint ? <span className="muted text-xs">{hint}</span> : null}</span>
      </button>
    </FormField>
  );
}

function ApiKeyField({
  configured, preview, revealed, onRevealToggle,
  draft, onDraftChange, clearRequested, onClearToggle,
}: {
  configured: boolean;
  preview: string | null | undefined;
  revealed: boolean;
  onRevealToggle: () => void;
  draft: string;
  onDraftChange: (v: string) => void;
  clearRequested: boolean;
  onClearToggle: (v: boolean) => void;
}) {
  const placeholder = configured
    ? revealed ? "粘贴新密钥替换当前密钥" : "已配置 · 输入新密钥进行替换"
    : "粘贴访问密钥";
  return (
    <FormField label="访问密钥">
      <div className="row-flex-sm">
        <Input
          type={revealed ? "text" : "password"}
          value={clearRequested ? "" : draft}
          onChange={(e) => onDraftChange(e.target.value)}
          placeholder={placeholder}
          data-testid="field-api_key"
          autoComplete="off"
          spellCheck={false}
          className="mono flex-1"
        />
        {configured && !draft && !clearRequested && (
          <span className="muted text-xs" data-testid="api-key-preview" style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
            <code>{preview ?? "已配置"}</code>
          </span>
        )}
        <Button type="button" onClick={onRevealToggle} data-testid="btn-toggle-key-reveal" title={revealed ? "隐藏" : "显示"}>
          {revealed ? "隐藏" : "显示"}
        </Button>
      </div>
      <div className="row-flex-sm mt-1">
        {configured ? <span className="success-text text-xs"><IconCheck size={12} aria-hidden="true" /> 已配置</span> : <span className="muted text-xs">未配置</span>}
        {configured && (
          <label className="row-flex-xs">
            <input type="checkbox" checked={clearRequested} onChange={(e) => onClearToggle(e.target.checked)} data-testid="cb-clear-key" />
            <span className="muted text-xs">保存时清空密钥</span>
          </label>
        )}
      </div>
    </FormField>
  );
}

/* ──────────────────────── Long-term Memory Card ──────────────────────── */

function LongTermMemoryCard({
  enabled, loading, loaded, onChange,
}: {
  enabled: boolean;
  loading: boolean;
  loaded: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="card mt-3 memory-gating-card">
      <div className="row-flex memory-gating-header">
        <div className="flex-1">
          <div className="text-md memory-gating-title-text">长期记忆</div>
          <div className="muted text-xs memory-gating-desc">
            自动整理任务经历：原文已核对的历史工具观察可自动生效，模型推断、规则和操作方法等待确认。关闭后仍可手动管理或明确要求记住。
          </div>
        </div>
        <div className="row-flex-sm">
          <span className={`text-xs memory-gating-status ${enabled ? "memory-gating-status-on" : "memory-gating-status-off"}`}>
            {enabled ? "已启用" : "已关闭"}
          </span>
          <button
            type="button"
            className={"toggle" + (enabled ? " on" : "")}
            disabled={loading}
            onClick={() => onChange(!enabled)}
            role="switch"
            aria-checked={enabled}
            aria-label="长期记忆"
            data-testid="toggle-memory-enabled"
          >
            <span className="toggle-knob" />
          </button>
        </div>
      </div>
      {loaded && (
        <div className={"memory-gating-box " + (enabled ? "ok" : "default")}>
          <div className="memory-gating-title">
            <span className="mr-1">{enabled ? <IconBrain size={15} aria-hidden="true" /> : <IconClock size={15} aria-hidden="true" />}</span>
            当前：{enabled ? "自动长期记忆已启用" : "自动长期记忆已关闭"}
          </div>
          <div className="memory-gating-body">
            系统会先判断本轮是否发生了值得学习的事件；没有记忆信号会直接跳过，不会每轮硬写。
          </div>
          <div className="memory-gating-body">
            发现值得记忆的内容后，模型会提出新增、更新、忽略、过期或冲突处理建议；规则会拦截密钥、无效内容和冲突风险。
          </div>
          <div className="memory-gating-footer">
            <span className="opacity-60"><IconClock size={14} aria-hidden="true" /></span>
            {enabled ? "用户可在记忆页查看、确认、编辑或删除结果" : "关闭后仍可手动新建记忆"}
          </div>
        </div>
      )}
    </div>
  );
}
