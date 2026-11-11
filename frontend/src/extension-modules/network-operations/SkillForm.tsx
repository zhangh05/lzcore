import { useState } from "react";
import { bodyOf, stableId } from "../../api/client";
import { Button } from "../../components/Button";
import type { HttpOutcome } from "../../contracts/auth";
import { AdvancedJsonPanel, Field, FormError, ModeToggle, parseJsonObject, useAdvancedJson } from "../../kit/form";
import { Dialog, FailureNote, RawData } from "../../kit/ui";
import { enc, net } from "./api";
import type { Connection, Device, Script } from "./forms";

export interface NetworkSkill {
  skill_id: string; name: string; description?: string; instructions?: string; enabled: boolean;
  approval_enabled?: boolean; device_ids: string[]; connection_ids: string[]; allowed_tool_ids: string[]; default_script_id?: string;
}
// 领域表单选项；保存与执行的最终校验仍由 network_records / network_inventory 完成。
const BASE_TOOL = "network.operations.device.manage";
const TOOLS = [
  [BASE_TOOL, "设备读取与配置（内置）"],
  ["network.operations.devices_read", "设备与连接目录"],
  ["network.operations.skills_read", "Skill 配置读取"],
  ["network.operations.context_read", "上下文读取"],
  ["network.operations.wait", "等待设备状态"],
  ["network.operations.inspection", "多设备巡检"],
] as const;

export function SkillFormDialog({ ws, skill, devices, connections, scripts, onClose, onSaved }: {
  ws: string; skill: NetworkSkill | null; devices: Device[]; connections: Connection[]; scripts: Script[];
  onClose: () => void; onSaved: (readback: NetworkSkill | null) => void;
}) {
  const [recordId] = useState(() => skill?.skill_id ?? stableId("skill"));
  const [d, setD] = useState<NetworkSkill>(skill ?? {
    skill_id: recordId, name: "", description: "", instructions: "", enabled: false, approval_enabled: false,
    device_ids: [], connection_ids: [], allowed_tool_ids: TOOLS.map(([id]) => id), default_script_id: "",
  });
  const [error, setError] = useState<string>();
  const [failure, setFailure] = useState<HttpOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [readback, setReadback] = useState<HttpOutcome | null>(null);
  const adv = useAdvancedJson(() => ({ ...d }), (v) => {
    if (!Array.isArray(v.device_ids) || !Array.isArray(v.connection_ids) || !Array.isArray(v.allowed_tool_ids)) return "设备、连接与工具必须是数组";
    setD(v as unknown as NetworkSkill); return true;
  });
  const toggle = (key: "device_ids" | "connection_ids" | "allowed_tool_ids", id: string, checked: boolean) => {
    const next = { ...d, [key]: checked ? [...d[key], id] : d[key].filter((x) => x !== id) };
    if (key === "device_ids" && !checked) next.connection_ids = next.connection_ids.filter((cid) => connections.find((c) => c.connection_id === cid)?.device_id !== id);
    setD(next);
  };
  const save = async () => {
    if (uncertain || busy) return;
    const parsed = adv.mode === "json" ? parseJsonObject(adv.text) : d;
    if (typeof parsed === "string") { adv.setError(parsed); return; }
    const body = parsed as unknown as NetworkSkill;
    if (!body.name?.trim() || body.name.trim().length > 80) { setError("请填写 1–80 字的名称"); return; }
    if (!Array.isArray(body.device_ids) || !body.device_ids.length || !Array.isArray(body.connection_ids) || !body.connection_ids.length) { setError("至少选择一台设备及其一条已配置的连接"); return; }
    if (!Array.isArray(body.allowed_tool_ids)) { setError("允许的工具必须是数组"); return; }
    setBusy(true); setError(undefined); setFailure(null);
    const payload = { ...body, skill_id: recordId };
    const o = skill ? await net.put(`/skills/${enc(recordId)}`, ws, payload) : await net.post("/skills", ws, { ...payload, enabled: false });
    if (o.kind !== "http" || o.status >= 300) {
      setBusy(false); setFailure(o);
      const result = bodyOf<{ execution_outcome?: string; status?: string; error?: string }>(o);
      if (o.kind === "network_error" || o.status >= 500 || result?.execution_outcome === "unknown" || result?.status === "execution_unknown" || result?.error === "execution_unknown") setUncertain(true);
      return;
    }
    const record = bodyOf<{ skill?: NetworkSkill }>(o)?.skill;
    const back = record?.skill_id ? await net.get(`/skills/${enc(record.skill_id)}`, ws) : null;
    setBusy(false);
    onSaved(back ? bodyOf<{ skill?: NetworkSkill }>(back)?.skill ?? null : null);
  };
  return <Dialog wide title={skill ? `编辑网络 Skill · ${skill.name}` : "新建网络 Skill"} onClose={onClose} testId="skill-form"
    footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={busy || uncertain} onClick={() => void save()}>保存并回读</Button></>}>
    <div className="form-head"><p className="form-hint">新建后保存为草稿，核对范围后再发布。设备账号决定设备侧实际权限。</p><ModeToggle mode={adv.mode} onToggle={adv.toggle} /></div>
    <FormError text={error} />{failure ? <FailureNote outcome={failure} /> : null}
    {uncertain ? <div className="inline-alert tone-unknown"><p>保存结果未知，请核对服务端记录；不会重发保存请求。</p><Button onClick={async () => setReadback(await net.get(`/skills/${enc(recordId)}`, ws))}>核对保存结果</Button>{readback ? readback.kind === "http" && readback.status === 200 ? <RawData value={readback.body} label="服务端当前记录（请与本次输入核对）" /> : <><p>尚未确认保存结果，原保存请求仍不会重发。</p><FailureNote outcome={readback} /></> : null}</div> : null}
    {adv.mode === "json" ? <AdvancedJsonPanel text={adv.text} onChange={adv.setText} error={adv.error} /> : <div className="form-grid">
      <Field label="Skill 名称" required>{(a) => <input {...a} value={d.name} maxLength={80} onChange={(e) => setD({ ...d, name: e.target.value })} />}</Field>
      <Field label="默认巡检脚本">{(a) => <select {...a} value={d.default_script_id ?? ""} onChange={(e) => setD({ ...d, default_script_id: e.target.value })}><option value="">不指定</option>{scripts.map((s) => <option key={s.script_id} value={s.script_id}>{s.name ?? s.script_id}</option>)}</select>}</Field>
      <Field full label="说明">{(a) => <textarea {...a} rows={2} value={d.description ?? ""} onChange={(e) => setD({ ...d, description: e.target.value })} />}</Field>
      <fieldset><legend>设备范围</legend>{devices.length ? devices.map((v) => <label className="check" key={v.device_id}><input type="checkbox" checked={d.device_ids.includes(v.device_id)} onChange={(e) => toggle("device_ids", v.device_id, e.target.checked)} />{v.name ?? v.device_id} · {v.host}</label>) : <p className="muted">请先登记设备。</p>}</fieldset>
      <fieldset><legend>设备连接</legend>{connections.filter((c) => d.device_ids.includes(c.device_id ?? "")).map((c) => <label className="check" key={c.connection_id}><input type="checkbox" checked={d.connection_ids.includes(c.connection_id)} onChange={(e) => toggle("connection_ids", c.connection_id, e.target.checked)} />{devices.find((v) => v.device_id === c.device_id)?.name} · {c.protocol?.toUpperCase()}:{c.port} · {c.username || "无用户名"}</label>)}{!connections.some((c) => d.device_ids.includes(c.device_id ?? "")) ? <p className="muted">先选择设备；若没有连接，请在设备页添加。</p> : null}</fieldset>
      <fieldset className="form-field is-full"><legend>允许的工具</legend><div className="skill-tool-options">{TOOLS.map(([id, label]) => <label className="check" key={id}><input type="checkbox" disabled={id === BASE_TOOL} checked={id === BASE_TOOL || d.allowed_tool_ids.includes(id)} onChange={(e) => toggle("allowed_tool_ids", id, e.target.checked)} />{label}</label>)}</div></fieldset>
      <div className="form-field is-full"><label className="check"><input type="checkbox" checked={!!d.approval_enabled} onChange={(e) => setD({ ...d, approval_enabled: e.target.checked })} />执行前要求审批</label></div>
      <Field full label="使用说明" hint="描述目标、证据要求和边界，模型自行决定工具顺序。">{(a) => <textarea {...a} rows={3} value={d.instructions ?? ""} onChange={(e) => setD({ ...d, instructions: e.target.value })} />}</Field>
    </div>}
  </Dialog>;
}
