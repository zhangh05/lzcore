import { useState } from "react";
import { Button } from "../../components/Button";
import { NAMES } from "../../contracts/naming";
import { ConfirmDialog, Drawer, FailureNote } from "../../kit/ui";
import type { HttpOutcome } from "../../contracts/auth";
import { filterSessions, groupSessionsByDay, type SessionSummary } from "./model";
import { sessionOps, useSessions } from "./useSessions";

export function SessionColumn({ ws, currentId, onOpen, onNew, collapsed, onToggle }: {
  ws: string; currentId: string | null; onOpen: (id: string) => void; onNew: () => void; collapsed: boolean; onToggle: () => void;
}) {
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [q, setQ] = useState("");
  const { list, error, reload } = useSessions(ws, status, currentId);
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<SessionSummary | null>(null);
  const [managing, setManaging] = useState<SessionSummary | null>(null);
  const [opError, setOpError] = useState<HttpOutcome | null>(null);
  const run = async (p: Promise<HttpOutcome>) => { const o = await p; setOpError(o.kind === "http" && o.status < 300 ? null : o); reload(); };

  if (collapsed) {
    return (
      <aside className="wb-sessions is-collapsed" aria-label="会话栏（已收起）">
        <Button variant="ghost" onClick={onToggle} aria-label="展开会话栏">»</Button>
        <Button variant="primary" onClick={onNew} aria-label={NAMES.newSession} data-testid="new-session-collapsed">＋</Button>
      </aside>
    );
  }
  const groups = groupSessionsByDay(filterSessions(list ?? [], q));
  return (
    <aside className="wb-sessions" aria-label="会话栏" data-testid="session-column">
      <div className="row-actions">
        <Button variant="primary" onClick={onNew} data-testid="new-session-btn">{NAMES.newSession}</Button>
        <Button variant="ghost" onClick={onToggle} aria-label="收起会话栏">«</Button>
      </div>
      <input className="input" placeholder="筛选会话" value={q} onChange={(e) => setQ(e.target.value)} aria-label="筛选会话" />
      <div className="seg" role="group" aria-label="会话状态">
        <button type="button" className={`tab ${status === "active" ? "is-active" : ""}`} onClick={() => setStatus("active")}>进行中</button>
        <button type="button" className={`tab ${status === "archived" ? "is-active" : ""}`} onClick={() => setStatus("archived")} data-testid="sessions-archived-tab">已归档</button>
      </div>
      {error ? <FailureNote outcome={error} onRetryRead={reload} /> : null}
      {opError ? <FailureNote outcome={opError} /> : null}
      {list && list.length === 0 && !error ? <p className="muted">{status === "active" ? "还没有会话。点「新建会话」开始。" : "没有已归档的会话。"}</p> : null}
      {groups.map((g) => (
        <section key={g.label} className="session-group">
          <h3 className="session-group-title">{g.label}</h3>
          <ul className="nav-list">
            {g.items.map((s) => (
              <li key={s.session_id} className={`session-item ${s.session_id === currentId ? "is-active" : ""}`} data-session={s.session_id}>
                {editing?.id === s.session_id ? (
                  <form className="session-rename" onSubmit={(e) => { e.preventDefault(); const t = editing.title.trim(); setEditing(null); if (t) void run(sessionOps.rename(ws, s.session_id, t)); }}>
                    <input className="input" aria-label="新名称" value={editing.title} autoFocus onChange={(e) => setEditing({ id: s.session_id, title: e.target.value })}
                      onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }} />
                    <Button type="submit" onMouseDown={(e) => e.preventDefault()}>保存</Button>
                  </form>
                ) : (
                  <>
                    <button type="button" className="session-open" onClick={() => onOpen(s.session_id)} aria-current={s.session_id === currentId ? "true" : undefined}>{s.title || "未命名会话"}</button>
                    <button type="button" className="btn ghost session-menu-button" aria-label={`管理会话 ${s.title || s.session_id}`} onClick={() => setManaging(s)}>⋯</button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {managing ? <Drawer title="会话操作" onClose={() => setManaging(null)}>
        <p>{managing.title || "未命名会话"}</p>
        <div className="row-actions">
          {status === "active" ? <>
            <Button onClick={() => { setEditing({ id: managing.session_id, title: managing.title ?? "" }); setManaging(null); }}>重命名</Button>
            <Button onClick={() => { void run(sessionOps.archive(ws, managing.session_id)); setManaging(null); }}>归档</Button>
          </> : <>
            <Button onClick={() => { void run(sessionOps.restore(ws, managing.session_id)); setManaging(null); }} data-testid="session-restore">恢复</Button>
            <Button onClick={() => { setDeleting(managing); setManaging(null); }} data-testid="session-delete">永久删除</Button>
          </>}
        </div>
      </Drawer> : null}
      {deleting ? (
        <ConfirmDialog title="永久删除会话？" confirmText={`DELETE ${deleting.session_id}`} confirmLabel="永久删除"
          details={<p>将永久删除「{deleting.title || deleting.session_id}」及其消息，无法恢复。</p>}
          onCancel={() => setDeleting(null)} onConfirm={async () => { const s = deleting; setDeleting(null); await run(sessionOps.remove(ws, s.session_id)); }} />
      ) : null}
    </aside>
  );
}
