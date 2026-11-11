import { useMemo, useState } from "react";
import { bodyOf } from "../../api/client";
import { Button } from "../../components/Button";
import { IconPlus, IconRefresh, IconServer, IconShield, IconTrash, IconEdit, IconLink, IconCheckCircle } from "../../components/Icon";
import type { HttpOutcome } from "../../contracts/auth";
import type { Loadable } from "../../kit/useApi";
import { Chip, ConfirmDialog, FailureNote, JsonBlock, KeyValues, LoadState, fmtTime } from "../../kit/ui";
import { EmptyState } from "../../components/arc/empty-state/empty-state";
import { SearchField } from "../../components/arc/search-field/search-field";
import SegmentedControl from "../../components/arc/segmented-control/segmented-control";
import { enc, net } from "./api";
import { ConnectionFormDialog, DeviceFormDialog, type Connection, type Device, type Region } from "./forms";
import {
  CONN_STATUS, HEALTH_LABEL, ROLE_ZH, Result, SavedNote, VENDOR_ZH, connHealth, connReadbackText, deviceHealth,
  type ActionResult, type Health,
} from "./shared";

type Filter = "all" | "warn" | "untested";

/**
 * 设备清单：左侧可搜索的设备列表（按连接健康着色），右侧是选中设备的详情、它的全部连接与测试。
 * 连接总是属于某台设备，在设备详情里管理。搜索、筛选、空态用 Arc UI 的 SearchField / SegmentedControl / EmptyState。
 */
export function DeviceInventory({ ws, devices, devicesState, reloadDevices, connections, reloadConnections, regions, selectedId, onSelect }: {
  ws: string;
  devices: Device[]; devicesState: Loadable<unknown>; reloadDevices: () => void;
  connections: Connection[]; reloadConnections: () => void;
  regions: Region[];
  selectedId: string | null; onSelect: (id: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [edit, setEdit] = useState<Device | "new" | null>(null);
  const [addConn, setAddConn] = useState<string | null>(null);
  const [note, setNote] = useState<{ label: string; text: string | null; testId: string } | null>(null);
  const byDevice = useMemo(() => {
    const m = new Map<string, Connection[]>();
    for (const c of connections) { const k = c.device_id ?? ""; m.set(k, [...(m.get(k) ?? []), c]); }
    return m;
  }, [connections]);
  const health = (d: Device): Health => deviceHealth(byDevice.get(d.device_id) ?? []);
  const regionName = (id?: string) => regions.find((x) => x.region_id === id)?.name ?? (id || "未分区");
  const q = query.trim().toLowerCase();
  const visible = devices.filter((d) => {
    if (q && ![d.name, d.host, d.device_model, VENDOR_ZH[d.vendor ?? ""], regionName(d.region_id)].some((v) => String(v ?? "").toLowerCase().includes(q))) return false;
    const h = health(d);
    if (filter === "warn") return h === "warn" || h === "none";
    if (filter === "untested") return h === "neutral";
    return true;
  });
  const counts = { all: devices.length, warn: devices.filter((d) => ["warn", "none"].includes(health(d))).length, untested: devices.filter((d) => health(d) === "neutral").length };
  const selected = devices.find((d) => d.device_id === selectedId) ?? visible[0] ?? devices[0] ?? null;

  return (
    <div className="inv" data-testid="net-devices">
      <div className="inv-toolbar">
        <SearchField label="搜索设备" value={query} onValueChange={setQuery} placeholder="搜索名称、地址、型号、区域" className="inv-search" />
        <SegmentedControl label="按健康筛选" value={filter} onValueChange={(v) => setFilter(v as Filter)} options={([["all", "全部"], ["warn", "需关注"], ["untested", "未测试"]] as const).map(([k, label]) => ({
          value: k, label, accessory: <span className="tab-count">{counts[k]}</span>,
        }))} />
        <span className="grow" />
        <Button onClick={() => setAddConn(selected?.device_id ?? "")} data-testid="connection-new"><IconLink size={15} aria-hidden="true" />添加连接</Button>
        <Button variant="primary" onClick={() => setEdit("new")} data-testid="device-new"><IconPlus size={15} aria-hidden="true" />登记设备</Button>
      </div>
      {note ? <SavedNote label={note.label} text={note.text} testId={note.testId} /> : null}

      <LoadState value={devicesState} onReload={reloadDevices}>{() => devices.length === 0 ? (
        <EmptyState title="还没有登记设备" icon={<IconServer size={20} />}
          description="先登记一台设备，再为它添加 SSH / Telnet 连接并测试连通，之后就能在巡检、拓扑和 Skill 里使用它。"
          action={<Button variant="primary" onClick={() => setEdit("new")}>登记第一台设备</Button>} />
      ) : (
        <div className="inv-split">
          <ul className="inv-list" aria-label="设备列表" data-testid="devices-table">
            {visible.map((d) => {
              const h = health(d);
              const n = byDevice.get(d.device_id)?.length ?? 0;
              const active = selected?.device_id === d.device_id;
              return (
                <li key={d.device_id}>
                  <button type="button" className={`inv-row ${active ? "is-active" : ""}`} aria-current={active ? "true" : undefined} onClick={() => onSelect(d.device_id)}>
                    <span className={`health-dot is-${h}`} title={HEALTH_LABEL[h]} aria-label={HEALTH_LABEL[h]} />
                    <span className="inv-row-main">
                      <span className="inv-row-name">{d.name ?? d.device_id}</span>
                      <span className="inv-row-meta"><code>{d.host ?? "—"}</code> · {VENDOR_ZH[d.vendor ?? ""] ?? d.vendor ?? "—"}</span>
                    </span>
                    <span className="inv-row-count" title={`${n} 条连接`}>{n}</span>
                  </button>
                </li>
              );
            })}
            {!visible.length ? <li className="inv-list-empty muted">没有符合条件的设备。</li> : null}
          </ul>
          {selected ? (
            <DeviceDetail key={selected.device_id} ws={ws} device={selected} connections={byDevice.get(selected.device_id) ?? []} regionName={regionName(selected.region_id)}
              health={health(selected)} onEdit={() => setEdit(selected)} onAddConnection={() => setAddConn(selected.device_id)}
              onDeleted={() => { onSelect(null); reloadDevices(); reloadConnections(); }} reloadConnections={reloadConnections}
              devices={devices} onConnectionSaved={(c) => { setNote({ label: "连接", text: c ? connReadbackText(c) : null, testId: "connection-readback" }); reloadConnections(); }} />
          ) : null}
        </div>
      )}</LoadState>

      {edit ? <DeviceFormDialog ws={ws} device={edit === "new" ? null : edit} regions={regions} onClose={() => setEdit(null)}
        onSaved={({ readback }) => {
          setEdit(null);
          setNote({ label: "设备", testId: "device-readback", text: readback ? `回读：${readback.name} · ${readback.host} · ${VENDOR_ZH[readback.vendor ?? ""] ?? readback.vendor} · ${ROLE_ZH[readback.device_type ?? ""] ?? readback.device_type}` : null });
          if (readback?.device_id) onSelect(readback.device_id);
          reloadDevices();
        }} /> : null}
      {addConn !== null ? <ConnectionFormDialog ws={ws} devices={devices} deviceId={addConn || undefined} onClose={() => setAddConn(null)}
        onSaved={({ readback }) => { setAddConn(null); setNote({ label: "连接", text: readback ? connReadbackText(readback) : null, testId: "connection-readback" }); reloadConnections(); }} /> : null}
    </div>
  );
}

function DeviceDetail({ ws, device, connections, regionName, health, onEdit, onAddConnection, onDeleted, reloadConnections, devices, onConnectionSaved }: {
  ws: string; device: Device; connections: Connection[]; regionName: string; health: Health;
  onEdit: () => void; onAddConnection: () => void; onDeleted: () => void; reloadConnections: () => void;
  devices: Device[]; onConnectionSaved: (c: Connection | null) => void;
}) {
  const [del, setDel] = useState(false);
  const [r, setR] = useState<ActionResult>(null);
  const [editConn, setEditConn] = useState<Connection | null>(null);
  const [delConn, setDelConn] = useState<Connection | null>(null);
  const [test, setTest] = useState<{ id: string; o: HttpOutcome } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [accept, setAccept] = useState<{ id: string; fingerprint: string } | null>(null);
  const runTest = async (id: string, extra: Record<string, unknown> = {}) => {
    setTesting(id);
    try { setTest({ id, o: await net.post(`/connections/${enc(id)}/test`, ws, extra) }); } finally { setTesting(null); }
    reloadConnections();
  };
  const testBody = test ? bodyOf<{ ok?: boolean; requires_host_key_acceptance?: boolean; fingerprint?: string; observed_fingerprint?: string; error?: string }>(test.o) : null;
  return (
    <section className="inv-detail" aria-label={`设备 ${device.name ?? device.device_id}`}>
      <header className="inv-detail-head">
        <span className={`inv-detail-icon is-${health}`} aria-hidden="true"><IconServer size={20} /></span>
        <div className="inv-detail-title">
          <h2>{device.name ?? device.device_id}</h2>
          <p><code>{device.host ?? "—"}</code><span className={`health-text is-${health}`}>{HEALTH_LABEL[health]}</span></p>
        </div>
        <Button className="sm" onClick={onEdit}><IconEdit size={14} aria-hidden="true" />编辑</Button>
        <Button className="sm" variant="ghost" onClick={() => setDel(true)} aria-label="删除设备"><IconTrash size={14} aria-hidden="true" /></Button>
      </header>
      <dl className="inv-facts">
        <div><dt>厂商</dt><dd>{VENDOR_ZH[device.vendor ?? ""] ?? device.vendor ?? "—"}</dd></div>
        <div><dt>角色</dt><dd>{ROLE_ZH[device.device_type ?? ""] ?? device.device_type ?? "—"}</dd></div>
        <div><dt>型号</dt><dd>{device.device_model || "—"}</dd></div>
        <div><dt>区域</dt><dd>{regionName}</dd></div>
      </dl>
      <Result r={r} />

      <div className="inv-section-head">
        <h3>连接 <span className="muted">{connections.length}</span></h3>
        <Button className="sm" onClick={onAddConnection} data-testid="device-add-connection"><IconPlus size={14} aria-hidden="true" />添加连接</Button>
      </div>
      {connections.length === 0 ? (
        <p className="inv-hint">这台设备还没有连接。添加 SSH 或 Telnet 连接后才能巡检、绘入拓扑或交给 Skill 使用。</p>
      ) : (
        <ul className="conn-list" data-testid="connections-table">
          {connections.map((c) => {
            const tone = connHealth(c.status);
            return (
              <li key={c.connection_id} className={`conn-card is-${tone}`}>
                <div className="conn-card-main">
                  <span className="conn-proto">{String(c.protocol ?? "?").toUpperCase()}<span>:{c.port ?? "?"}</span></span>
                  <div className="conn-card-text">
                    <strong>{c.name || `${String(c.protocol ?? "").toUpperCase()} 连接`}</strong>
                    <span className="muted">用户 {c.username || "—"}{c.last_tested_at ? ` · 测试于 ${fmtTime(c.last_tested_at)}` : ""}</span>
                  </div>
                  <Chip tone={tone === "ok" ? "ok" : tone === "neutral" ? "neutral" : "warn"}>{CONN_STATUS[c.status ?? ""] ?? c.status ?? "未上报"}</Chip>
                </div>
                <div className="conn-card-foot">
                  <span className="conn-fp" title="主机指纹"><IconShield size={13} aria-hidden="true" />{c.host_key_fingerprint ? <code>{String(c.host_key_fingerprint)}</code> : "指纹未登记"}</span>
                  {c.last_error ? <span className="conn-err" title={c.last_error}>{c.last_error}</span> : null}
                  <span className="grow" />
                  <Button className="sm" onClick={() => void runTest(String(c.connection_id))} disabled={testing === c.connection_id} data-testid="conn-test">
                    <IconRefresh size={14} aria-hidden="true" className={testing === c.connection_id ? "spin" : undefined} />{testing === c.connection_id ? "测试中…" : "测试"}
                  </Button>
                  <Button className="sm" variant="ghost" onClick={() => setEditConn(c)}>编辑</Button>
                  <Button className="sm" variant="ghost" onClick={() => setDelConn(c)} aria-label="删除连接"><IconTrash size={14} aria-hidden="true" /></Button>
                </div>
                {test?.id === c.connection_id ? (
                  <div className="conn-test" data-testid="conn-test-result">
                    {testBody?.requires_host_key_acceptance ? (
                      <div className="inline-alert tone-warn" role="alert">
                        主机指纹未登记或已变化：<code>{testBody.fingerprint ?? testBody.observed_fingerprint ?? "未返回"}</code>。接受前请线下核对。
                        <Button variant="danger" className="sm" onClick={() => setAccept({ id: test.id, fingerprint: String(testBody.fingerprint ?? testBody.observed_fingerprint ?? "") })} data-testid="accept-fingerprint">接受该指纹</Button>
                      </div>
                    ) : test.o.kind === "http" && test.o.status < 300 && testBody?.ok
                      ? <p className="inline-alert tone-ok" role="status"><IconCheckCircle size={15} aria-hidden="true" />连接测试通过（只读探测）。</p>
                      : <FailureNote outcome={test.o} />}
                    <details><summary>原始结果</summary><JsonBlock value={test.o.kind === "http" ? test.o.body : null} /></details>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {editConn ? <ConnectionFormDialog ws={ws} connection={editConn} devices={devices} onClose={() => setEditConn(null)}
        onSaved={({ readback }) => { setEditConn(null); onConnectionSaved(readback); }} /> : null}
      {delConn ? <ConfirmDialog title="删除连接？" details={<p>将硬删除 {device.name} 的 {String(delConn.protocol ?? "").toUpperCase()} 连接；失去全部有效连接的 Skill 将一并删除。</p>} confirmLabel="删除" onCancel={() => setDelConn(null)}
        onConfirm={async () => { const x = delConn; setDelConn(null); setR({ label: "删除", o: await net.del(`/connections/${enc(x.connection_id)}`, ws) }); reloadConnections(); }} /> : null}
      {accept ? <ConfirmDialog title="接受主机指纹？" testId="fingerprint-dialog" confirmText={accept.fingerprint} confirmLabel="接受并测试"
        details={<><p>高风险：接受后，此连接会信任以下指纹。指纹被替换可能意味着中间人攻击。</p><KeyValues items={[["连接", accept.id], ["指纹", <code key="f">{accept.fingerprint}</code>]]} /></>}
        onCancel={() => setAccept(null)} onConfirm={async () => { const a = accept; setAccept(null); await runTest(a.id, { accept_host_key: true, accepted_fingerprint: a.fingerprint }); }} /> : null}
      {del ? <ConfirmDialog title="永久删除设备？" details={<p>将硬删除「{device.name}」及其 {connections.length} 条连接；失去全部设备或连接的 Skill 会一并删除。</p>} confirmText={device.name ?? device.device_id} confirmLabel="永久删除" onCancel={() => setDel(false)}
        onConfirm={async () => { setDel(false); const o = await net.del(`/devices/${enc(device.device_id)}`, ws); setR({ label: "删除", o }); if (o.kind === "http" && o.status < 300) onDeleted(); }} /> : null}
    </section>
  );
}
