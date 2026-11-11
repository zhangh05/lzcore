import { useState } from "react";
import { Button } from "../../components/Button";
import { IconChecklist, IconEdit, IconLink, IconPlus, IconServer, IconShield, IconSparkle, IconTrash } from "../../components/Icon";
import { EmptyState } from "../../components/arc/empty-state/empty-state";
import { MetricCard } from "../../components/arc/metric-card/metric-card";
import { Chip, ConfirmDialog, KeyValues, LoadState, fmtTime } from "../../kit/ui";
import { enc, net } from "./api";
import { ScriptFormDialog, type Connection, type Device, type Script } from "./forms";
import { SkillFormDialog, TOOLS, type NetworkSkill } from "./SkillForm";
import { Result, SavedNote, VENDOR_ZH, listOf, useNet, type ActionResult } from "./shared";

const TOOL_LABEL = Object.fromEntries(TOOLS) as Record<string, string>;

/** Skill 概览：Arc MetricCard 一行——已发布、草稿、写入需审批、巡检脚本。 */
export function SkillSummary({ skills, scripts }: { skills: NetworkSkill[]; scripts: number }) {
  const published = skills.filter((s) => s.enabled).length;
  const approval = skills.filter((s) => s.approval_enabled).length;
  return (
    <div className="metric-row" role="group" aria-label="Skill 概览">
      <MetricCard label="已发布" value={published} context={published ? "工作台会话可选择" : "还没有可用的 Skill"} />
      <MetricCard label="草稿" value={skills.length - published} context="发布前只在这里可见" />
      <MetricCard label="写入需审批" value={approval} context="配置写入前需人工批准" />
      <MetricCard label="巡检脚本" value={scripts} context="只读命令与检查规则" />
    </div>
  );
}

export function SkillsBoard({ ws, skillsState, skills, reload, devices, connections }: {
  ws: string; skillsState: Parameters<typeof LoadState>[0]["value"]; skills: NetworkSkill[]; reload: () => void; devices: Device[]; connections: Connection[];
}) {
  const [scripts] = useNet("/scripts", ws);
  const [edit, setEdit] = useState<NetworkSkill | "new" | null>(null);
  const [del, setDel] = useState<NetworkSkill | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pub, setPub] = useState<{ skill: NetworkSkill; enable: boolean } | null>(null);
  const [r, setR] = useState<ActionResult>(null);
  const scriptList = listOf<Script>(scripts, "scripts");
  const deviceName = (id: string) => devices.find((d) => d.device_id === id)?.name ?? id;
  return (
    <section data-testid="net-skills">
      <div className="studio-toolbar">
        <p className="muted">设备读取与配置是内置能力；Skill 决定能碰哪些设备、用哪些工具，设备账号决定实际权限。</p>
        <Button variant="primary" onClick={() => setEdit("new")} data-testid="skill-new"><IconPlus size={15} aria-hidden="true" />新建网络 Skill</Button>
      </div>
      {note ? <p className="readback-note" role="status">{note}</p> : null}
      <Result r={r} />
      <LoadState value={skillsState} onReload={reload}>{() => (
        <ul className="card-grid" data-testid="skills-grid">
          {skills.map((s) => (
            <li key={s.skill_id} className={`skill-card ${s.enabled ? "is-published" : ""}`}>
              <header className="skill-card-head">
                <span className="skill-card-icon" aria-hidden="true"><IconSparkle size={17} /></span>
                <div className="skill-card-title"><strong>{s.name}</strong><code>{s.skill_id}</code></div>
                <Chip tone={s.enabled ? "ok" : "neutral"}>{s.enabled ? "已发布" : "草稿"}</Chip>
              </header>
              <p className="skill-card-desc">{s.description || s.instructions || "未填写说明。"}</p>
              <dl className="skill-meters">
                <div><dt>设备</dt><dd>{s.device_ids.length}</dd></div>
                <div><dt>连接</dt><dd>{s.connection_ids.length}</dd></div>
                <div><dt>工具</dt><dd>{s.allowed_tool_ids.length}</dd></div>
              </dl>
              <div className="skill-chips">
                {s.device_ids.slice(0, 3).map((id) => <span key={id} className="tag"><IconServer size={12} aria-hidden="true" />{deviceName(id)}</span>)}
                {s.device_ids.length > 3 ? <span className="tag">+{s.device_ids.length - 3}</span> : null}
                {s.approval_enabled ? <span className="tag is-warn"><IconShield size={12} aria-hidden="true" />写入需审批</span> : null}
              </div>
              <div className="skill-tools">{s.allowed_tool_ids.map((t) => TOOL_LABEL[t] ?? t).join(" · ") || "未授权工具"}</div>
              <footer className="skill-card-foot">
                <Button className="sm" onClick={() => setEdit(s)}><IconEdit size={14} aria-hidden="true" />编辑</Button>
                <Button className="sm" variant={s.enabled ? undefined : "primary"} onClick={() => setPub({ skill: s, enable: !s.enabled })} data-testid="skill-publish">{s.enabled ? "撤回发布" : "发布"}</Button>
                <span className="grow" />
                <Button className="sm" variant="ghost" onClick={() => setDel(s)} aria-label={`删除 ${s.name}`}><IconTrash size={14} aria-hidden="true" /></Button>
              </footer>
            </li>
          ))}
          <li>
            <button type="button" className="card-new" onClick={() => setEdit("new")}>
              <IconPlus size={20} aria-hidden="true" /><strong>新建网络 Skill</strong><span>选择设备与连接，限定可用工具</span>
            </button>
          </li>
        </ul>
      )}</LoadState>
      {edit ? <SkillFormDialog ws={ws} skill={edit === "new" ? null : edit} devices={devices} connections={connections} scripts={scriptList} onClose={() => setEdit(null)}
        onSaved={(back) => { setEdit(null); setNote(back ? `已保存并回读：${back.name} · ${back.enabled ? "已发布" : "草稿"} · ${back.device_ids.length} 台设备 · ${back.connection_ids.length} 条连接` : "已保存；未能回读，请刷新核对。"); reload(); }} /> : null}
      {pub ? <ConfirmDialog title={pub.enable ? "发布这个网络 Skill？" : "撤回发布？"} confirmText={pub.enable ? pub.skill.skill_id : undefined} confirmLabel={pub.enable ? "发布" : "撤回"}
        details={<><p>{pub.enable ? "发布后，工作台可以选择它执行；设备配置操作会写入设备。" : "撤回后工作台不能再选择它。"}</p><KeyValues items={[["设备", pub.skill.device_ids.join("、")], ["连接", pub.skill.connection_ids.join("、")], ["工具", pub.skill.allowed_tool_ids.join("、")]]} /></>}
        onCancel={() => setPub(null)} onConfirm={async () => { const p = pub; setPub(null); setR({ label: p.enable ? "发布" : "撤回", o: await net.put(`/skills/${enc(p.skill.skill_id)}`, ws, { ...p.skill, enabled: p.enable }) }); reload(); }} /> : null}
      {del ? <ConfirmDialog title="永久删除网络 Skill？" details={<p>将删除「{del.name}」。</p>} confirmText={del.name} confirmLabel="永久删除" onCancel={() => setDel(null)}
        onConfirm={async () => { const s = del; setDel(null); setR({ label: "删除", o: await net.del(`/skills/${enc(s.skill_id)}`, ws) }); reload(); }} /> : null}
    </section>
  );
}

export function ScriptLibrary({ ws }: { ws: string }) {
  const [list, reload] = useNet("/scripts", ws);
  const [edit, setEdit] = useState<Script | "new" | null>(null);
  const [del, setDel] = useState<Script | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [r, setR] = useState<ActionResult>(null);
  const source = (x: Script) => (x.builtin ? "内置" : x.source === "starter" ? "入门模板" : "自定义");
  return (
    <section data-testid="net-scripts">
      <div className="studio-toolbar">
        <p className="muted">巡检脚本只含只读命令和检查规则，可在巡检里批量执行，也可作为 Skill 的默认脚本。</p>
        <Button variant="primary" onClick={() => setEdit("new")} data-testid="script-new"><IconPlus size={15} aria-hidden="true" />新建巡检脚本</Button>
      </div>
      {note ? <SavedNote label="脚本" text={note} testId="script-readback" /> : null}
      <Result r={r} />
      <LoadState value={list} onReload={reload}>{() => {
        const scripts = listOf<Script>(list, "scripts");
        return scripts.length ? (
          <ul className="card-grid is-wide" data-testid="scripts-table">
            {scripts.map((x) => {
              const commands = x.commands ?? [];
              return (
                <li key={x.script_id} className="script-card">
                  <header className="skill-card-head">
                    <span className="skill-card-icon is-neutral" aria-hidden="true"><IconChecklist size={17} /></span>
                    <div className="skill-card-title"><strong>{x.name ?? x.script_id}</strong><span className="muted">{source(x)} · v{x.version ?? 1} · 更新于 {fmtTime(x.updated_at)}</span></div>
                  </header>
                  {x.description ? <p className="skill-card-desc">{x.description}</p> : null}
                  <pre className="script-preview" aria-label="命令预览">{commands.slice(0, 4).map((c) => `$ ${c}`).join("\n")}{commands.length > 4 ? `\n… 另 ${commands.length - 4} 条` : ""}{!commands.length ? "（无命令）" : ""}</pre>
                  <div className="skill-chips">
                    {(x.vendors ?? []).map((v) => <span key={v} className="tag">{VENDOR_ZH[v] ?? v}</span>)}
                    <span className="tag"><IconLink size={12} aria-hidden="true" />{commands.length} 条命令</span>
                    <span className="tag"><IconChecklist size={12} aria-hidden="true" />{x.checks?.length ?? 0} 个检查项</span>
                  </div>
                  <footer className="skill-card-foot">
                    <Button className="sm" onClick={() => setEdit(x)} data-testid="script-edit"><IconEdit size={14} aria-hidden="true" />编辑</Button>
                    <span className="grow" />
                    <Button className="sm" variant="ghost" onClick={() => setDel(x)} aria-label={`删除 ${x.name ?? x.script_id}`}><IconTrash size={14} aria-hidden="true" /></Button>
                  </footer>
                </li>
              );
            })}
          </ul>
        ) : <EmptyState title="还没有巡检脚本" description="巡检脚本是一组只读命令和检查规则，可在巡检里批量执行，也可作为 Skill 的默认脚本。" icon={<IconChecklist size={20} />}
          action={<Button variant="primary" onClick={() => setEdit("new")}>新建巡检脚本</Button>} />;
      }}</LoadState>
      {edit ? <ScriptFormDialog ws={ws} script={edit === "new" ? null : edit} onClose={() => setEdit(null)}
        onSaved={({ readback }) => { setEdit(null); setNote(readback ? `回读：「${readback.name}」v${readback.version ?? "?"} · ${readback.commands?.length ?? 0} 条命令 · ${readback.checks?.length ?? 0} 个检查项 · ${(readback.vendors ?? []).map((v) => VENDOR_ZH[v] ?? v).join("、")}` : null); reload(); }} /> : null}
      {del ? <ConfirmDialog title="删除巡检脚本？" details={<p>将删除「{del.name}」。已发起的巡检不受影响。</p>} confirmLabel="删除" onCancel={() => setDel(null)}
        onConfirm={async () => { const x = del; setDel(null); setR({ label: "删除", o: await net.del(`/scripts/${enc(x.script_id)}`, ws) }); reload(); }} /> : null}
    </section>
  );
}
