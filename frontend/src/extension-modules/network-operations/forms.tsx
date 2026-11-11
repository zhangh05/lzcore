/**
 * 网络扩展的实体表单（迁自 extensions/network_operations/frontend/NetworkOperations.tsx 的设备 / 连接表单，
 * 以及后端 network_scripts.save_inspection_script 的脚本合同）。
 * - 字段与后端校验一一对应；服务端 400 的 error 映射回具体字段。
 * - 「高级：JSON」保留完整请求体编辑能力；密码 / 私钥 / 口令不进入 JSON 文本。
 * - 保存后按 id 回读（GET …/<id>），显示服务端的值，而不是只显示回执。
 * - 连接保存时后端会自动做一次只读连接测试（backend.py auto_test=True），结果按回读如实显示。
 */
import { useEffect, useState } from "react";
import { bodyOf } from "../../api/client";
import { Button } from "../../components/Button";
import type { HttpOutcome } from "../../contracts/auth";
import { AdvancedJsonPanel, Field, FormError, ModeToggle, useAdvancedJson, type FieldErrors } from "../../kit/form";
import { Dialog, FailureNote } from "../../kit/ui";
import { enc, net } from "./api";

export const VENDORS = [["h3c", "H3C"], ["huawei", "华为"], ["cisco", "Cisco"], ["generic", "通用"]] as const;
export const DEVICE_ROLES = [
  ["router", "路由器"], ["router_core", "核心路由器"], ["switch", "二层交换机"], ["switch_core", "核心交换机"], ["switch_access", "接入交换机"],
  ["firewall", "防火墙"], ["server", "服务器"], ["pc", "终端 PC"], ["wireless", "无线设备"], ["cloud", "云网络"], ["wan", "广域网 WAN"],
  ["database", "数据库"], ["camera", "监控设备"], ["phone", "IP 电话"], ["printer", "打印设备"],
] as const;
const MODEL_SUGGESTIONS: Record<string, string[]> = {
  h3c: ["S5130S-28S-EI", "S5560X-30C-EI", "S6520X-54QC-EI", "S12500X-AF", "SR6608", "SecPath F1000"],
  huawei: ["S5735-L24T4S-QA", "S6730-H48X6C", "NE40E-X8A", "USG6600E"],
  cisco: ["Catalyst 9300", "Catalyst 9500", "Nexus 9300", "ASR 1000", "Firepower 2100"],
  generic: ["通用路由器", "通用交换机", "通用防火墙", "虚拟设备"],
};

export interface Device { device_id: string; name?: string; host?: string; vendor?: string; device_type?: string; region_id?: string; device_model?: string; updated_at?: string }
export interface Region { region_id: string; name?: string }
export interface Connection { connection_id: string; device_id?: string; name?: string; protocol?: string; port?: number; username?: string; source_address?: string; auth_method?: string; status?: string; last_error?: string; verified?: boolean; host_key_fingerprint?: string; observed_fingerprint?: string; last_tested_at?: string }
export interface ScriptCheck { check_id: string; name: string; description?: string; severity: string; kind?: string; pattern: string }
export interface Script { script_id: string; name?: string; description?: string; vendors?: string[]; commands?: string[]; checks?: ScriptCheck[]; version?: number; builtin?: boolean; source?: string; updated_at?: string }

type Saved<T> = { record: T; readback: T | null; outcome: HttpOutcome };
const serverError = (o: HttpOutcome) => (o.kind === "http" ? String((o.body as { error?: string })?.error ?? "") : "");

/** 服务端错误 → [字段, 中文说明]。未登记的错误原文显示在表单顶部，不吞掉。 */
function mapError(table: [RegExp, string, string][], raw: string): FieldErrors {
  for (const [re, field, text] of table) if (re.test(raw)) return { [field]: text };
  return { _form: raw ? `保存失败：${raw}` : "保存失败" };
}

// ── 设备 ────────────────────────────────────────────────
const DEVICE_ERRORS: [RegExp, string, string][] = [
  [/valid device name and host are required/, "host", "设备名称和管理地址都必须填写"],
  [/device name and host already exist/, "name", "同名称、同管理地址的设备已存在"],
  [/region_not_found/, "region_id", "所选区域不存在，请刷新后重选"],
  [/quota/, "_form", "设备数量已达上限"],
];
type DeviceDraft = { name: string; host: string; vendor: string; device_type: string; region_id: string; device_model: string };
const deviceDraft = (d?: Device | null): DeviceDraft => ({ name: d?.name ?? "", host: d?.host ?? "", vendor: d?.vendor ?? "h3c", device_type: d?.device_type ?? "switch", region_id: d?.region_id ?? "", device_model: d?.device_model ?? "" });
export function validateDevice(d: DeviceDraft): FieldErrors<keyof DeviceDraft> {
  const e: FieldErrors<keyof DeviceDraft> = {};
  if (!d.name.trim()) e.name = "请填写设备名称";
  else if (d.name.trim().length > 80) e.name = "设备名称最多 80 个字符";
  if (!d.host.trim()) e.host = "请填写管理地址（IP 或主机名）";
  else if (/\s/.test(d.host.trim())) e.host = "管理地址不能包含空格";
  if (!VENDORS.some(([v]) => v === d.vendor)) e.vendor = "请选择厂商";
  return e;
}

export function DeviceFormDialog({ ws, device, regions, onClose, onSaved }: { ws: string; device?: Device | null; regions: Region[]; onClose: () => void; onSaved: (s: Saved<Device>) => void }) {
  const [d, setD] = useState<DeviceDraft>(deviceDraft(device));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<HttpOutcome | null>(null);
  const adv = useAdvancedJson(() => ({ ...d }), (v) => { setD({ ...deviceDraft(), ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x ?? "")])) } as DeviceDraft); return true; });
  const set = (k: keyof DeviceDraft, v: string) => { setD({ ...d, [k]: v }); setErrors({ ...errors, [k]: undefined }); };
  const save = async () => {
    let body: Record<string, unknown> = { ...d };
    if (adv.mode === "json") {
      try { body = JSON.parse(adv.text || "{}"); } catch (e) { adv.setError(`JSON 格式不正确：${(e as Error).message}`); return; }
    }
    const local = validateDevice({ ...deviceDraft(), ...(body as Partial<DeviceDraft>) } as DeviceDraft);
    if (Object.keys(local).length) { setErrors(local); return; }
    setBusy(true); setFailure(null);
    const o = device ? await net.put(`/devices/${enc(device.device_id)}`, ws, body) : await net.post("/devices", ws, body);
    if (o.kind !== "http" || o.status >= 300) { setBusy(false); setErrors(mapError(DEVICE_ERRORS, serverError(o))); setFailure(o); return; }
    const rec = bodyOf<{ device?: Device }>(o)?.device as Device;
    const back = rec?.device_id ? await net.get(`/devices/${enc(rec.device_id)}`, ws) : null;
    setBusy(false);
    onSaved({ record: rec, readback: back && back.kind === "http" && back.status === 200 ? (bodyOf<{ device?: Device }>(back)?.device ?? null) : null, outcome: o });
  };
  return (
    <Dialog wide title={device ? `编辑设备 · ${device.name ?? device.device_id}` : "登记设备"} onClose={onClose} testId="device-form"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={busy} onClick={() => void save()} data-testid="device-save">{busy ? "保存中…" : "保存并回读"}</Button></>}>
      <div className="form-head"><p className="form-hint">登记后再为它添加连接；名称 + 管理地址相同视为同一台设备。</p><ModeToggle mode={adv.mode} onToggle={adv.toggle} /></div>
      <FormError text={errors._form} />
      {adv.mode === "json" ? <AdvancedJsonPanel text={adv.text} onChange={adv.setText} error={adv.error} note="完整请求体（POST/PUT /devices）；保存时按同样规则校验。" /> : (
        <div className="form-grid">
          <Field label="设备名称" required error={errors.name}>{(a) => <input {...a} value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="例如 合成-core-01" data-testid="device-name" />}</Field>
          <Field label="管理地址" required error={errors.host} hint="IP 或主机名">{(a) => <input {...a} value={d.host} onChange={(e) => set("host", e.target.value)} placeholder="10.0.0.1" data-testid="device-host" />}</Field>
          <Field label="厂商" required error={errors.vendor}>{(a) => <select {...a} value={d.vendor} onChange={(e) => set("vendor", e.target.value)} data-testid="device-vendor">{VENDORS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}</Field>
          <Field label="设备角色" error={errors.device_type}>{(a) => <select {...a} value={d.device_type} onChange={(e) => set("device_type", e.target.value)} data-testid="device-role">{DEVICE_ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}</Field>
          <Field label="型号（可选）" error={errors.device_model}>{(a) => <><input {...a} list="device-model-suggestions" value={d.device_model} onChange={(e) => set("device_model", e.target.value)} data-testid="device-model" /><datalist id="device-model-suggestions">{(MODEL_SUGGESTIONS[d.vendor] ?? []).map((m) => <option key={m} value={m} />)}</datalist></>}</Field>
          <Field label="区域（可选）" error={errors.region_id}>{(a) => <select {...a} value={d.region_id} onChange={(e) => set("region_id", e.target.value)} data-testid="device-region"><option value="">不分区域</option>{regions.map((r) => <option key={r.region_id} value={r.region_id}>{r.name ?? r.region_id}</option>)}</select>}</Field>
        </div>
      )}
      {failure && !Object.keys(errors).length ? <FailureNote outcome={failure} /> : null}
    </Dialog>
  );
}

// ── 连接 ────────────────────────────────────────────────
const CONNECTION_ERRORS: [RegExp, string, string][] = [
  [/device_not_found|connection_device_is_immutable/, "device_id", "设备不存在，或已有连接不能改挂到其他设备"],
  [/protocol must be/, "protocol", "协议只能是 SSH 或 Telnet"],
  [/invalid port/, "port", "端口必须是 1–65535 的整数"],
  [/connection_endpoint_already_exists/, "port", "该设备已有相同协议 + 端口的连接"],
  [/invalid auth method/, "auth_method", "认证方式与协议不匹配"],
  [/source_address/, "source_address", "源地址必须是本机 IP 地址"],
  [/username is required/, "username", "SSH 连接必须填写用户名"],
  [/password is required/, "password", "密码认证需要填写密码"],
  [/private key is required/, "private_key", "私钥认证需要填写私钥"],
];
type ConnDraft = { device_id: string; name: string; protocol: "ssh" | "telnet"; port: string; username: string; source_address: string; auth_method: string; password: string; private_key: string; passphrase: string };
const connDraft = (c?: Connection | null, deviceId = ""): ConnDraft => ({
  device_id: c?.device_id ?? deviceId, name: c?.name ?? "", protocol: (c?.protocol as "ssh" | "telnet") ?? "ssh", port: String(c?.port ?? 22),
  username: c?.username ?? "", source_address: c?.source_address ?? "", auth_method: c?.auth_method ?? "password", password: "", private_key: "", passphrase: "",
});
const SECRET_KEYS = ["password", "private_key", "passphrase"] as const;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
export function validateConnection(c: ConnDraft, editing: boolean): FieldErrors<keyof ConnDraft> {
  const e: FieldErrors<keyof ConnDraft> = {};
  if (!c.device_id) e.device_id = "请选择设备";
  const port = Number(c.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) e.port = "端口必须是 1–65535 的整数";
  if (c.protocol === "ssh" && !c.username.trim()) e.username = "SSH 连接必须填写用户名";
  const allowed = c.protocol === "telnet" ? ["none", "password"] : ["password", "private_key"];
  if (!allowed.includes(c.auth_method)) e.auth_method = c.protocol === "telnet" ? "Telnet 只支持「无」或「密码」" : "SSH 只支持「密码」或「私钥」";
  if (!editing && c.auth_method === "password" && !c.password) e.password = "请填写密码（编辑已有连接时留空表示不修改）";
  if (!editing && c.auth_method === "private_key" && !c.private_key.trim()) e.private_key = "请粘贴私钥";
  if (c.source_address.trim() && !IPV4.test(c.source_address.trim()) && !c.source_address.includes(":")) e.source_address = "源地址必须是 IP 地址";
  return e;
}
export function connectionBody(c: ConnDraft): Record<string, unknown> {
  return {
    device_id: c.device_id, name: c.name || undefined, protocol: c.protocol, port: Number(c.port), username: c.username || undefined,
    source_address: c.source_address || undefined, auth_method: c.auth_method,
    password: c.password || undefined, private_key: c.private_key || undefined, passphrase: c.passphrase || undefined,
  };
}

export function ConnectionFormDialog({ ws, connection, devices, deviceId, onClose, onSaved }: { ws: string; connection?: Connection | null; devices: Device[]; deviceId?: string; onClose: () => void; onSaved: (s: Saved<Connection>) => void }) {
  const [c, setC] = useState<ConnDraft>(connDraft(connection, deviceId ?? devices[0]?.device_id ?? ""));
  // 设备列表晚于表单到达时（打开表单时还在加载），补上默认设备；用户已选的不覆盖。
  const firstDevice = devices[0]?.device_id ?? "";
  useEffect(() => { if (!connection && firstDevice) setC((cur) => (cur.device_id ? cur : { ...cur, device_id: deviceId ?? firstDevice })); }, [connection, deviceId, firstDevice]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<HttpOutcome | null>(null);
  const publicPart = () => Object.fromEntries(Object.entries(connectionBody(c)).filter(([k]) => !(SECRET_KEYS as readonly string[]).includes(k)));
  const adv = useAdvancedJson(publicPart, (v) => {
    if (SECRET_KEYS.some((k) => k in v)) return "密码 / 私钥 / 口令请在表单里填写，不要写进 JSON";
    setC({ ...c, ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x ?? "")])) } as ConnDraft); return true;
  });
  const set = <K extends keyof ConnDraft>(k: K, v: ConnDraft[K]) => {
    const next = { ...c, [k]: v };
    if (k === "protocol") { next.port = v === "telnet" ? "23" : "22"; next.auth_method = v === "telnet" ? "password" : "password"; }
    setC(next); setErrors({ ...errors, [k]: undefined });
  };
  const save = async () => {
    let draft = c;
    if (adv.mode === "json") {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(adv.text || "{}"); } catch (e) { adv.setError(`JSON 格式不正确：${(e as Error).message}`); return; }
      if (SECRET_KEYS.some((k) => k in parsed)) { adv.setError("密码 / 私钥 / 口令请在表单里填写，不要写进 JSON"); return; }
      draft = { ...c, ...Object.fromEntries(Object.entries(parsed).map(([k, x]) => [k, String(x ?? "")])) } as ConnDraft;
    }
    const local = validateConnection(draft, !!connection);
    if (Object.keys(local).length) { setErrors(local); return; }
    setBusy(true); setFailure(null);
    const body = connectionBody(draft);
    const o = connection ? await net.put(`/connections/${enc(connection.connection_id)}`, ws, body) : await net.post("/connections", ws, body);
    if (o.kind !== "http" || o.status >= 300) { setBusy(false); setErrors(mapError(CONNECTION_ERRORS, serverError(o))); setFailure(o); return; }
    const rec = bodyOf<{ connection?: Connection }>(o)?.connection as Connection;
    const back = rec?.connection_id ? await net.get(`/connections/${enc(rec.connection_id)}`, ws) : null;
    setBusy(false);
    onSaved({ record: rec, readback: back && back.kind === "http" && back.status === 200 ? (bodyOf<{ connection?: Connection }>(back)?.connection ?? null) : null, outcome: o });
  };
  const authOptions = c.protocol === "telnet" ? [["none", "无认证"], ["password", "密码"]] : [["password", "密码"], ["private_key", "私钥"]];
  return (
    <Dialog wide title={connection ? `编辑连接 · ${connection.name ?? connection.connection_id}` : "添加连接"} onClose={onClose} testId="connection-form"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={busy} onClick={() => void save()} data-testid="connection-save">{busy ? "保存并测试中…" : "保存并回读"}</Button></>}>
      <div className="form-head"><p className="form-hint">保存后后端会自动做一次只读连接测试；同一设备 + 协议 + 端口只保留一条连接。</p><ModeToggle mode={adv.mode} onToggle={adv.toggle} /></div>
      <FormError text={errors._form} />
      {adv.mode === "json" ? <AdvancedJsonPanel text={adv.text} onChange={adv.setText} error={adv.error} note="完整请求体（不含密码 / 私钥 / 口令，这些只能在表单里填写）。" /> : (
        <div className="form-grid">
          <Field label="设备" required error={errors.device_id}>{(a) => <select {...a} value={c.device_id} disabled={!!connection} onChange={(e) => set("device_id", e.target.value)} data-testid="connection-device"><option value="">选择设备</option>{devices.map((d) => <option key={d.device_id} value={d.device_id}>{d.name ?? d.device_id}{d.host ? `（${d.host}）` : ""}</option>)}</select>}</Field>
          <Field label="连接名称（可选）" error={errors.name}>{(a) => <input {...a} value={c.name} onChange={(e) => set("name", e.target.value)} placeholder="默认用协议名" data-testid="connection-name" />}</Field>
          <Field label="协议" required error={errors.protocol}>{(a) => <select {...a} value={c.protocol} onChange={(e) => set("protocol", e.target.value as "ssh" | "telnet")} data-testid="connection-protocol"><option value="ssh">SSH</option><option value="telnet">Telnet</option></select>}</Field>
          <Field label="端口" required error={errors.port}>{(a) => <input {...a} inputMode="numeric" value={c.port} onChange={(e) => set("port", e.target.value)} data-testid="connection-port" />}</Field>
          <Field label="用户名" required={c.protocol === "ssh"} error={errors.username}>{(a) => <input {...a} autoComplete="off" value={c.username} onChange={(e) => set("username", e.target.value)} data-testid="connection-username" />}</Field>
          <Field label="认证方式" required error={errors.auth_method}>{(a) => <select {...a} value={c.auth_method} onChange={(e) => set("auth_method", e.target.value)} data-testid="connection-auth">{authOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}</Field>
          {c.auth_method === "password" ? <Field label="密码" required={!connection} error={errors.password} hint={connection ? "留空表示不修改已保存的密码" : "只写入扩展密钥库，不回显"}>{(a) => <input {...a} type="password" autoComplete="new-password" value={c.password} onChange={(e) => set("password", e.target.value)} data-testid="connection-password" />}</Field> : null}
          {c.auth_method === "private_key" ? <>
            <Field full label="私钥" required={!connection} error={errors.private_key} hint={connection ? "留空表示不修改已保存的私钥" : undefined}>{(a) => <textarea {...a} rows={4} value={c.private_key} onChange={(e) => set("private_key", e.target.value)} data-testid="connection-key" />}</Field>
            <Field label="私钥口令（可选）" error={errors.passphrase}>{(a) => <input {...a} type="password" autoComplete="new-password" value={c.passphrase} onChange={(e) => set("passphrase", e.target.value)} />}</Field>
          </> : null}
          <Field label="源地址（可选）" error={errors.source_address} hint="多网卡时指定本机出口 IP">{(a) => <input {...a} value={c.source_address} onChange={(e) => set("source_address", e.target.value)} data-testid="connection-source" />}</Field>
        </div>
      )}
      {failure && !Object.keys(errors).length ? <FailureNote outcome={failure} /> : null}
    </Dialog>
  );
}

// ── 巡检脚本 ────────────────────────────────────────────
const SCRIPT_ERRORS: [RegExp, string, string][] = [
  [/script name/, "name", "脚本名称必填，最多 80 个字符"],
  [/vendors/, "vendors", "至少选择一个适用厂商"],
  [/read_only|read-only|commands/, "commands", "命令必须是只读命令（show / display 等），每行一条，至少一条"],
  [/check/, "checks", "检查项不合法：check_id 只能用字母数字 _ -，名称必填，匹配规则必须是合法正则"],
  [/invalid script_id/, "_form", "脚本 id 不合法"],
];
const SEVERITIES = [["low", "低"], ["medium", "中"], ["high", "高"], ["critical", "严重"]] as const;
type ScriptDraft = { name: string; description: string; vendors: string[]; commands: string; checks: ScriptCheck[] };
const scriptDraft = (s?: Script | null): ScriptDraft => ({ name: s?.name ?? "", description: s?.description ?? "", vendors: s?.vendors ?? ["generic"], commands: (s?.commands ?? []).join("\n"), checks: s?.checks ?? [] });
export const scriptBody = (d: ScriptDraft) => ({ name: d.name.trim(), description: d.description.trim(), vendors: d.vendors, commands: d.commands.split("\n").map((x) => x.trim()).filter(Boolean), checks: d.checks.map((c) => ({ ...c, kind: "output_matches" })) });
export function validateScript(d: ScriptDraft): FieldErrors<keyof ScriptDraft> {
  const e: FieldErrors<keyof ScriptDraft> = {};
  if (!d.name.trim()) e.name = "请填写脚本名称";
  else if (d.name.trim().length > 80) e.name = "脚本名称最多 80 个字符";
  if (!d.vendors.length) e.vendors = "至少选择一个适用厂商";
  if (!d.commands.split("\n").some((x) => x.trim())) e.commands = "至少填写一条只读命令";
  const ids = new Set<string>();
  for (const c of d.checks) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(c.check_id) || ids.has(c.check_id)) { e.checks = `检查项 id「${c.check_id || "（空）"}」不合法或重复`; break; }
    ids.add(c.check_id);
    if (!c.name.trim()) { e.checks = `检查项「${c.check_id}」缺少名称`; break; }
    if (!c.pattern.trim()) { e.checks = `检查项「${c.check_id}」缺少匹配规则`; break; }
    try { new RegExp(c.pattern, "i"); } catch { e.checks = `检查项「${c.check_id}」的匹配规则不是合法正则`; break; }
  }
  return e;
}

export function ScriptFormDialog({ ws, script, onClose, onSaved }: { ws: string; script?: Script | null; onClose: () => void; onSaved: (s: Saved<Script>) => void }) {
  const [d, setD] = useState<ScriptDraft>(scriptDraft(script));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<HttpOutcome | null>(null);
  const fromJson = (v: Record<string, unknown>): ScriptDraft | string => {
    if (v.vendors !== undefined && !Array.isArray(v.vendors)) return "vendors 必须是数组";
    if (v.commands !== undefined && !Array.isArray(v.commands)) return "commands 必须是字符串数组";
    if (v.checks !== undefined && !Array.isArray(v.checks)) return "checks 必须是数组";
    return { name: String(v.name ?? ""), description: String(v.description ?? ""), vendors: (v.vendors as string[]) ?? [], commands: ((v.commands as string[]) ?? []).join("\n"), checks: (v.checks as ScriptCheck[]) ?? [] };
  };
  const adv = useAdvancedJson(() => scriptBody(d), (v) => { const r = fromJson(v); if (typeof r === "string") return r; setD(r); return r; });
  const set = <K extends keyof ScriptDraft>(k: K, v: ScriptDraft[K]) => { setD({ ...d, [k]: v }); setErrors({ ...errors, [k]: undefined }); };
  const setCheck = (i: number, patch: Partial<ScriptCheck>) => set("checks", d.checks.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const save = async () => {
    let draft = d;
    if (adv.mode === "json") {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(adv.text || "{}"); } catch (e) { adv.setError(`JSON 格式不正确：${(e as Error).message}`); return; }
      const r = fromJson(parsed); if (typeof r === "string") { adv.setError(r); return; }
      draft = r;
    }
    const local = validateScript(draft);
    if (Object.keys(local).length) { setErrors(local); return; }
    setBusy(true); setFailure(null);
    const body = scriptBody(draft);
    const o = script ? await net.put(`/scripts/${enc(script.script_id)}`, ws, body) : await net.post("/scripts", ws, body);
    if (o.kind !== "http" || o.status >= 300) { setBusy(false); setErrors(mapError(SCRIPT_ERRORS, serverError(o))); setFailure(o); return; }
    const rec = bodyOf<{ script?: Script }>(o)?.script as Script;
    const back = rec?.script_id ? await net.get(`/scripts/${enc(rec.script_id)}`, ws) : null;
    setBusy(false);
    onSaved({ record: rec, readback: back && back.kind === "http" && back.status === 200 ? (bodyOf<{ script?: Script }>(back)?.script ?? null) : null, outcome: o });
  };
  return (
    <Dialog wide title={script ? `编辑巡检脚本 · ${script.name ?? script.script_id}` : "新建巡检脚本"} onClose={onClose} testId="script-form"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={busy} onClick={() => void save()} data-testid="script-save">{busy ? "保存中…" : "保存并回读"}</Button></>}>
      <div className="form-head"><p className="form-hint">脚本只允许只读命令；检查项按命令输出做正则匹配，不调用模型判断。{script?.version ? ` 当前版本 v${script.version}，保存后版本 +1。` : ""}</p><ModeToggle mode={adv.mode} onToggle={adv.toggle} /></div>
      <FormError text={errors._form} />
      {adv.mode === "json" ? <AdvancedJsonPanel text={adv.text} onChange={adv.setText} error={adv.error} note="完整请求体（POST/PUT /scripts）：name、description、vendors[]、commands[]、checks[]。" /> : (
        <div className="form-grid">
          <Field label="脚本名称" required error={errors.name}>{(a) => <input {...a} value={d.name} onChange={(e) => set("name", e.target.value)} data-testid="script-name" />}</Field>
          <Field label="说明（可选）" error={errors.description}>{(a) => <input {...a} maxLength={300} value={d.description} onChange={(e) => set("description", e.target.value)} data-testid="script-description" />}</Field>
          <Field full label="适用厂商" required error={errors.vendors}>{(a) => (
            <div className="form-checks" id={a.id} role="group" aria-invalid={a["aria-invalid"]} aria-describedby={a["aria-describedby"]} data-testid="script-vendors">
              {VENDORS.map(([v, l]) => <label key={v}><input type="checkbox" checked={d.vendors.includes(v)} onChange={(e) => set("vendors", e.target.checked ? [...d.vendors, v] : d.vendors.filter((x) => x !== v))} /> {l}</label>)}
            </div>
          )}</Field>
          <Field full label="只读命令（每行一条）" required error={errors.commands}>{(a) => <textarea {...a} rows={6} value={d.commands} onChange={(e) => set("commands", e.target.value)} placeholder={"display version\ndisplay interface brief"} data-testid="script-commands" />}</Field>
          <Field full label={`检查项（${d.checks.length}）`} error={errors.checks} hint="命中正则即记为发现；严重度用于排序。">{(a) => (
            <div className="check-rows" id={a.id} data-testid="script-checks">
              {d.checks.map((c, i) => (
                <div key={i} className="check-row">
                  <input aria-label="检查项 id" value={c.check_id} onChange={(e) => setCheck(i, { check_id: e.target.value })} placeholder="check_id" />
                  <input aria-label="检查项名称" value={c.name} onChange={(e) => setCheck(i, { name: e.target.value })} placeholder="名称" />
                  <select aria-label="严重度" value={c.severity} onChange={(e) => setCheck(i, { severity: e.target.value })}>{SEVERITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                  <input aria-label="匹配规则（正则）" value={c.pattern} onChange={(e) => setCheck(i, { pattern: e.target.value })} placeholder="正则，如 DOWN" />
                  <Button variant="ghost" className="sm" onClick={() => set("checks", d.checks.filter((_, j) => j !== i))} aria-label={`删除检查项 ${c.check_id}`}>删除</Button>
                </div>
              ))}
              <Button className="sm" onClick={() => set("checks", [...d.checks, { check_id: `check_${d.checks.length + 1}`, name: "", severity: "medium", pattern: "" }])} data-testid="script-add-check">添加检查项</Button>
            </div>
          )}</Field>
        </div>
      )}
      {failure && !Object.keys(errors).length ? <FailureNote outcome={failure} /> : null}
    </Dialog>
  );
}
