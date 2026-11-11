import { Suspense, lazy, useState } from "react";
import { bodyOf } from "../../api/client";
import { Button } from "../../components/Button";
import { IconActivity, IconLink, IconServer, IconWarningCircle } from "../../components/Icon";
import type { HttpOutcome } from "../../contracts/auth";
import type { Loadable } from "../../kit/useApi";
import { api } from "../../api/client";
import { Chip, ConfirmDialog, Dialog, Drawer, JsonBlock, KeyValues, LoadState, Table, Tabs, fmtTime } from "../../kit/ui";
import { Navigate, useLocation, useNavigate, useSearchParams } from "../../router";
import { useShell } from "../../app/shellContext";
import type { ExtensionPageProps } from "../registry";
import { NET_BASE, enc, inspectionRetryGate, net, type Inspection, type InspectionDevice } from "./api";
import type { NetworkSkill } from "./SkillForm";
import type { Connection, Device, Region } from "./forms";
import { DeviceInventory } from "./DeviceInventory";
import { ScriptLibrary, SkillPipeline, SkillsBoard } from "./SkillStudio";
import { Result, connHealth, deviceHealth, listOf, useNet } from "./shared";

export const SKILLS_PATH = "/extensions/network.operations/skills";
export const DEVICES_PATH = "/extensions/network.operations/manage";

type DeviceView = "devices" | "topologies" | "inspections" | "context";
type SkillView = "skills" | "scripts";
const DEVICE_VIEWS: readonly DeviceView[] = ["devices", "topologies", "inspections", "context"];
const SKILL_VIEWS: readonly SkillView[] = ["skills", "scripts"];

/**
 * network.operations 扩展的前端模块，按 manifest 拆成两个工作区：
 * - 网络设备（/manage）：设备清单（含连接）、拓扑画布、巡检、上下文观察；
 * - 网络 Skill（/skills）：Skill 编排与巡检脚本库。
 * 旧深链 /manage?tab=skills|scripts 跳到 Skill 工作区；?tab=connections 落到设备清单。
 */
export default function NetworkOperationsPage({ ws, mountPath }: ExtensionPageProps) {
  const [params] = useSearchParams();
  const { search } = useLocation();
  const raw = params.get("tab");
  if (mountPath === SKILLS_PATH) return <SkillsWorkspace ws={ws} />;
  if (raw === "skills" || raw === "scripts") return <Navigate to={`${SKILLS_PATH}${search}`} replace />;
  return <DevicesWorkspace ws={ws} />;
}

function useView<T extends string>(views: readonly T[], fallback: T, alias: Record<string, T> = {}) {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab") ?? "";
  const view = (views as readonly string[]).includes(raw) ? (raw as T) : alias[raw] ?? fallback;
  // 统一深链：?tab=<区块>&id=<对象>；拓扑区块按 P-30 只用 `topology`（见 topology/topologyParams.ts）。
  const go = (t: T, nextId?: string | null) => {
    const n = new URLSearchParams(params); n.set("tab", t);
    for (const k of ["id", "topology", "topology_id", "node"]) n.delete(k);
    if (nextId) n.set("id", nextId);
    setParams(n);
  };
  return { view, go, id: params.get("id"), params, setParams };
}

function DevicesWorkspace({ ws }: { ws: string }) {
  const { view, go, id, params, setParams } = useView<DeviceView>(DEVICE_VIEWS, "devices", { connections: "devices" });
  const [devState, reloadDevices] = useNet("/devices", ws);
  const [connState, reloadConnections] = useNet("/connections", ws);
  const [regionState] = useNet("/regions", ws);
  const [inspState] = useNet("/inspections", ws);
  const devices = listOf<Device>(devState, "devices");
  const connections = listOf<Connection>(connState, "connections");
  const inspections = listOf<Inspection>(inspState, "inspections");
  const selectDevice = (deviceId: string | null) => { const n = new URLSearchParams(params); if (deviceId) n.set("device", deviceId); else n.delete("device"); setParams(n, { replace: true }); };
  const canvas = view === "topologies";
  return (
    <div className={`netops-page${canvas ? " is-canvas" : ""}`} data-testid="netops-page">
      {!canvas ? <FleetSummary devices={devices} connections={connections} inspections={inspections} onGo={(v) => go(v)} /> : null}
      <Tabs label="网络设备视图" current={view} onChange={(t: DeviceView) => go(t)} tabs={[
        { key: "devices", label: "设备", count: devices.length },
        { key: "topologies", label: "拓扑" },
        { key: "inspections", label: "巡检", count: inspections.length },
        { key: "context", label: "上下文观察" },
      ]} />
      {view === "devices" ? <DeviceInventory ws={ws} devices={devices} devicesState={devState} reloadDevices={reloadDevices} connections={connections}
        reloadConnections={reloadConnections} regions={listOf<Region>(regionState, "regions")} selectedId={params.get("device")} onSelect={selectDevice} /> : null}
      {view === "inspections" ? <Inspections ws={ws} openId={id} onOpen={(x) => go("inspections", x)} /> : null}
      {view === "topologies" ? <Topologies ws={ws} /> : null}
      {view === "context" ? <ContextView ws={ws} /> : null}
    </div>
  );
}

/** 机群概览：一眼看出有多少设备、连接是否健康、哪些需要处理、最近一次巡检结果。 */
function FleetSummary({ devices, connections, inspections, onGo }: { devices: Device[]; connections: Connection[]; inspections: Inspection[]; onGo: (v: DeviceView) => void }) {
  const tones = connections.map((c) => connHealth(c.status));
  const ok = tones.filter((t) => t === "ok").length;
  const warn = tones.filter((t) => t === "warn").length;
  const untested = tones.length - ok - warn;
  const attention = devices.filter((d) => { const h = deviceHealth(connections.filter((c) => c.device_id === d.device_id)); return h === "warn" || h === "none"; }).length;
  const latest = [...inspections].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))[0];
  const pct = (n: number) => `${tones.length ? (n / tones.length) * 100 : 0}%`;
  return (
    <div className="fleet" role="group" aria-label="设备概览">
      <div className="fleet-tile">
        <span className="fleet-icon" aria-hidden="true"><IconServer size={16} /></span>
        <span className="fleet-label">设备</span>
        <span className="fleet-value">{devices.length}</span>
        <span className="fleet-sub">{new Set(devices.map((d) => d.vendor).filter(Boolean)).size} 个厂商</span>
      </div>
      <div className="fleet-tile is-wide">
        <span className="fleet-icon" aria-hidden="true"><IconLink size={16} /></span>
        <span className="fleet-label">连接健康</span>
        <span className="fleet-value">{ok}<small>/{tones.length} 可连通</small></span>
        <span className="fleet-bar" role="img" aria-label={`可连通 ${ok}，未测试 ${untested}，异常 ${warn}`}>
          <span className="is-ok" style={{ width: pct(ok) }} /><span className="is-neutral" style={{ width: pct(untested) }} /><span className="is-warn" style={{ width: pct(warn) }} />
        </span>
      </div>
      <button type="button" className={`fleet-tile is-action ${attention ? "is-alert" : ""}`} onClick={() => onGo("devices")}>
        <span className="fleet-icon" aria-hidden="true"><IconWarningCircle size={16} /></span>
        <span className="fleet-label">需关注</span>
        <span className="fleet-value">{attention}</span>
        <span className="fleet-sub">{attention ? "无连接或测试失败" : "全部正常"}</span>
      </button>
      <button type="button" className="fleet-tile is-action" onClick={() => onGo("inspections")}>
        <span className="fleet-icon" aria-hidden="true"><IconActivity size={16} /></span>
        <span className="fleet-label">最近巡检</span>
        <span className="fleet-value is-text">{latest ? INSPECTION_STATUS[latest.status ?? ""] ?? latest.status ?? "未上报" : "暂无"}</span>
        <span className="fleet-sub">{latest ? fmtTime(latest.created_at) : "从「巡检」发起"}</span>
      </button>
    </div>
  );
}

function SkillsWorkspace({ ws }: { ws: string }) {
  const { view, go } = useView<SkillView>(SKILL_VIEWS, "skills");
  const [skillState, reloadSkills] = useNet("/skills", ws);
  const [devState] = useNet("/devices", ws);
  const [connState] = useNet("/connections", ws);
  const [scriptState] = useNet("/scripts", ws);
  const { hrefFor } = useShell();
  const navigate = useNavigate();
  const skills = listOf<NetworkSkill>(skillState, "skills");
  const devices = listOf<Device>(devState, "devices");
  const connections = listOf<Connection>(connState, "connections");
  return (
    <div className="netops-page" data-testid="netops-skills">
      <SkillPipeline devices={devices.length} connections={connections.length} skills={skills} onGoDevices={() => navigate(hrefFor(DEVICES_PATH))} />
      <Tabs label="网络 Skill 视图" current={view} onChange={(t: SkillView) => go(t)} tabs={[
        { key: "skills", label: "Skill", count: skills.length },
        { key: "scripts", label: "巡检脚本", count: listOf(scriptState, "scripts").length },
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
