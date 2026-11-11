import { Suspense, lazy, useState } from "react";
import { bodyOf, type Query } from "../../api/client";
import { Button } from "../../components/Button";
import type { HttpOutcome } from "../../contracts/auth";
import { listOf, useApi, type Loadable } from "../../kit/useApi";
import { api } from "../../api/client";
import { Chip, ConfirmDialog, Dialog, Drawer, FailureNote, JsonBlock, KeyValues, LoadState, ReceiptNote, Table, Tabs, fmtTime } from "../../kit/ui";
import { useSearchParams } from "../../router";
import { useShell } from "../../app/shellContext";
import type { ExtensionPageProps } from "../registry";
import { NET_BASE, NET_TABS, enc, inspectionRetryGate, net, type Inspection, type InspectionDevice, type NetTab } from "./api";
import { SkillFormDialog, type NetworkSkill } from "./SkillForm";
import { ConnectionFormDialog, DEVICE_ROLES, DeviceFormDialog, ScriptFormDialog, VENDORS, type Connection, type Device, type Region, type Script } from "./forms";

const TAB_LABEL: Record<NetTab, string> = { devices: "设备", connections: "连接", skills: "网络 Skill", inspections: "巡检", scripts: "巡检脚本", topologies: "拓扑", context: "上下文观察" };

function useNet(path: string | null, ws: string, q?: Query) {
  return useApi(path ? `${NET_BASE}${path}` : null, { workspace_id: ws, ...q });
}

function Result({ r }: { r: { label: string; o: HttpOutcome } | null }) {
  if (!r) return null;
  return r.o.kind === "http" && r.o.status < 300 ? <ReceiptNote text={`${r.label}已提交`} /> : <FailureNote outcome={r.o} />;
}

/** network.operations 扩展的前端模块。设备 / 连接 / 巡检等为新目录实现；拓扑为旧画布原样迁入（topology/）。 */
export default function NetworkOperationsPage({ ws }: ExtensionPageProps) {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab") as NetTab | null;
  const tab: NetTab = raw && NET_TABS.includes(raw) ? raw : "devices";
  const id = params.get("id");
  // 统一深链：?tab=<区块>&id=<对象>；拓扑区块按 P-30 只用 `topology`（见 topology/topologyParams.ts）。
  const go = (t: NetTab, nextId?: string | null) => { const n = new URLSearchParams(params); n.set("tab", t); for (const k of ["id", "topology", "topology_id", "node"]) n.delete(k); if (nextId) n.set("id", nextId); setParams(n); };
  return (
    <div className={`netops-page${tab === "topologies" ? " is-canvas" : ""}`} data-testid="netops-page">
      <Tabs label="网络扩展" current={tab} onChange={(t: NetTab) => go(t)} tabs={NET_TABS.map((k) => ({ key: k, label: TAB_LABEL[k] }))} />
      {tab === "devices" ? <Devices ws={ws} /> : null}
      {tab === "connections" ? <Connections ws={ws} /> : null}
      {tab === "skills" ? <Skills ws={ws} /> : null}
      {tab === "inspections" ? <Inspections ws={ws} openId={id} onOpen={(x) => go("inspections", x)} /> : null}
      {tab === "scripts" ? <Scripts ws={ws} /> : null}
      {tab === "topologies" ? <Topologies ws={ws} /> : null}
      {tab === "context" ? <ContextView ws={ws} /> : null}
    </div>
  );
}

const VENDOR_ZH = Object.fromEntries(VENDORS) as Record<string, string>;
const ROLE_ZH = Object.fromEntries(DEVICE_ROLES) as Record<string, string>;
const CONN_STATUS: Record<string, string> = { untested: "未测试", connected: "已连通", verified: "已验证", failed: "测试失败", trust_required: "需核对主机指纹", host_key_changed: "主机指纹已变化", unreachable: "不可达" };

/** 保存后的回读说明：显示服务端回读的关键字段，回读失败如实说「未能回读」。 */
function SavedNote({ label, text, testId }: { label: string; text: string | null; testId: string }) {
  return <p className="readback-note" role="status" data-testid={testId}>{label}已保存；{text ?? "未能回读，状态以列表刷新为准"}</p>;
}

function Devices({ ws }: { ws: string }) {
  const [list, reload] = useNet("/devices", ws);
  const [regions] = useNet("/regions", ws);
  const [conns, reloadConns] = useNet("/connections", ws);
  const [edit, setEdit] = useState<Device | "new" | null>(null);
  const [addConn, setAddConn] = useState<string | null>(null);
  const [del, setDel] = useState<Device | null>(null);
  const [note, setNote] = useState<{ label: string; text: string | null } | null>(null);
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  const devices = listOf<Device>(list, "devices");
  const regionList = listOf<Region>(regions, "regions");
  const regionName = (id?: string) => regionList.find((x) => x.region_id === id)?.name ?? (id || "—");
  const connCount = (id: string) => listOf<Connection>(conns, "connections").filter((c) => c.device_id === id).length;
  return (
    <section data-testid="net-devices">
      <div className="row-actions"><Button variant="primary" onClick={() => setEdit("new")} data-testid="device-new">登记设备</Button></div>
      {note ? <SavedNote label={note.label} text={note.text} testId="device-readback" /> : null}
      <Result r={r} />
      <LoadState value={list} onReload={reload}>{() => (
        <Table testId="devices-table" rows={devices} rowKey={(d) => d.device_id} empty={<p className="muted">还没有登记设备。</p>}
          columns={[
            { key: "n", label: "设备", render: (d) => d.name ?? d.device_id, sortValue: (d) => d.name ?? "" },
            { key: "h", label: "管理地址", render: (d) => d.host ?? "—" },
            { key: "v", label: "厂商 / 角色", render: (d) => `${VENDOR_ZH[d.vendor ?? ""] ?? d.vendor ?? "—"} · ${ROLE_ZH[d.device_type ?? ""] ?? d.device_type ?? "—"}` },
            { key: "m", label: "型号", render: (d) => d.device_model || "—" },
            { key: "r", label: "区域", render: (d) => regionName(d.region_id) },
            { key: "c", label: "连接", render: (d) => String(connCount(d.device_id)) },
            { key: "_a", label: "", render: (d) => <span className="row-actions">
              <Button className="sm" onClick={() => setAddConn(d.device_id)} data-testid="device-add-connection">添加连接</Button>
              <Button className="sm" onClick={() => setEdit(d)}>编辑</Button>
              <Button variant="ghost" className="sm" onClick={() => setDel(d)}>删除</Button></span> },
          ]} />
      )}</LoadState>
      {edit ? <DeviceFormDialog ws={ws} device={edit === "new" ? null : edit} regions={regionList} onClose={() => setEdit(null)}
        onSaved={({ readback }) => { setEdit(null); setNote({ label: "设备", text: readback ? `回读：${readback.name} · ${readback.host} · ${VENDOR_ZH[readback.vendor ?? ""] ?? readback.vendor} · ${ROLE_ZH[readback.device_type ?? ""] ?? readback.device_type}` : null }); reload(); }} /> : null}
      {addConn ? <ConnectionFormDialog ws={ws} devices={devices} deviceId={addConn} onClose={() => setAddConn(null)}
        onSaved={({ readback }) => { setAddConn(null); setNote({ label: "连接", text: readback ? connReadbackText(readback) : null }); reloadConns(); }} /> : null}
      {del ? <ConfirmDialog title="永久删除设备？" details={<p>将硬删除「{del.name}」及其 {connCount(del.device_id)} 条连接；失去全部设备或连接的 Skill 会一并删除。</p>} confirmText={del.name ?? del.device_id} confirmLabel="永久删除" onCancel={() => setDel(null)}
        onConfirm={async () => { const x = del; setDel(null); setR({ label: "删除", o: await net.del(`/devices/${enc(x.device_id)}`, ws) }); reload(); reloadConns(); }} /> : null}
    </section>
  );
}

function connReadbackText(c: Connection) {
  return `回读：${String(c.protocol ?? "").toUpperCase()}:${c.port ?? "?"} · 用户 ${c.username || "—"} · 状态 ${CONN_STATUS[c.status ?? ""] ?? c.status ?? "未上报"}${c.last_error ? `（${c.last_error}）` : ""}`;
}

function Connections({ ws }: { ws: string }) {
  const [list, reloadList] = useNet("/connections", ws);
  const [devs] = useNet("/devices", ws);
  const devices = listOf<Device>(devs, "devices");
  const connections = listOf<Connection>(list, "connections");
  const deviceName = (id?: string) => devices.find((d) => d.device_id === id)?.name ?? id ?? "—";
  const [edit, setEdit] = useState<Connection | "new" | null>(null);
  const [del, setDel] = useState<Connection | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  const reload = reloadList;
  const [test, setTest] = useState<{ id: string; o: HttpOutcome } | null>(null);
  const [accept, setAccept] = useState<{ id: string; fingerprint: string } | null>(null);
  const runTest = async (id: string, extra: Record<string, unknown> = {}) => { setTest({ id, o: await net.post(`/connections/${enc(id)}/test`, ws, extra) }); reload(); };
  const testBody = test ? bodyOf<{ ok?: boolean; requires_host_key_acceptance?: boolean; fingerprint?: string; observed_fingerprint?: string; error?: string }>(test.o) : null;
  return (
    <section data-testid="net-connections">
      <div className="row-actions"><Button variant="primary" onClick={() => setEdit("new")} data-testid="connection-new">添加连接</Button></div>
      {note ? <SavedNote label="连接" text={note} testId="connection-readback" /> : null}
      <Result r={r} />
      <LoadState value={list} onReload={reloadList}>{() => (
        <Table testId="connections-table" rows={connections} rowKey={(c) => c.connection_id} empty={<p className="muted">还没有连接。先在「设备」里登记设备。</p>}
          columns={[
            { key: "d", label: "设备", render: (c) => deviceName(c.device_id) },
            { key: "n", label: "连接", render: (c) => `${c.name ?? ""} ${String(c.protocol ?? "").toUpperCase()}:${c.port ?? "?"}`.trim() },
            { key: "u", label: "用户", render: (c) => c.username || "—" },
            { key: "s", label: "状态", render: (c) => <Chip tone={c.status === "connected" || c.status === "verified" ? "ok" : c.status === "untested" ? "neutral" : "warn"}>{CONN_STATUS[c.status ?? ""] ?? c.status ?? "未上报"}</Chip> },
            { key: "fp", label: "主机指纹", render: (c) => (c.host_key_fingerprint ? <code>{String(c.host_key_fingerprint)}</code> : "未登记") },
            { key: "t", label: "", render: (c) => <span className="row-actions">
              <Button className="sm" onClick={() => void runTest(String(c.connection_id))} data-testid="conn-test">测试连接</Button>
              <Button className="sm" onClick={() => setEdit(c)}>编辑</Button>
              <Button variant="ghost" className="sm" onClick={() => setDel(c)}>删除</Button></span> },
          ]} />
      )}</LoadState>
      {edit ? <ConnectionFormDialog ws={ws} connection={edit === "new" ? null : edit} devices={devices} onClose={() => setEdit(null)}
        onSaved={({ readback }) => { setEdit(null); setNote(readback ? connReadbackText(readback) : null); reloadList(); }} /> : null}
      {del ? <ConfirmDialog title="删除连接？" details={<p>将硬删除 {deviceName(del.device_id)} 的 {String(del.protocol ?? "").toUpperCase()} 连接；失去全部有效连接的 Skill 将一并删除。</p>} confirmLabel="删除" onCancel={() => setDel(null)}
        onConfirm={async () => { const x = del; setDel(null); setR({ label: "删除", o: await net.del(`/connections/${enc(x.connection_id)}`, ws) }); reloadList(); }} /> : null}
      {test ? (
        <div className="card" data-testid="conn-test-result">
          {testBody?.requires_host_key_acceptance ? (
            <div className="inline-alert tone-warn" role="alert">
              主机指纹未登记或已变化：<code>{testBody.fingerprint ?? testBody.observed_fingerprint ?? "未返回"}</code>。接受前请线下核对。
              <Button variant="danger" onClick={() => setAccept({ id: test.id, fingerprint: String(testBody.fingerprint ?? testBody.observed_fingerprint ?? "") })} data-testid="accept-fingerprint">接受该指纹</Button>
            </div>
          ) : test.o.kind === "http" && test.o.status < 300 && testBody?.ok ? <p className="inline-alert tone-ok" role="status">连接测试通过（只读探测）。</p> : <FailureNote outcome={test.o} />}
          <details><summary>原始结果</summary><JsonBlock value={test.o.kind === "http" ? test.o.body : null} /></details>
        </div>
      ) : null}
      {accept ? <ConfirmDialog title="接受主机指纹？" testId="fingerprint-dialog" confirmText={accept.fingerprint} confirmLabel="接受并测试"
        details={<><p>高风险：接受后，此连接会信任以下指纹。指纹被替换可能意味着中间人攻击。</p><KeyValues items={[["连接", accept.id], ["指纹", <code key="f">{accept.fingerprint}</code>]]} /></>}
        onCancel={() => setAccept(null)} onConfirm={async () => { const a = accept; setAccept(null); await runTest(a.id, { accept_host_key: true, accepted_fingerprint: a.fingerprint }); }} /> : null}
    </section>
  );
}

function Skills({ ws }: { ws: string }) {
  const [list, reload] = useNet("/skills", ws);
  const [devs] = useNet("/devices", ws);
  const [conns] = useNet("/connections", ws);
  const [scripts] = useNet("/scripts", ws);
  const [edit, setEdit] = useState<NetworkSkill | "new" | null>(null);
  const [del, setDel] = useState<NetworkSkill | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pub, setPub] = useState<{ skill: NetworkSkill; enable: boolean } | null>(null);
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  return (
    <section data-testid="net-skills">
      <p className="muted">网络 Skill 属于本扩展；发布后可在工作台选择。设备读取与配置是内置能力，设备账号决定实际权限。</p>
      <Button variant="primary" onClick={() => setEdit("new")}>新建网络 Skill</Button>
      {note ? <p className="readback-note" role="status">{note}</p> : null}
      <Result r={r} />
      <LoadState value={list} onReload={reload}>{() => <Table rows={listOf<NetworkSkill>(list, "skills")} rowKey={(s) => s.skill_id} columns={[
        { key: "n", label: "Skill", render: (s) => s.name },
        { key: "e", label: "状态", render: (s) => <Chip tone={s.enabled ? "ok" : "neutral"}>{s.enabled ? "已发布" : "草稿"}</Chip> },
        { key: "scope", label: "范围", render: (s) => `${s.device_ids.length} 台设备 · ${s.connection_ids.length} 条连接 · ${s.allowed_tool_ids.length} 项工具` },
        { key: "a", label: "", render: (s) => <span className="row-actions"><Button onClick={() => setEdit(s)}>编辑</Button><Button onClick={() => setPub({ skill: s, enable: !s.enabled })} data-testid="skill-publish">{s.enabled ? "撤回发布" : "发布"}</Button><Button variant="ghost" onClick={() => setDel(s)}>删除</Button></span> },
      ]} />}</LoadState>
      {edit ? <SkillFormDialog ws={ws} skill={edit === "new" ? null : edit} devices={listOf<Device>(devs, "devices")} connections={listOf<Connection>(conns, "connections")} scripts={listOf<Script>(scripts, "scripts")} onClose={() => setEdit(null)} onSaved={(back) => { setEdit(null); setNote(back ? `已保存并回读：${back.name} · ${back.enabled ? "已发布" : "草稿"} · ${back.device_ids.length} 台设备 · ${back.connection_ids.length} 条连接` : "已保存；未能回读，请刷新核对。"); reload(); }} /> : null}
      {pub ? <ConfirmDialog title={pub.enable ? "发布这个网络 Skill？" : "撤回发布？"} confirmText={pub.enable ? pub.skill.skill_id : undefined} confirmLabel={pub.enable ? "发布" : "撤回"}
        details={<><p>{pub.enable ? "发布后，工作台可以选择它执行；设备配置操作会写入设备。" : "撤回后工作台不能再选择它。"}</p><KeyValues items={[["设备", pub.skill.device_ids.join("、")], ["连接", pub.skill.connection_ids.join("、")], ["工具", pub.skill.allowed_tool_ids.join("、")]]} /></>}
        onCancel={() => setPub(null)} onConfirm={async () => { const p = pub; setPub(null); setR({ label: p.enable ? "发布" : "撤回", o: await net.put(`/skills/${enc(p.skill.skill_id)}`, ws, { ...p.skill, enabled: p.enable }) }); reload(); }} /> : null}
      {del ? <ConfirmDialog title="永久删除网络 Skill？" details={<p>将删除「{del.name}」。</p>} confirmText={del.name} confirmLabel="永久删除" onCancel={() => setDel(null)} onConfirm={async () => { const s = del; setDel(null); setR({ label: "删除", o: await net.del(`/skills/${enc(s.skill_id)}`, ws) }); reload(); }} /> : null}
    </section>
  );
}

function Scripts({ ws }: { ws: string }) {
  const [list, reload] = useNet("/scripts", ws);
  const [edit, setEdit] = useState<Script | "new" | null>(null);
  const [del, setDel] = useState<Script | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  return (
    <section data-testid="net-scripts">
      <div className="row-actions"><Button variant="primary" onClick={() => setEdit("new")} data-testid="script-new">新建巡检脚本</Button></div>
      {note ? <SavedNote label="脚本" text={note} testId="script-readback" /> : null}
      <Result r={r} />
      <LoadState value={list} onReload={reload}>{() => (
        <Table testId="scripts-table" rows={listOf<Script>(list, "scripts")} rowKey={(x) => x.script_id} empty={<p className="muted">还没有巡检脚本。</p>}
          columns={[
            { key: "n", label: "脚本", render: (x) => <>{x.name ?? x.script_id}{x.description ? <div className="muted">{x.description}</div> : null}</> },
            { key: "v", label: "厂商", render: (x) => (x.vendors ?? []).map((v) => VENDOR_ZH[v] ?? v).join("、") || "—" },
            { key: "c", label: "命令 / 检查项", render: (x) => `${x.commands?.length ?? 0} 条命令 · ${x.checks?.length ?? 0} 个检查项` },
            { key: "s", label: "来源 / 版本", render: (x) => `${x.builtin ? "内置" : x.source === "starter" ? "入门模板" : "自定义"} · v${x.version ?? 1}` },
            { key: "t", label: "更新", render: (x) => fmtTime(x.updated_at) },
            { key: "_a", label: "", render: (x) => <span className="row-actions">
              <Button className="sm" onClick={() => setEdit(x)} data-testid="script-edit">编辑</Button>
              <Button variant="ghost" className="sm" onClick={() => setDel(x)}>删除</Button></span> },
          ]} />
      )}</LoadState>
      {edit ? <ScriptFormDialog ws={ws} script={edit === "new" ? null : edit} onClose={() => setEdit(null)}
        onSaved={({ readback }) => { setEdit(null); setNote(readback ? `回读：「${readback.name}」v${readback.version ?? "?"} · ${readback.commands?.length ?? 0} 条命令 · ${readback.checks?.length ?? 0} 个检查项 · ${(readback.vendors ?? []).map((v) => VENDOR_ZH[v] ?? v).join("、")}` : null); reload(); }} /> : null}
      {del ? <ConfirmDialog title="删除巡检脚本？" details={<p>将删除「{del.name}」。已发起的巡检不受影响。</p>} confirmLabel="删除" onCancel={() => setDel(null)}
        onConfirm={async () => { const x = del; setDel(null); setR({ label: "删除", o: await net.del(`/scripts/${enc(x.script_id)}`, ws) }); reload(); }} /> : null}
    </section>
  );
}

const INSPECTION_STATUS: Record<string, string> = { queued: "已入队", running: "执行中", succeeded: "全部目标已采集", partial: "部分目标未采集", failed: "执行报错", cancelled: "已取消", cancel_requested: "已请求取消 · 等待终态", unknown: "结果未知 · 需核对" };

function Inspections({ ws, openId, onOpen }: { ws: string; openId: string | null; onOpen: (id: string | null) => void }) {
  const [list, reload] = useNet("/inspections", ws);
  const [create, setCreate] = useState(false);
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  return (
    <section data-testid="net-inspections">
      <Button variant="primary" onClick={() => setCreate(true)}>新建巡检</Button>
      <Result r={r} />
      <LoadState value={list} onReload={reload}>{() => (
        <Table testId="inspections-table" rows={listOf<Inspection>(list, "inspections")} rowKey={(t) => t.task_id} onRowOpen={(t) => onOpen(t.task_id)} empty={<p className="muted">还没有巡检。</p>}
          columns={[{ key: "id", label: "巡检", render: (t) => <code>{t.task_id}</code> }, { key: "s", label: "状态", render: (t) => <Chip tone={t.status === "partial" ? "warn" : t.status === "unknown" ? "unknown" : "neutral"}>{INSPECTION_STATUS[t.status ?? ""] ?? t.status ?? "未上报"}</Chip> },
            { key: "n", label: "目标数", render: (t) => String(t.connection_ids?.length ?? "—") }, { key: "t", label: "时间", render: (t) => fmtTime(t.created_at) }]} />
      )}</LoadState>
      {create ? <CreateInspection ws={ws} onClose={() => setCreate(false)} onDone={(o) => { setR({ label: "巡检入队", o }); setCreate(false); reload(); }} /> : null}
      {openId ? <InspectionDetail ws={ws} taskId={openId} onClose={() => onOpen(null)} onOpenOther={onOpen} /> : null}
    </section>
  );
}

function CreateInspection({ ws, onClose, onDone }: { ws: string; onClose: () => void; onDone: (o: HttpOutcome) => void }) {
  const [conns] = useNet("/connections", ws);
  const [scripts] = useNet("/scripts", ws);
  const [sel, setSel] = useState<string[]>([]);
  const [mode, setMode] = useState<"commands" | "script">("commands");
  const [commands, setCommands] = useState("");
  const [scriptId, setScriptId] = useState("");
  const [confirm, setConfirm] = useState(false);
  const body = mode === "commands" ? { connection_ids: sel, commands: commands.split("\n").map((c) => c.trim()).filter(Boolean) } : { connection_ids: sel, script_id: scriptId };
  return (
    <Dialog title="新建巡检（只读）" onClose={onClose} footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!sel.length || (mode === "commands" ? !commands.trim() : !scriptId)} onClick={() => setConfirm(true)}>下一步</Button></>}>
      <fieldset><legend>目标连接</legend>{listOf<{ connection_id: string; name?: string }>(conns, "connections").map((c) => (
        <label key={c.connection_id}><input type="checkbox" checked={sel.includes(c.connection_id)} onChange={(e) => setSel(e.target.checked ? [...sel, c.connection_id] : sel.filter((x) => x !== c.connection_id))} /> {c.name ?? c.connection_id}</label>
      ))}</fieldset>
      <label><input type="radio" checked={mode === "commands"} onChange={() => setMode("commands")} /> 自定义命令</label>
      <label><input type="radio" checked={mode === "script"} onChange={() => setMode("script")} /> 巡检脚本</label>
      {mode === "commands" ? <textarea rows={5} value={commands} onChange={(e) => setCommands(e.target.value)} aria-label="命令，每行一条" /> : (
        <select value={scriptId} onChange={(e) => setScriptId(e.target.value)} aria-label="巡检脚本"><option value="">选择脚本</option>{listOf<{ script_id: string; name?: string }>(scripts, "scripts").map((s) => <option key={s.script_id} value={s.script_id}>{s.name ?? s.script_id}</option>)}</select>
      )}
      {confirm ? <ConfirmDialog title="确认下发巡检" danger={false} confirmLabel="入队" testId="inspection-confirm"
        details={<><p>将连接以下设备并执行命令：</p><KeyValues items={[["连接", sel.join("、")], ["命令 / 脚本", mode === "commands" ? (body as { commands: string[] }).commands.join("；") : scriptId]]} /></>}
        onCancel={() => setConfirm(false)} onConfirm={async () => { setConfirm(false); onDone(await net.post("/inspections", ws, body)); }} /> : null}
    </Dialog>
  );
}

function InspectionDetail({ ws, taskId, onClose, onOpenOther }: { ws: string; taskId: string; onClose: () => void; onOpenOther: (id: string) => void }) {
  const [task, reload] = useNet(`/inspections/${enc(taskId)}`, ws);
  const [evidence, reloadEvidence] = useNet(`/inspections/${enc(taskId)}/evidence`, ws);
  const [confirm, setConfirm] = useState(false);
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  const t = task.state === "ok" ? (task.data as { task?: Inspection }).task : undefined;
  const devices = evidenceDevices(evidence, t);
  const gate = t ? inspectionRetryGate(t, devices) : null;
  return (
    <Drawer title={`巡检 ${taskId}`} onClose={onClose} testId="inspection-detail">
      <LoadState value={task} onReload={reload}>{() => t ? (
        <>
          <KeyValues items={[["状态", INSPECTION_STATUS[t.status ?? ""] ?? t.status], ["重试自", t.retry_of_task_id || "—"], ["更新", fmtTime(t.updated_at)]]} />
          {t.status === "unknown" ? <p className="inline-alert tone-unknown" role="alert" data-testid="inspection-unknown">结果未知 · 需核对</p> : null}
          <div className="row-actions">
            {t.status === "running" || t.status === "queued" ? <Button onClick={async () => { setR({ label: "取消请求", o: await net.post(`/inspections/${enc(taskId)}/cancel`, ws) }); reload(); }}>请求取消</Button> : null}
            <Button onClick={() => setConfirm(true)} disabled={!gate?.allowed} title={gate?.reason} data-testid="inspection-retry">重试未成功目标</Button>
            {gate && !gate.allowed && gate.reason ? <span className="muted" data-testid="inspection-retry-gate">{gate.reason}</span> : null}
          </div>
          <Result r={r} />
          <h3>证据（逐设备）</h3>
          <LoadState value={evidence} onReload={reloadEvidence}>{() => (
            <Table testId="inspection-evidence" rows={devices} rowKey={(d) => d.connection_id} columns={[
              { key: "n", label: "设备", render: (d) => d.name ?? d.connection_id },
              { key: "s", label: "状态", render: (d) => <Chip tone={d.status === "succeeded" ? "ok" : d.status === "unknown" ? "unknown" : "warn"}>{d.status ?? "未上报"}</Chip> },
              { key: "e", label: "错误 / 失败命令", render: (d) => <>{d.error}{(d.failed_commands ?? []).map((c, i) => <div key={i}><code>{c.command}</code> {c.error_code}</div>)}</> },
            ]} />
          )}</LoadState>
          <details><summary>原始证据</summary><LoadState value={evidence}>{(d) => <JsonBlock value={d} />}</LoadState></details>
        </>
      ) : <p className="muted">巡检不存在。</p>}</LoadState>
      {confirm && gate?.allowed ? <ConfirmDialog title="重试未成功目标" danger={false} confirmLabel="重试" testId="inspection-retry-dialog"
        details={<><p>只会对以下未成功的目标再执行一次（已成功的不会重放）：</p><ul>{gate.targets.map((x) => <li key={x}><code>{x}</code></li>)}</ul></>}
        onCancel={() => setConfirm(false)} onConfirm={async () => {
          setConfirm(false);
          const o = await net.post(`/inspections/${enc(taskId)}/retry`, ws);
          setR({ label: "重试入队", o });
          const next = bodyOf<{ task?: { task_id?: string } }>(o)?.task?.task_id;
          if (next && next !== taskId) onOpenOther(next);
        }} /> : null}
    </Drawer>
  );
}

function evidenceDevices(evidence: Loadable<Record<string, unknown>>, t?: Inspection): InspectionDevice[] {
  if (evidence.state === "ok") {
    const d = evidence.data as { presentation?: { devices?: InspectionDevice[] }; analysis_projection?: { devices?: InspectionDevice[] }; devices?: InspectionDevice[] };
    const list = d.presentation?.devices ?? d.analysis_projection?.devices ?? d.devices;
    if (Array.isArray(list)) return list;
  }
  return Object.entries(t?.results ?? {}).map(([id, v]) => ({ connection_id: id, name: v.name, status: v.status }));
}

// ── 拓扑：旧可编辑画布原样迁入 topology/，经 TopologyMount 接新壳（深链 / 未保存守卫 / 工作区）──
const TopologyMount = lazy(() => import("./topology/TopologyMount"));

function Topologies({ ws }: { ws: string }) {
  const { auth } = useShell();
  return (
    <section className="netops-canvas-host" data-testid="net-topologies">
      <Suspense fallback={<p className="muted">正在加载拓扑画布…</p>}>
        <TopologyMount ws={ws} username={auth.username ?? ""} />
      </Suspense>
    </section>
  );
}

function ContextView({ ws }: { ws: string }) {
  const [ctx, reload] = useNet("/context", ws);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [del, setDel] = useState(false);
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  const observations = ctx.state === "ok" ? ((ctx.data as { observations?: { observation_id: string; summary?: string; observed_at?: string; status?: string }[] }).observations ?? []) : [];
  return (
    <section data-testid="net-context">
      <Result r={r} />
      <h3>观察记录</h3>
      {sel.size ? <Button variant="danger" onClick={() => setDel(true)}>删除所选（{sel.size}）</Button> : null}
      <LoadState value={ctx} onReload={reload}>{() => (
        <>
          <Table rows={observations} rowKey={(o) => o.observation_id} selectable selected={sel} onSelect={setSel} empty={<p className="muted">没有观察记录。</p>}
            columns={[{ key: "s", label: "观察", render: (o) => o.summary ?? o.observation_id }, { key: "st", label: "状态", render: (o) => o.status ?? "—" }, { key: "t", label: "时间", render: (o) => fmtTime(o.observed_at) }]} />
          <details><summary>完整上下文</summary><JsonBlock value={ctx.state === "ok" ? ctx.data : null} /></details>
        </>
      )}</LoadState>
      {del ? <ConfirmDialog title={`删除 ${sel.size} 条观察？`} details={<p>{[...sel].join("、")}</p>} confirmLabel="删除" onCancel={() => setDel(false)}
        onConfirm={async () => { setDel(false); setR({ label: "删除", o: await api.del(`${NET_BASE}/observations/batch-delete`, { workspace_id: ws, observation_ids: [...sel], confirm: true }, { workspace_id: ws }) }); setSel(new Set()); reload(); }} /> : null}
    </section>
  );
}
