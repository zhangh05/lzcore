import { readWorkbenchSelection, type WorkbenchSelection } from "../../contracts/workbench";
import { boundSessionSelection } from "../../extension-modules/registry";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { Button } from "../../components/Button";
import { IconAttachment, IconFolder, IconSend } from "../../components/Icon";
import { useApi, listOf } from "../../kit/useApi";
import { LoadMore, usePaged } from "../../kit/usePaged";
import { Drawer, FailureNote, fmtTime } from "../../kit/ui";
import { admitAttachments, attachmentKind, scopeLocked, stopLabel, type PendingAttachment, type SessionSummary, type StopState } from "./model";

interface Skill { extension_id: string; skill_id: string; name: string; description?: string; resources: { resource_id: string; name: string; description?: string }[]; default_resource_ids?: string[]; selection_mode?: "single" | "multiple" }
const skillKey = (skill: Skill) => JSON.stringify([skill.extension_id, skill.skill_id]);
export interface SendOptions { attachments: PendingAttachment[]; workbenchSelection?: WorkbenchSelection; resumeTaskId?: string }

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

  useEffect(() => {
    if (saved) {
      setSkillId(JSON.stringify([saved.extension_id, saved.skill_id]));
      setScope(saved.resource_ids);
    }
  }, [saved]);

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
    const accepted = await onSend(t, { attachments, ...(skill ? { workbenchSelection: {
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

  return (
    <div className="wb-composer" onDragOver={(e) => e.preventDefault()} onDrop={onDrop} data-testid="composer">
      {skills.state === "error" ? <FailureNote outcome={skills.outcome} /> : null}
      {skillId && !skill ? <p className="inline-alert tone-warn" role="status">当前 Skill 不在可用目录中，请检查扩展状态和资源权限。</p> : null}
      {needsResources ? <p className="muted" role="status">请选择此 Skill 的可用资源后发送。</p> : null}
      {attachments.length ? (
        <ul className="attachments">
          {attachments.map((a) => <li key={a.id} className="status-chip">{a.name}<button type="button" className="btn ghost" aria-label={`移除 ${a.name}`} onClick={() => setAttachments(attachments.filter((x) => x.id !== a.id))}>×</button></li>)}
        </ul>
      ) : null}
      {rejected.length ? <p className="inline-alert tone-warn" role="alert" data-testid="attachment-rejected">{rejected.map((r) => `${r.name}：${r.reason}`).join("；")}</p> : null}
      <div className="composer-card">
        <textarea className="composer-input" value={text} onChange={(e) => setText(e.target.value)} onPaste={onPaste} rows={3}
          aria-label="输入消息" placeholder={running ? "本轮运行中，可以先写下一句" : "输入消息，Enter 发送，Shift+Enter 换行"} data-testid="composer-input"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }} />
        <div className="composer-toolbar">
          <div className="composer-scope">
            <label className="field-inline">Skill
              <select value={skillId} onChange={(e) => {
                setSkillId(e.target.value);
                const next = skillList.find((s) => skillKey(s) === e.target.value);
                const defaults = next?.default_resource_ids?.filter((id) => next.resources.some((r) => r.resource_id === id)) ?? [];
                setScope(next?.selection_mode === "single" ? defaults.slice(0, 1) : defaults);
              }} disabled={lock.locked} aria-label="Skill" data-testid="skill-select">
                <option value="">不指定</option>
                {skillId && !skill ? <option value={skillId}>{saved?.skill_name ?? "已选 Skill"}（当前不可用）</option> : null}
                {skillList.map((s) => <option key={skillKey(s)} value={skillKey(s)}>{s.name ?? s.skill_id}</option>)}
              </select>
            </label>
            <Button variant="ghost" className="sm" onClick={() => setPicker("resources")} disabled={lock.locked || !skill} data-testid="scope-btn">资源范围（{validScope.length}）</Button>
            {lock.locked ? <span className="muted" data-testid="scope-locked">{lock.reason}</span> : null}
          </div>
          <div className="composer-actions">
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) fromFiles(e.target.files, "upload"); e.target.value = ""; }} />
            <Button variant="ghost" className="sm" icon={<IconAttachment size={15} aria-hidden="true" />} title="最多 8 个，其中图片最多 4 张；图片 ≤5MB，文件 ≤100MB" onClick={() => fileInput.current?.click()}>添加附件</Button>
            <Button variant="ghost" className="sm" icon={<IconFolder size={15} aria-hidden="true" />} onClick={() => setPicker("files")}>从托管文件选</Button>
            {running ? (
              <Button variant="danger" onClick={onStop} disabled={stopState === "requesting" || stopState === "requested"} data-testid="stop-btn" data-stop={stopState}>{stopLabel(stopState)}</Button>
            ) : null}
            <Button variant="primary" icon={<IconSend size={15} aria-hidden="true" />} onClick={() => void submit()} disabled={running || submitting || !text.trim() || needsResources || (!!skillId && !skill)} data-testid="send-btn">{running ? "运行中" : submitting ? "提交中" : "发送"}</Button>
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
