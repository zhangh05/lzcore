import { Suspense, lazy, useState } from "react";
import { bodyOf } from "../../api/client";
import { Button } from "../../components/Button";
import type { HttpOutcome } from "../../contracts/auth";
import type { Loadable } from "../../kit/useApi";
import { api } from "../../api/client";
import { Chip, ConfirmDialog, Dialog, Drawer, JsonBlock, KeyValues, LoadState, Table, Tabs, fmtTime } from "../../kit/ui";
import { Navigate, useSearchParams } from "../../router";
import { useShell } from "../../app/shellContext";
import type { ExtensionPageProps } from "../registry";
import { NET_BASE, enc, inspectionRetryGate, net, type Inspection, type InspectionDevice } from "./api";
import type { NetworkSkill } from "./SkillForm";
import type { Connection, Device, Region } from "./forms";
import { DeviceInventory } from "./DeviceInventory";
import { ScriptLibrary, SkillSummary, SkillsBoard } from "./SkillStudio";
import { MetricCard } from "../../components/arc/metric-card/metric-card";
import { Result, connHealth, deviceHealth, listOf, useNet } from "./shared";

export const DEVICES_PATH = "/extensions/network.operations/manage";
export const TOPOLOGY_PATH = "/extensions/network.operations/topology";
export const SKILLS_PATH = "/extensions/network.operations/skills";

type DeviceView = "devices" | "inspections" | "context";
type SkillView = "skills" | "scripts";
const DEVICE_VIEWS: readonly DeviceView[] = ["devices", "inspections", "context"];
const SKILL_VIEWS: readonly SkillView[] = ["skills", "scripts"];

/**
 * network.operations 扩展的前端模块。manifest 给出三个互相独立的入口，同一模块按挂载路径分派：
 * - 网络设备（/manage）：设备清单与连接、巡检、观察记录；
 * - 网络拓扑（/topology）：拓扑画布，独占整页；
 * - 网络 Skill（/skills）：Skill 与巡检脚本。
 * 旧深链：/manage?tab=topologies → /topology（保留 topology、node）；/manage?tab=skills|scripts → /skills。
 */
export default function NetworkOperationsPage({ ws, mountPath }: ExtensionPageProps) {
  const [params] = useSearchParams();
  const raw = params.get("tab");
  if (mountPath === SKILLS_PATH) return <SkillsPage ws={ws} />;
  if (mountPath === TOPOLOGY_PATH) return <TopologyPage ws={ws} />;
  if (raw === "topologies") return <Navigate to={legacyHref(TOPOLOGY_PATH, params, ["topology", "topology_id", "node"])} replace />;
  if (raw === "skills" || raw === "scripts") return <Navigate to={legacyHref(SKILLS_PATH, params, raw === "scripts" ? [] : ["id"], raw === "scripts" ? "scripts" : null)} replace />;
  return <DevicesPage ws={ws} />;
}

/** 旧深链换到独立入口：保留工作区与指定参数，丢掉旧的 tab。 */
function legacyHref(path: string, params: URLSearchParams, keep: string[], tab: string | null = null) {
  const n = new URLSearchParams();
  for (const k of ["ws", ...keep]) { const v = params.get(k); if (v) n.set(k, v); }
  if (tab) n.set("tab", tab);
  const q = n.toString();
  return q ? `${path}?${q}` : path;
}

function useView<T extends string>(views: readonly T[], fallback: T, alias: Record<string, T> = {}) {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab") ?? "";
  const view = (views as readonly string[]).includes(raw) ? (raw as T) : alias[raw] ?? fallback;
  const go = (t: T, nextId?: string | null) => {
    const n = new URLSearchParams(params); n.set("tab", t);
    n.delete("id");
    if (nextId) n.set("id", nextId);
    setParams(n);
  };
  return { view, go, id: params.get("id"), params, setParams };
}

function DevicesPage({ ws }: { ws: string }) {
  const { view, go, id, params, setParams } = useView<DeviceView>(DEVICE_VIEWS, "devices", { connections: "devices" });
  const [devState, reloadDevices] = useNet("/devices", ws);
  const [connState, reloadConnections] = useNet("/connections", ws);
  const [regionState] = useNet("/regions", ws);
  const [inspState] = useNet("/inspections", ws);
  const devices = listOf<Device>(devState, "devices");
  const connections = listOf<Connection>(connState, "connections");
  const inspections = listOf<Inspection>(inspState, "inspections");
  const selectDevice = (deviceId: string | null) => { const n = new URLSearchParams(params); if (deviceId) n.set("device", deviceId); else n.delete("device"); setParams(n, { replace: true }); };
  return (
    <div className="netops-page" data-testid="netops-page">
      <FleetSummary devices={devices} connections={connections} inspections={inspections} />
      <Tabs label="网络设备视图" current={view} onChange={(t: DeviceView) => go(t)} tabs={[
        { key: "devices", label: "设备", count: devices.length },
        { key: "inspections", label: "巡检", count: inspections.length },
        { key: "context", label: "观察记录" },
      ]} />
      {view === "devices" ? <DeviceInventory ws={ws} devices={devices} devicesState={devState} reloadDevices={reloadDevices} connections={connections}
        reloadConnections={reloadConnections} regions={listOf<Region>(regionState, "regions")} selectedId={params.get("device")} onSelect={selectDevice} /> : null}
      {view === "inspections" ? <Inspections ws={ws} openId={id} onOpen={(x) => go("inspections", x)} /> : null}
      {view === "context" ? <ContextView ws={ws} /> : null}
    </div>
  );
}

/** 设备概览：Arc MetricCard 一行四格——设备数、可连通连接、需关注设备、巡检。 */
function FleetSummary({ devices, connections, inspections }: { devices: Device[]; connections: Connection[]; inspections: Inspection[] }) {
  const tones = connections.map((c) => connHealth(c.status));
  const ok = tones.filter((t) => t === "ok").length;
  const warn = tones.filter((t) => t === "warn").length;
  const untested = tones.length - ok - warn;
  const attention = devices.filter((d) => { const h = deviceHealth(connections.filter((c) => c.device_id === d.device_id)); return h === "warn" || h === "none"; }).length;
  const latest = [...inspections].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0];
  const vendors = new Set(devices.map((d) => d.vendor).filter(Boolean)).size;
  return (
    <div className="metric-row" role="group" aria-label="设备概览">
      <MetricCard label="设备" value={devices.length} context={vendors ? `${vendors} 个厂商` : "尚未登记"} />
      <MetricCard label="连接健康" value={ok} suffix={`/${tones.length}`} context={tones.length ? `可连通 ${ok} · 未测试 ${untested} · 异常 ${warn}` : "还没有连接"} />
      <MetricCard label="需关注" value={attention} context={attention ? "无连接或测试失败" : "全部正常"} />
      <MetricCard label="巡检" value={inspections.length} context={latest ? `最近：${INSPECTION_STATUS[latest.status ?? ""] ?? latest.status ?? "未上报"} · ${fmtTime(latest.created_at)}` : "暂无巡检"} />
    </div>
  );
}

function TopologyPage({ ws }: { ws: string }) {
  return (
    <div className="netops-page is-canvas" data-testid="netops-topology">
      <Topologies ws={ws} />
    </div>
  );
}

function SkillsPage({ ws }: { ws: string }) {
  const { view, go } = useView<SkillView>(SKILL_VIEWS, "skills");
  const [skillState, reloadSkills] = useNet("/skills", ws);
  const [devState] = useNet("/devices", ws);
  const [connState] = useNet("/connections", ws);
  const [scriptState] = useNet("/scripts", ws);
  const skills = listOf<NetworkSkill>(skillState, "skills");
  const devices = listOf<Device>(devState, "devices");
  const connections = listOf<Connection>(connState, "connections");
  const scripts = listOf(scriptState, "scripts");
  return (
    <div className="netops-page" data-testid="netops-skills">
      <SkillSummary skills={skills} scripts={scripts.length} />
      <Tabs label="网络 Skill 视图" current={view} onChange={(t: SkillView) => go(t)} tabs={[
        { key: "skills", label: "Skill", count: skills.length },
        { key: "scripts", label: "巡检脚本", count: scripts.length },
      ]} />
      {view === "skills" ? <SkillsBoard ws={ws} skillsState={skillState} skills={skills} reload={reloadSkills} devices={devices} connections={connections} /> : null}
      {view === "scripts" ? <ScriptLibrary ws={ws} /> : null}
    </div>
  );
}

const INSPECTION_STATUS: Record<string, string> = { queued: "已入队", running: "执行中", succeeded: "全部目标已采集", partial: "部分目标未采集", failed: "执行报错", cancelled: "已取消", cancel_requested: "已请求取消 · 等待终态", unknown: "结果未知 · 需核对" };

function Inspections({ ws, openId, onOpen }: { ws: string; openId: string | null; onOpen: (id: string | null) => void }) {
  const [list, reload] = useNet("/inspections", ws);
  const [create, setCreate] = useState(false);
  const [r, setR] = useState<{ label: string; o: HttpOutcome } | null>(null);
  return (
    <section data-testid="net-inspections">
      <div className="studio-toolbar"><p className="muted">巡检只下发只读命令，逐台记录证据；部分失败可只重试未成功的目标。</p><Button variant="primary" onClick={() => setCreate(true)}>新建巡检</Button></div>
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
            <Button onClick={() => setConfirm(true)} disabled={!gate?.allowed} title={gate?.reason} data-testid="inspection-retry">{gate?.scope === "evidence_recollection" ? "重新采集证据" : "重试未成功目标"}</Button>
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
      {confirm && gate?.allowed ? <ConfirmDialog title={gate.scope === "evidence_recollection" ? "重新采集证据" : "重试未成功目标"} danger={false} confirmLabel="重试" testId="inspection-retry-dialog"
        details={<><p>{gate.scope === "evidence_recollection" ? "上次命令已执行但证据没能保存，将对以下全部目标重新只读采集：" : "只会对以下未成功的目标再执行一次（已成功的不会重放）："}</p><ul>{gate.targets.map((x) => <li key={x}><code>{x}</code></li>)}</ul></>}
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

// ── 拓扑：可编辑画布在 topology/，经 TopologyMount 接新壳（深链 / 未保存守卫 / 工作区）──
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
