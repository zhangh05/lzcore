import { readWorkbenchSelection, type WorkbenchSelection } from "../../contracts/workbench";
import { boundSessionSelection } from "../../extension-modules/registry";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { Button } from "../../components/Button";
import { IconAttachment, IconFolder, IconLock, IconSend, IconStop } from "../../components/Icon";
import { useApi, listOf } from "../../kit/useApi";
import { LoadMore, usePaged } from "../../kit/usePaged";
import { Drawer, FailureNote, fmtTime } from "../../kit/ui";
import { admitAttachments, attachmentKind, scopeLocked, stopLabel, type PendingAttachment, type SessionSummary, type StopState } from "./model";

interface Skill { extension_id: string; skill_id: string; name: string; description?: string; resources: { resource_id: string; name: string; description?: string }[]; default_resource_ids?: string[]; selection_mode?: "single" | "multiple" }
const skillKey = (skill: Skill) => JSON.stringify([skill.extension_id, skill.skill_id]);
export interface ModelSelection { provider: string; thinking: ThinkingMode }
export interface SendOptions { attachments: PendingAttachment[]; workbenchSelection?: WorkbenchSelection; resumeTaskId?: string; modelSelection?: ModelSelection }

type ThinkingMode = "provider_default" | "adaptive" | "disabled";
interface TurnModel { provider: string; label: string; model: string; is_active: boolean; supports_thinking: boolean; requires_thinking: boolean }
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

interface ManagedFile { file_id: string; original_name?: string; name?: string; filename?: string; size_bytes?: number; mime_type?: string; created_at?: string; metadata?: { folder?: string } }

let seq = 0;
const nextId = () => `att-${++seq}`;

export function Composer({ ws, session, running, stopState, onSend, onStop }: {
  ws: string; session: SessionSummary | null; running: boolean; stopState: StopState;
  onSend: (text: string, opts: SendOptions) => Promise<boolean>; onStop: () => void;
}) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [rejected, setRejected] = useState<{ name: string; reason: string }[]>([]);
  const binding = useMemo(() => boundSessionSelection(session?.metadata), [session?.metadata]);
  const saved = useMemo(() => binding ?? readWorkbenchSelection(session?.metadata?.workbench_selection), [binding, session?.metadata]);
  const [skillId, setSkillId] = useState("");
  const [scope, setScope] = useState<string[]>([]);
  const [picker, setPicker] = useState<"files" | "resources" | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [skills] = useApi("/api/workbench/skills", { workspace_id: ws });
  const catalog = listOf<Skill>(skills, "skills").filter((s) => s.extension_id && s.skill_id && Array.isArray(s.resources));
  // 扩展绑定的会话（如拓扑绘图 drawing:<id>）刻意不进公共目录；绑定本身就是这条会话可用的 Skill，服务端发送时再校验。
  const skillList: Skill[] = binding && !catalog.some((s) => s.extension_id === binding.extension_id && s.skill_id === binding.skill_id)
    ? [{ extension_id: binding.extension_id, skill_id: binding.skill_id, name: binding.skill_name || binding.skill_id,
        resources: binding.resource_ids.map((id) => ({ resource_id: id, name: id })), default_resource_ids: binding.resource_ids,
        selection_mode: "single" as const }, ...catalog]
    : catalog;
  const skill = skillList.find((s) => skillKey(s) === skillId);
  const validScope = skill?.resources.filter((r) => scope.includes(r.resource_id)).map((r) => r.resource_id) ?? [];
  const needsResources = !!skill && validScope.length === 0;
  const lock = scopeLocked(running || submitting, !!binding);

  // 会话的 Skill 只跟着这条会话走：切到没有绑定 Skill 的会话时清空，
  // 不能沿用上一条会话（例如图纸会话）的选择，否则会被当成「不可用的 Skill」。
  const appliedFor = useRef<string | null>(null);
  const sessionKey = session?.session_id ?? null;
  useEffect(() => {
    if (saved) {
      setSkillId(JSON.stringify([saved.extension_id, saved.skill_id]));
      setScope(saved.resource_ids);
      appliedFor.current = sessionKey;
    } else if (appliedFor.current !== sessionKey) {
      setSkillId("");
      setScope([]);
      appliedFor.current = sessionKey;
    }
  }, [saved, sessionKey]);

  // 模型：只列服务端确认可用（有模型、有密钥）的厂商；接口不可用时整组隐藏，按当前启用的模型发送。
  const [modelsRes] = useApi("/api/workbench/models");
  const models = modelsRes.state === "ok" ? listOf<TurnModel>(modelsRes, "models").filter((m) => m.provider && m.model) : [];
  const [modelPick, setModelPick] = useState<ModelSelection | null>(() => rememberedModel(ws));
  const chosen = modelPick ? models.find((m) => m.provider === modelPick.provider) : undefined;
  const effective = chosen ?? models.find((m) => m.is_active);
  const thinking: ThinkingMode = effective?.supports_thinking && modelPick?.thinking ? modelPick.thinking : "provider_default";
  const pickModel = (next: ModelSelection | null) => { setModelPick(next); rememberModel(ws, next); };
  const modelSelection: ModelSelection | undefined = (chosen && !chosen.is_active) || thinking !== "provider_default"
    ? { provider: (chosen ?? effective)!.provider, thinking } : undefined;

  const input = useRef<HTMLTextAreaElement>(null);
  // 输入框随内容长高，到上限后内部滚动；工具栏始终一行，运行中不会把卡片撑高。
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const admit = (incoming: PendingAttachment[]) => {
    const r = admitAttachments(attachments, incoming);
    setAttachments(r.accepted);
    setRejected(r.rejected);
  };
  const fromFiles = (files: FileList | File[], source: PendingAttachment["source"]) =>
    admit(Array.from(files).map((f) => ({ id: nextId(), name: f.name || "粘贴的图片", size: f.size, kind: attachmentKind(f.type), source, file: f })));

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const imgs = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (imgs.length) { e.preventDefault(); fromFiles(imgs, "paste"); }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); if (e.dataTransfer?.files?.length) fromFiles(e.dataTransfer.files, "drop"); };

  const submit = async () => {
    const t = text.trim();
    if (!t || running || submitting || needsResources || (skillId && !skill)) return;
    setSubmitting(true);
    try {
    const accepted = await onSend(t, { attachments, ...(modelSelection ? { modelSelection } : {}), ...(skill ? { workbenchSelection: {
      extension_id: skill.extension_id, skill_id: skill.skill_id, skill_name: skill.name,
      resource_ids: validScope, allow_edit: binding?.allow_edit ?? true,
    } } : {}) });
    if (accepted) {
      setText((current) => current === text ? "" : current);
      const sentIds = new Set(attachments.map((a) => a.id));
      setAttachments((current) => current.filter((a) => !sentIds.has(a.id)));
    }
    } finally { setSubmitting(false); }
  };

  const stopIdle = stopState === "idle";
  return (
    <div className="wb-composer" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} data-testid="composer">
      {skills.state === "error" ? <FailureNote outcome={skills.outcome} /> : null}
      {skillId && !skill && skills.state === "ok" ? <p className="inline-alert tone-warn" role="status">当前 Skill 不在可用目录中，请检查扩展状态和资源权限。</p> : null}
      {rejected.length ? <p className="inline-alert tone-warn" role="alert" data-testid="attachment-rejected">{rejected.map((r) => `${r.name}：${r.reason}`).join("；")}</p> : null}
      <div className={`composer-card ${running ? "is-running" : ""}`}>
        {attachments.length ? (
          <ul className="composer-attachments">
            {attachments.map((a) => <li key={a.id} className="composer-attachment"><IconAttachment size={14} aria-hidden="true" /><span>{a.name}</span><button type="button" aria-label={`移除 ${a.name}`} onClick={() => setAttachments(attachments.filter((x) => x.id !== a.id))}>×</button></li>)}
          </ul>
        ) : null}
        <textarea ref={input} className="composer-input" value={text} onChange={(e) => setText(e.target.value)} onPaste={onPaste} rows={1}
          aria-label="输入消息" placeholder={running ? "本轮运行中，可以先写下一句" : "输入消息，Enter 发送，Shift+Enter 换行"} data-testid="composer-input"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
        <div className="composer-toolbar">
          <div className="composer-scope">
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) fromFiles(e.target.files, "upload"); e.target.value = ""; }} />
            <button type="button" className="composer-icon" aria-label="添加附件" title="添加附件：最多 8 个，其中图片最多 4 张；图片 ≤5MB，文件 ≤100MB" onClick={() => fileInput.current?.click()}><IconAttachment size={16} aria-hidden="true" /></button>
            <button type="button" className="composer-icon" aria-label="从托管文件选" title="从托管文件选" onClick={() => setPicker("files")}><IconFolder size={16} aria-hidden="true" /></button>
            <span className="composer-divider" aria-hidden="true" />
            <label className={`composer-chip ${skill ? "is-set" : ""}`} title="Skill">
              <span className="sr-only">Skill</span>
              <select value={skillId} onChange={(e) => {
                setSkillId(e.target.value);
                const next = skillList.find((s) => skillKey(s) === e.target.value);
                const defaults = next?.default_resource_ids?.filter((id) => next.resources.some((r) => r.resource_id === id)) ?? [];
                setScope(next?.selection_mode === "single" ? defaults.slice(0, 1) : defaults);
              }} disabled={lock.locked} aria-label="Skill" data-testid="skill-select">
                <option value="">Skill：不指定</option>
                {skillId && !skill ? <option value={skillId}>{saved?.skill_name ?? "已选 Skill"}（当前不可用）</option> : null}
                {skillList.map((s) => <option key={skillKey(s)} value={skillKey(s)}>{s.name ?? s.skill_id}</option>)}
              </select>
            </label>
            {skill ? (
              <button type="button" className={`composer-chip ${needsResources ? "is-warn" : ""}`} onClick={() => setPicker("resources")} disabled={lock.locked} data-testid="scope-btn"
                title={needsResources ? "请选择此 Skill 的可用资源后发送" : "资源范围"}>资源范围（{validScope.length}）</button>
            ) : null}
            {lock.locked ? <span className="composer-lock" data-testid="scope-locked" title={lock.reason}><IconLock size={14} aria-hidden="true" /><span className="sr-only">{lock.reason}</span></span> : null}
          </div>
          <div className="composer-actions">
            {models.length ? (
              <label className="composer-chip" title={effective ? `${effective.label} · ${effective.model}` : "模型"}>
                <span className="sr-only">模型</span>
                <select value={chosen?.provider ?? ""} aria-label="模型" data-testid="model-select" disabled={running || submitting}
                  onChange={(e) => pickModel(e.target.value ? { provider: e.target.value, thinking: modelPick?.thinking ?? "provider_default" } : null)}>
                  <option value="">{models.find((m) => m.is_active)?.model ?? "默认模型"}（默认）</option>
                  {models.filter((m) => !m.is_active).map((m) => <option key={m.provider} value={m.provider}>{m.model} · {m.label}</option>)}
                </select>
              </label>
            ) : null}
            {effective?.supports_thinking ? (
              <label className="composer-chip" title="思考强度">
                <span className="sr-only">思考强度</span>
                <select value={thinking} aria-label="思考强度" data-testid="thinking-select" disabled={running || submitting}
                  onChange={(e) => pickModel({ provider: (chosen ?? effective).provider, thinking: e.target.value as ThinkingMode })}>
                  {(Object.keys(THINKING_LABEL) as ThinkingMode[]).map((k) => <option key={k} value={k} disabled={k === "disabled" && effective.requires_thinking}>{THINKING_LABEL[k]}</option>)}
                </select>
              </label>
            ) : null}
            {running ? (
              <button type="button" className={`composer-send is-stop ${stopIdle ? "" : "has-label"}`} onClick={onStop} disabled={stopState === "requesting" || stopState === "requested"}
                data-testid="stop-btn" data-stop={stopState} title={stopLabel(stopState)}>
                <IconStop size={14} aria-hidden="true" />
                <span className={stopIdle ? "sr-only" : ""}>{stopLabel(stopState)}</span>
              </button>
            ) : (
              <button type="button" className="composer-send" onClick={() => void submit()} disabled={submitting || !text.trim() || needsResources || (!!skillId && !skill)}
                data-testid="send-btn" title="发送（Enter）">
                <IconSend size={16} aria-hidden="true" />
                <span className="sr-only">{submitting ? "提交中" : "发送"}</span>
              </button>
            )}
          </div>
        </div>
      </div>
      {picker === "resources" && skill ? <Drawer title={`${skill.name} · 资源范围`} onClose={() => setPicker(null)}>
        <p className="muted">{skill.description}</p>
        <ul className="nav-list">{skill.resources.map((r) => <li key={r.resource_id}>
          <label className="field-inline"><input type={skill.selection_mode === "single" ? "radio" : "checkbox"} name="skill-resources"
            checked={validScope.includes(r.resource_id)} disabled={lock.locked}
            onChange={(e) => setScope(skill.selection_mode === "single" ? [r.resource_id] : e.target.checked ? [...validScope, r.resource_id] : validScope.filter((id) => id !== r.resource_id))} />{r.name}</label>
          {r.description ? <p className="muted">{r.description}</p> : null}
        </li>)}</ul>
        {!skill.resources.length ? <p role="status">此 Skill 当前没有可用资源。</p> : null}
        <Button onClick={() => setPicker(null)}>确定范围</Button>
      </Drawer> : null}
      {picker === "files" ? <ManagedFilePicker ws={ws} selected={[]} onClose={() => setPicker(null)} onPick={(files) => {
        admit(files.map((f) => ({ id: nextId(), name: f.original_name ?? f.name ?? f.filename ?? f.file_id, size: f.size_bytes ?? 0, kind: attachmentKind(f.mime_type ?? ""), source: "managed", file_id: f.file_id })));
        setPicker(null);
      }} /> : null}
    </div>
  );
}

function ManagedFilePicker({ ws, selected, onClose, onPick }: { ws: string; selected: string[]; onClose: () => void; onPick: (f: ManagedFile[]) => void }) {
  const page = usePaged<ManagedFile>("/api/storage/files", { workspace_id: ws }, { listKey: "files", param: "cursor", next: "next_cursor" });
  const files = page.first;
  const list = page.items;
  const [sel, setSel] = useState<Set<string>>(new Set(selected));
  return (
    <Drawer title="托管文件" onClose={onClose} testId="managed-picker">
      {files.state === "error" ? <p className="inline-alert tone-warn">文件列表不可读。</p> : null}
      <ul className="nav-list">
        {list.map((f) => (
          <li key={f.file_id}><label><input type="checkbox" checked={sel.has(f.file_id)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(f.file_id); else n.delete(f.file_id); setSel(n); }} /> {f.original_name ?? f.name ?? f.filename ?? f.file_id}</label>
            <p className="muted picker-meta" data-testid="picker-file-meta">{[f.metadata?.folder ? `文件夹 ${f.metadata.folder}` : "根目录", f.size_bytes != null ? `${Math.max(1, Math.round(f.size_bytes / 1024))} KB` : null, f.created_at ? fmtTime(f.created_at) : null, f.file_id].filter(Boolean).join(" · ")}</p></li>
        ))}
      </ul>
      {files.state === "ok" && !list.length ? <p role="status" className="muted">这个工作区还没有托管文件。</p> : null}
      <LoadMore paged={page} testId="picker-load-more" />
      <div className="row-actions">
        <Button onClick={() => onPick(list.filter((f) => sel.has(f.file_id)))}>作为附件</Button>
      </div>
    </Drawer>
  );
}
