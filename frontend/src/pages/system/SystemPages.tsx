import { useState, type ReactNode } from "react";
import { api, bodyOf, enc } from "../../api/client";
import { useShell } from "../../app/shellContext";
import { Button } from "../../components/Button";
import { EmptyState, PageHeader } from "../../components/EmptyState";
import { IconWarningCircle } from "../../components/Icon";
import type { HttpOutcome } from "../../contracts/auth";
import { ASSIGNABLE_ROLES, NAMES, isAdmin, roleLabel } from "../../contracts/naming";
import { listOf, useApi } from "../../kit/useApi";
import { Chip, ConfirmDialog, Dialog, Drawer, FailureNote, KeyValues, LoadState, ObjectView, PreviewApply, RawData, ReceiptNote, Table, Tabs, fmtTime, useUrlTab } from "../../kit/ui";
import { ModelSettings } from "./ModelSettings";
import { ContextView, HealthView, ReadSection, SelfcheckView, UsageView, statusLabel } from "./statusViews";

function Result({ r }: { r: { label: string; o: HttpOutcome } | null }) {
  if (!r) return null;
  return r.o.kind === "http" && r.o.status < 300 ? <ReceiptNote text={`${r.label}已提交`} /> : <FailureNote outcome={r.o} />;
}

/** 管理页统一门：非管理员看到原因，不是 404。 */
function AdminGate({ title, children }: { title: string; children: ReactNode }) {
  const { auth } = useShell();
  if (!isAdmin(auth)) {
    return <div className="page"><PageHeader title={title} /><EmptyState icon={<IconWarningCircle size={24} />} title="需要管理员权限" reason={`当前角色：${roleLabel(auth.role)}。此页只对管理员 / 平台管理员开放。`} testId="admin-required" /></div>;
  }
  return <>{children}</>;
}

// ── 系统状态 ─────────────────────────────────────────────
const STATUS_TABS = ["health", "usage", "selfcheck", "prompts", "context", "retention"] as const;
export function SystemStatusPage() {
  const { workspaceId: ws } = useShell();
  const [tab, setTab] = useUrlTab(STATUS_TABS, "health");
  if (!ws) return null;
  return (
    <div className="page" data-testid="system-status">
      <PageHeader title={NAMES.systemStatus} subtitle="运行是否健康、用了多少资源、自检结果，以及数据保留策略。" />
      <Tabs label="系统状态" current={tab} onChange={setTab} tabs={[
        { key: "health", label: "运行时健康" }, { key: "usage", label: "用量" }, { key: "selfcheck", label: "自检" },
        { key: "prompts", label: "提示词库" }, { key: "context", label: "上下文运行时" }, { key: "retention", label: "保留与归档" }]} />
      {tab === "health" ? <HealthView ws={ws} /> : null}
      {tab === "usage" ? <UsageView ws={ws} /> : null}
      {tab === "selfcheck" ? <SelfcheckView ws={ws} /> : null}
      {tab === "prompts" ? <Prompts /> : null}
      {tab === "context" ? <ContextView ws={ws} /> : null}
      {tab === "retention" ? <RetentionArchive ws={ws} /> : null}
    </div>
  );
}

/** 通用读取分区：标题 + 产品化投影 + 折叠原始数据（路径只在折叠区）。 */
function Read({ title, path, query }: { title: string; path: string; query?: Record<string, string> }) {
  return <ReadSection title={title} path={path} query={query} />;
}

interface PromptRec { prompt_id: string; title?: string; version?: string; task?: string; status?: string; description?: string; allowed_providers?: string[] }
function Prompts() {
  const [list, reload] = useApi("/api/prompts");
  const [open, setOpen] = useState<string | null>(null);
  const [one] = useApi(open ? `/api/prompts/${enc(open)}` : null);
  return (
    <LoadState value={list} onReload={reload}>{(d) => (
      <>
        <Table testId="prompts-table" rows={listOf<PromptRec>(list, "prompts")} rowKey={(p) => p.prompt_id} onRowOpen={(p) => setOpen(p.prompt_id)}
          columns={[
            { key: "id", label: "提示词", render: (p) => p.title ?? p.prompt_id, sortValue: (p) => p.prompt_id },
            { key: "task", label: "任务", render: (p) => p.task ?? "—", sortValue: (p) => p.task ?? "" },
            { key: "v", label: "版本", render: (p) => p.version ?? "—" },
            { key: "status", label: "状态", render: (p) => <Chip tone={p.status === "enabled" ? "ok" : "neutral"}>{p.status === "enabled" ? "启用" : statusLabel(p.status)}</Chip> },
            { key: "desc", label: "说明", render: (p) => p.description ?? "—" },
            { key: "prov", label: "允许的 Provider", render: (p) => (p.allowed_providers ?? []).join("、") || "—" },
          ]} />
        <RawData value={d} path="/api/prompts" />
        {open ? (
          <Drawer title={`提示词 ${open}`} onClose={() => setOpen(null)} testId="prompt-detail">
            <LoadState value={one}>{(x) => <><ObjectView value={(x as { prompt?: unknown }).prompt ?? x} /><RawData value={x} path={`/api/prompts/${enc(open)}`} /></>}</LoadState>
          </Drawer>
        ) : null}
      </>
    )}</LoadState>
  );
}

function RetentionArchive({ ws }: { ws: string }) {
  const base = `/api/workspaces/${enc(ws)}`;
  const [items, reloadItems] = useApi(`${base}/archive/items`);
  const [restore, setRestore] = useState<{ month?: string; kind?: string; name?: string } | null>(null);
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  return (
    <>
      <PreviewApply label="保留策略（retention）" testId="retention"
        preview={() => api.get(`${base}/retention/preview`)}
        apply={() => api.post(`${base}/retention/apply`, { dry_run: false, confirm: true })}
        renderPreview={(b) => <><ObjectView value={b} /><RawData value={b} label="原始数据（预览响应）" /></>} />
      <PreviewApply label="归档（archive）" testId="archive"
        preview={() => api.get(`${base}/archive/preview`)}
        apply={() => api.post(`${base}/archive/apply`, { dry_run: false, confirm: true })}
        renderPreview={(b) => <><ObjectView value={b} /><RawData value={b} label="原始数据（预览响应）" /></>} />
      <section className="card"><h3>已归档条目</h3>
        <Result r={r} />
        <LoadState value={items} onReload={reloadItems}>{() => (
          <Table rows={listOf<{ month?: string; kind?: string; name?: string }>(items, "items")} rowKey={(i) => `${i.month}/${i.kind}/${i.name}`}
            columns={[{ key: "m", label: "月份", render: (i) => i.month ?? "—" }, { key: "k", label: "类型", render: (i) => i.kind ?? "—" }, { key: "n", label: "名称", render: (i) => i.name ?? "—" },
              { key: "a", label: "", render: (i) => <Button onClick={() => setRestore(i)} data-testid="archive-restore">恢复</Button> }]} />
        )}</LoadState>
      </section>
      <div className="grid-2">
        <Read title="保留策略审计" path={`${base}/retention/audits`} />
        <Read title="归档审计" path={`${base}/archive/audits`} />
      </div>
      {restore ? <ConfirmDialog title="从归档恢复？" details={<KeyValues items={[["月份", restore.month], ["类型", restore.kind], ["名称", restore.name]]} />} confirmLabel="恢复"
        onCancel={() => setRestore(null)} onConfirm={async () => { const x = restore; setRestore(null); setR({ label: "恢复", o: await api.post(`${base}/archive/restore`, { ...x, confirm: true }) }); reloadItems(); }} /> : null}
    </>
  );
}

// ── 设置：Provider 管理（按 role / platform_admin 渲染） ──────────────
export function SettingsPage() {
  const { auth } = useShell();
  const admin = isAdmin(auth);
  return (
    <div className="page" data-testid="settings-page">
      <PageHeader title={NAMES.settings} subtitle={admin ? "模型服务：助手当前使用的模型，以及可以切换或接入的服务。" : "查看助手使用的模型服务（修改需要管理员）。"} />
      <ModelSettings admin={admin} platform={auth.platform_admin === true} />
    </div>
  );
}

// ── 用户与组织（A14） ─────────────────────────────────────
interface UserRec { username: string; role?: string; organization_id?: string; workspace_ids?: string[]; home_workspace_id?: string; enabled?: boolean }
/** 编辑草稿必须从回读的用户记录起步：organization_id / workspace_ids 原样带回，不回落到 default。 */
export function userEditDraft(u: UserRec) {
  return { role: u.role ?? "viewer", organization_id: u.organization_id ?? "", workspace_ids: [...(u.workspace_ids ?? [])], enabled: u.enabled !== false, password: "" };
}

export function UsersPage() {
  const { auth, workspaces } = useShell();
  const [tab, setTab] = useUrlTab(["users", "orgs"] as const, "users");
  const [users, reload] = useApi("/api/identity/users");
  const [orgs, reloadOrgs] = useApi("/api/identity/organizations");
  const [edit, setEdit] = useState<UserRec | null>(null);
  const [draft, setDraft] = useState<ReturnType<typeof userEditDraft> | null>(null);
  const [del, setDel] = useState<UserRec | null>(null);
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  const wsList = workspaces.kind === "ready" ? workspaces.list : [];
  const platform = auth.platform_admin === true;
  return (
    <AdminGate title={NAMES.users}>
      <div className="page" data-testid="users-page">
        <PageHeader title={NAMES.users} subtitle={platform ? "管理账号、角色和所属组织。" : "查看账号与角色（修改需要平台管理员）。"} />
        <Tabs label="用户与组织" current={tab} onChange={setTab} tabs={[{ key: "users", label: "用户" }, { key: "orgs", label: "组织" }]} />
        <Result r={r} />
        {tab === "users" ? (
          <LoadState value={users} onReload={reload}>{() => (
            <Table testId="users-table" rows={listOf<UserRec>(users, "users")} rowKey={(u) => u.username}
              columns={[
                { key: "u", label: "用户", render: (u) => u.username },
                { key: "role", label: "角色", render: (u) => roleLabel(u.role) },
                { key: "org", label: "组织", render: (u) => u.organization_id ?? "—" },
                { key: "ws", label: "工作区", render: (u) => (u.workspace_ids ?? []).join("、") || "—" },
                { key: "st", label: "状态", render: (u) => (u.enabled === false ? "已停用" : "启用") },
                { key: "a", label: "", render: (u) => platform && ASSIGNABLE_ROLES.includes(u.role as typeof ASSIGNABLE_ROLES[number]) ? <span className="row-actions">
                  <Button onClick={async () => {
                    // 从回读开始：先 GET 最新列表，再以该记录为草稿。
                    const o = await api.get("/api/identity/users");
                    const latest = bodyOf<{ users?: UserRec[] }>(o)?.users?.find((x) => x.username === u.username) ?? u;
                    setEdit(latest); setDraft(userEditDraft(latest));
                  }} data-testid={`user-edit-${u.username}`}>编辑</Button>
                  <Button variant="ghost" onClick={() => setDel(u)}>删除</Button></span> : null },
              ]} />
          )}</LoadState>
        ) : (
          <OrganizationsView orgs={orgs} reloadOrgs={reloadOrgs} users={listOf<UserRec>(users, "users")} reloadUsers={reload} platform={platform} />
        )}
        {edit && draft ? (
          <Dialog title={`编辑用户 ${edit.username}`} onClose={() => setEdit(null)} testId="user-edit-dialog" footer={<>
            <Button onClick={() => setEdit(null)}>取消</Button>
            <Button variant="primary" disabled={draft.workspace_ids.length === 0} onClick={async () => {
              const body: Record<string, unknown> = { role: draft.role, organization_id: draft.organization_id, workspace_ids: draft.workspace_ids, enabled: draft.enabled };
              if (draft.password) body.password = draft.password;
              setR({ label: "保存", o: await api.put(`/api/identity/users/${enc(edit.username)}`, body) }); setEdit(null); reload();
            }} data-testid="user-save">保存</Button></>}>
            <label className="field"><span>角色</span><select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>{ASSIGNABLE_ROLES.map((x) => <option key={x} value={x}>{roleLabel(x)}</option>)}</select></label>
            <p className="muted">组织：<code>{draft.organization_id || "（未上报）"}</code>（保持回读值）</p>
            <fieldset><legend>工作区（至少一个）</legend>
              {Array.from(new Set([...draft.workspace_ids, ...wsList.map((w) => w.workspace_id)])).map((id) => (
                <label key={id}><input type="checkbox" checked={draft.workspace_ids.includes(id)} onChange={(e) => setDraft({ ...draft, workspace_ids: e.target.checked ? [...draft.workspace_ids, id] : draft.workspace_ids.filter((x) => x !== id) })} /> {id}</label>
              ))}
            </fieldset>
            <label><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} /> 启用</label>
            <label className="field"><span>新密码（留空不改）</span><input type="password" autoComplete="new-password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} /></label>
          </Dialog>
        ) : null}
        {del ? <ConfirmDialog title="删除用户？" details={<p>将删除用户 {del.username}。</p>} confirmText={del.username} confirmLabel="删除" onCancel={() => setDel(null)}
          onConfirm={async () => { const u = del; setDel(null); setR({ label: "删除", o: await api.del(`/api/identity/users/${enc(u.username)}`) }); reload(); }} /> : null}
      </div>
    </AdminGate>
  );
}

// ── 组织与成员（A14）：GET/POST /api/identity/organizations，GET/POST …/<id>/memberships ──
interface OrgRec { organization_id: string; name?: string; workspace_ids?: string[] }
interface MembershipRec { username: string; organization_id?: string; role?: string; workspace_ids?: string[] }

/**
 * 成员写入草稿：编辑已有成员时从回读的 membership 起步（workspace_ids 原样带回）；
 * 可选工作区只限组织回读的 workspace_ids（后端要求成员工作区是组织工作区的子集）。不写死任何工作区。
 */
export function membershipDraft(m: MembershipRec | null, org: OrgRec) {
  const allowed = new Set(org.workspace_ids ?? []);
  return {
    username: m?.username ?? "",
    role: m?.role && (ASSIGNABLE_ROLES as readonly string[]).includes(m.role) ? m.role : "viewer",
    workspace_ids: (m?.workspace_ids ?? []).filter((w) => allowed.has(w)),
  };
}

function OrganizationsView({ orgs, reloadOrgs, users, reloadUsers, platform }: {
  orgs: Parameters<typeof listOf>[0]; reloadOrgs: () => void; users: UserRec[]; reloadUsers: () => void; platform: boolean;
}) {
  const [form, setForm] = useState({ organization_id: "", name: "" });
  const [open, setOpen] = useState<string | null>(null);
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  const list = listOf<OrgRec>(orgs, "organizations");
  const current = list.find((o) => o.organization_id === open) ?? null;
  return (
    <section data-testid="orgs-view">
      {platform ? (
        <form className="row-actions" data-testid="org-create" onSubmit={async (e) => {
          e.preventDefault();
          setR({ label: "创建组织", o: await api.post("/api/identity/organizations", { organization_id: form.organization_id.trim(), name: form.name.trim() }) });
          setForm({ organization_id: "", name: "" }); reloadOrgs();
        }}>
          <input className="input" aria-label="组织 id" placeholder="组织 id" value={form.organization_id} onChange={(e) => setForm({ ...form, organization_id: e.target.value })} />
          <input className="input" aria-label="组织名称" placeholder="组织名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Button type="submit" disabled={!form.organization_id.trim() || !form.name.trim()} data-testid="org-create-submit">创建组织</Button>
        </form>
      ) : <p className="muted">只有平台管理员可以创建组织、查看与写入成员。</p>}
      <Result r={r} />
      <LoadState value={orgs} onReload={reloadOrgs}>{() => (
        <Table testId="orgs-table" rows={list} rowKey={(o) => o.organization_id} empty={<p className="muted">还没有组织。</p>}
          columns={[
            { key: "id", label: "组织", render: (o) => <>{o.name ?? o.organization_id} <code>{o.organization_id}</code></> },
            { key: "ws", label: "组织工作区", render: (o) => (o.workspace_ids ?? []).join("、") || "—" },
            { key: "a", label: "", render: (o) => platform ? <Button onClick={() => setOpen(o.organization_id)} data-testid={`org-members-${o.organization_id}`}>成员</Button> : null },
          ]} />
      )}</LoadState>
      {current ? <OrgMembers org={current} users={users} onClose={() => setOpen(null)} onWritten={reloadUsers} /> : null}
    </section>
  );
}

function OrgMembers({ org, users, onClose, onWritten }: { org: OrgRec; users: UserRec[]; onClose: () => void; onWritten: () => void }) {
  const path = `/api/identity/organizations/${enc(org.organization_id)}/memberships`;
  const [members, reload] = useApi(path);
  const [edit, setEdit] = useState<{ isNew: boolean; draft: ReturnType<typeof membershipDraft> } | null>(null);
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  const [readback, setReadback] = useState<string | null>(null);
  const orgWs = org.workspace_ids ?? [];
  const openEdit = async (username: string | null) => {
    // 从回读开始：先重新 GET 成员列表，再以该成员记录为草稿。
    const o = await api.get(path);
    const latest = username ? bodyOf<{ memberships?: MembershipRec[] }>(o)?.memberships?.find((m) => m.username === username) ?? null : null;
    setEdit({ isNew: !username, draft: membershipDraft(latest, org) });
  };
  const save = async () => {
    if (!edit) return;
    const d = edit.draft;
    const o = await api.post(path, { username: d.username, role: d.role, workspace_ids: d.workspace_ids });
    setR({ label: "成员写入", o }); setEdit(null); setReadback(null);
    if (o.kind === "http" && o.status < 300) {
      // 受理后回读成员列表，以服务端记录为准。
      const back = await api.get(path);
      const m = bodyOf<{ memberships?: MembershipRec[] }>(back)?.memberships?.find((x) => x.username === d.username);
      setReadback(m ? `回读：${m.username} · ${roleLabel(m.role)} · 工作区 ${(m.workspace_ids ?? []).join("、") || "无"}` : "回读未找到该成员，请刷新核对。");
      onWritten();
    }
    reload();
  };
  return (
    <Drawer title={`组织成员 · ${org.name ?? org.organization_id}`} onClose={onClose} testId="org-members">
      <div className="row-actions"><Button variant="primary" onClick={() => void openEdit(null)} data-testid="member-add">添加 / 更新成员</Button></div>
      <Result r={r} />
      {readback ? <p className="muted" data-testid="membership-readback">{readback}</p> : null}
      <LoadState value={members} onReload={reload}>{() => (
        <Table testId="members-table" rows={listOf<MembershipRec>(members, "memberships")} rowKey={(m) => m.username} empty={<p className="muted">该组织还没有成员。</p>}
          columns={[
            { key: "u", label: "用户", render: (m) => m.username },
            { key: "r", label: "角色", render: (m) => roleLabel(m.role) },
            { key: "w", label: "工作区", render: (m) => (m.workspace_ids ?? []).join("、") || "—" },
            { key: "a", label: "", render: (m) => <Button onClick={() => void openEdit(m.username)} data-testid={`member-edit-${m.username}`}>编辑</Button> },
          ]} />
      )}</LoadState>
      {edit ? (
        <Dialog title={edit.isNew ? "添加 / 更新成员" : `编辑成员 ${edit.draft.username}`} onClose={() => setEdit(null)} testId="member-dialog" footer={<>
          <Button onClick={() => setEdit(null)}>取消</Button>
          <Button variant="primary" disabled={!edit.draft.username} onClick={() => void save()} data-testid="member-save">保存</Button></>}>
          {edit.isNew ? (
            <label className="field"><span>用户</span>
              <select aria-label="用户" value={edit.draft.username} onChange={(e) => setEdit({ ...edit, draft: { ...edit.draft, username: e.target.value } })}>
                <option value="">请选择</option>
                {users.map((u) => <option key={u.username} value={u.username}>{u.username}{u.organization_id && u.organization_id !== org.organization_id ? `（当前属于 ${u.organization_id}）` : ""}</option>)}
              </select>
            </label>
          ) : null}
          <label className="field"><span>角色</span>
            <select aria-label="成员角色" value={edit.draft.role} onChange={(e) => setEdit({ ...edit, draft: { ...edit.draft, role: e.target.value } })}>
              {ASSIGNABLE_ROLES.map((x) => <option key={x} value={x}>{roleLabel(x)}</option>)}
            </select>
          </label>
          <fieldset><legend>工作区（只能选组织已分配的工作区）</legend>
            {orgWs.length ? orgWs.map((id) => (
              <label key={id}><input type="checkbox" checked={edit.draft.workspace_ids.includes(id)} onChange={(e) => setEdit({ ...edit, draft: { ...edit.draft, workspace_ids: e.target.checked ? [...edit.draft.workspace_ids, id] : edit.draft.workspace_ids.filter((x) => x !== id) } })} /> {id}</label>
            )) : <p className="muted" data-testid="org-no-workspaces">该组织回读的工作区为空；成员将没有任何工作区访问权。</p>}
          </fieldset>
          <p className="muted">保存是按用户名覆盖写入（upsert）：该用户会归属到本组织，并把用户的角色与工作区一并改成这里的值。</p>
        </Dialog>
      ) : null}
    </Drawer>
  );
}

// ── 工作区管理（A13-管理） ─────────────────────────────────
export function WorkspacesAdminPage() {
  const [list, reload] = useApi("/api/workspaces");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [create, setCreate] = useState("");
  const [rename, setRename] = useState<{ from: string; to: string } | null>(null);
  const [del, setDel] = useState<string[] | null>(null);
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  return (
    <AdminGate title={NAMES.workspaceAdmin}>
      <div className="page" data-testid="workspaces-admin">
        <PageHeader title={NAMES.workspaceAdmin} subtitle="创建、重命名或删除工作区，查看各工作区的存储状态。" />
        <form className="row-actions" onSubmit={async (e) => { e.preventDefault(); setR({ label: "创建", o: await api.post("/api/workspaces", { workspace_id: create.trim() }) }); setCreate(""); reload(); }}>
          <input className="input" value={create} onChange={(e) => setCreate(e.target.value)} placeholder="新工作区 id" aria-label="新工作区 id" />
          <Button type="submit" disabled={!create.trim()}>创建</Button>
          {sel.size ? <Button variant="danger" onClick={() => setDel([...sel])} data-testid="ws-batch-delete">删除所选（{sel.size}）</Button> : null}
        </form>
        <Result r={r} />
        <LoadState value={list} onReload={reload}>{() => (
          <Table testId="workspaces-table" rows={listOf<{ workspace_id: string; name?: string }>(list, "workspaces")} rowKey={(w) => w.workspace_id} selectable selected={sel} onSelect={setSel} onRowOpen={(w) => setOpen(w.workspace_id)}
            columns={[{ key: "id", label: "工作区", render: (w) => w.name ?? w.workspace_id }, { key: "raw", label: "id", render: (w) => <code>{w.workspace_id}</code> },
              { key: "a", label: "", render: (w) => <span className="row-actions"><Button onClick={() => setRename({ from: w.workspace_id, to: w.workspace_id })}>改名</Button><Button variant="ghost" onClick={() => setDel([w.workspace_id])}>删除</Button></span> }]} />
        )}</LoadState>
        {open ? <WorkspaceDetail ws={open} onClose={() => setOpen(null)} /> : null}
        {rename ? <Dialog title={`改名 ${rename.from}`} onClose={() => setRename(null)} footer={<><Button onClick={() => setRename(null)}>取消</Button><Button variant="primary" onClick={async () => { const x = rename; setRename(null); setR({ label: "改名", o: await api.post(`/api/workspaces/${enc(x.from)}/rename`, { new_workspace_id: x.to }) }); reload(); }}>保存</Button></>}>
          <label className="field"><span>新 id</span><input value={rename.to} onChange={(e) => setRename({ ...rename, to: e.target.value })} /></label>
        </Dialog> : null}
        {del ? <ConfirmDialog title={del.length > 1 ? `删除 ${del.length} 个工作区？` : "删除工作区？"} details={<p>将删除：{del.map((d) => <code key={d}>{d} </code>)}。其中的会话、文件、记忆都会被删除。</p>}
          confirmText={del.length > 1 ? `DELETE ${del.length}` : del[0]} confirmLabel="删除" testId="ws-delete-dialog" onCancel={() => setDel(null)}
          onConfirm={async () => {
            const ids = del; setDel(null); setSel(new Set());
            setR({ label: "删除", o: ids.length > 1 ? await api.post("/api/workspaces/batch-delete", { workspace_ids: ids, confirm: true }) : await api.del(`/api/workspaces/${enc(ids[0])}`, { confirm: true }, { confirm: true }) });
            reload();
          }} /> : null}
      </div>
    </AdminGate>
  );
}

function WorkspaceDetail({ ws, onClose }: { ws: string; onClose: () => void }) {
  const base = `/api/workspaces/${enc(ws)}`;
  const [state, reloadState] = useApi(`${base}/state`);
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  const memoryEnabled = state.state === "ok" ? ((state.data as { state?: { memory_enabled?: boolean }; workspace?: { memory_enabled?: boolean } }).state?.memory_enabled ?? (state.data as { workspace?: { memory_enabled?: boolean } }).workspace?.memory_enabled) : undefined;
  return (
    <Dialog title={`工作区 ${ws}`} onClose={onClose} testId="ws-detail">
      <LoadState value={state} onReload={reloadState}>{(d) => <><ObjectView value={d} /><RawData value={d} path={`${base}/state`} /></>}</LoadState>
      <label><input type="checkbox" checked={memoryEnabled !== false} disabled={memoryEnabled === undefined} onChange={async (e) => { setR({ label: "设置", o: await api.put(`${base}/settings`, { memory_enabled: e.target.checked }) }); reloadState(); }} /> 启用记忆（唯一可改的工作区设置）</label>
      <Result r={r} />
      <Read title="工作区状态" path={`${base}/status`} />
      <Read title="存储健康" path={`${base}/storage/health`} />
    </Dialog>
  );
}

// ── 备份与生产（A15） ─────────────────────────────────────
export function BackupsPage() {
  const [list, reload] = useApi("/api/admin/backups");
  const [restore, setRestore] = useState<string | null>(null);
  const [keep, setKeep] = useState(10);
  const [prune, setPrune] = useState(false);
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  return (
    <AdminGate title={NAMES.backups}>
      <div className="page" data-testid="backups-page">
        <PageHeader title={NAMES.backups} subtitle="创建与恢复备份，并检查是否满足上线条件。" />
        <div className="row-actions">
          <Button variant="primary" onClick={async () => { setR({ label: "创建备份", o: await api.post("/api/admin/backups", {}) }); reload(); }}>创建备份</Button>
          <label className="field-inline">保留最近 <input type="number" min={1} value={keep} onChange={(e) => setKeep(Number(e.target.value) || 1)} aria-label="保留数量" /> 份</label>
          <Button onClick={() => setPrune(true)}>清理旧备份</Button>
        </div>
        <Result r={r} />
        <LoadState value={list} onReload={reload}>{() => (
          <Table testId="backups-table" rows={listOf<{ backup_id: string; created_at?: string; size_bytes?: number }>(list, "backups")} rowKey={(b) => b.backup_id}
            columns={[{ key: "id", label: "备份", render: (b) => <code>{b.backup_id}</code> }, { key: "t", label: "时间", render: (b) => fmtTime(b.created_at) },
              { key: "a", label: "", render: (b) => <Button variant="danger" onClick={() => setRestore(b.backup_id)} data-testid="backup-restore">恢复</Button> }]} />
        )}</LoadState>
        <Read title="生产就绪检查" path="/api/admin/production" />
        {restore ? <ConfirmDialog title="从备份恢复？" testId="restore-dialog" confirmText="RESTORE" confirmLabel="恢复" onCancel={() => setRestore(null)}
          details={<p>将用备份 <code>{restore}</code> 覆盖当前全部数据（后端会先保留回滚副本）。这一步影响所有工作区。</p>}
          onConfirm={async ({ confirmation }) => { const id = restore; setRestore(null); setR({ label: "恢复", o: await api.post(`/api/admin/backups/${enc(id)}/restore`, { confirmation }) }); reload(); }} /> : null}
        {prune ? <ConfirmDialog title="清理旧备份？" details={<p>只保留最近 {keep} 份，其余删除。</p>} confirmLabel="清理" onCancel={() => setPrune(false)}
          onConfirm={async () => { setPrune(false); setR({ label: "清理", o: await api.post("/api/admin/backups/prune", { keep }) }); reload(); }} /> : null}
      </div>
    </AdminGate>
  );
}

// ── 生态导入 ───────────────────────────────────────────────
export function EcosystemPage() {
  const { workspaceId: ws } = useShell();
  const [providers] = useApi(ws ? "/api/ecosystem/providers" : null, { workspace_id: ws ?? "" });
  const [source, setSource] = useState("");
  if (!ws) return null;
  return (
    <AdminGate title={NAMES.ecosystem}>
      <div className="page" data-testid="ecosystem-page">
        <PageHeader title={NAMES.ecosystem} subtitle="从外部导入 Skill 与工具配置，先预览、确认后再应用。" />
        <LoadState value={providers}>{(d) => <><ObjectView value={d} /><RawData value={d} path="/api/ecosystem/providers" /></>}</LoadState>
        <label className="field"><span>导入源（provider / 路径）</span><input value={source} onChange={(e) => setSource(e.target.value)} /></label>
        <PreviewApply label="导入" testId="ecosystem-import"
          preview={() => api.post("/api/ecosystem/import/preview", { source }, { workspace_id: ws })}
          apply={() => api.post("/api/ecosystem/import/apply", { source, confirm: true }, { workspace_id: ws })}
          renderPreview={(b) => <><ObjectView value={b} /><RawData value={b} label="原始数据（预览响应）" /></>} />
      </div>
    </AdminGate>
  );
}

// ── 作业 worker（仅管理员） ───────────────────────────────
export function WorkersPage() {
  const [status, reload] = useApi("/api/jobs/worker/status");
  const [confirm, setConfirm] = useState(false);
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  return (
    <AdminGate title={NAMES.workers}>
      <div className="page" data-testid="workers-page">
        <PageHeader title={NAMES.workers} subtitle="后台执行作业的进程状态；可手动处理一轮排队作业。" />
        <LoadState value={status} onReload={reload}>{(d) => <><ObjectView value={d} /><RawData value={d} path="/api/jobs/worker/status" /></>}</LoadState>
        <Button onClick={() => setConfirm(true)}>手动执行一轮</Button>
        <Result r={r} />
        {confirm ? <ConfirmDialog title="手动执行一轮 worker？" details={<p>会从队列取作业执行，可能产生外部写入。</p>} confirmLabel="执行" onCancel={() => setConfirm(false)}
          onConfirm={async () => { setConfirm(false); setR({ label: "执行请求", o: await api.post("/api/jobs/worker/run-once", {}) }); reload(); }} /> : null}
      </div>
    </AdminGate>
  );
}
