import { useCallback, useEffect, useRef, useState } from "react";
import { sessionsApi, jobsApi } from "../../../../frontend/src/api";
import { apiRequest } from "../../../../frontend/src/api/client";
import { useChatStream } from "../../../../frontend/src/hooks/useChatStream";
import { useActiveTurn } from "../../../../frontend/src/hooks/useActiveTurn";
import { useWorkbenchStore, type ChatMsg } from "../../../../frontend/src/stores/workbench";
import { useSessionStore } from "../../../../frontend/src/stores/session";
import { scopedLocalStorageKey } from "../../../../frontend/src/utils/userScope";
import { MessageRow } from "../../../../frontend/src/pages/AgentWorkbench/components/MessageRow";
import type { WorkbenchSkill } from "../../../../frontend/src/pages/AgentWorkbench/components/WorkbenchComposer";
import { IconSparkle, IconSend, IconStop } from "../../../../frontend/src/components/Icon";
import type { Topology, Skill } from "./TopologyWorkspace";
import "../../../../frontend/src/pages/AgentWorkbench/AgentWorkbench.css";

const EMPTY: ChatMsg[] = [];
export type CanvasSelection = { device_ids: string[]; link_ids: string[]; label: string };

export function buildTopologyRequest(topology: Topology, selection: CanvasSelection, request: string) {
  return `${request}\n\n当前画布上下文（图纸描述不是设备运行结论）：\n${JSON.stringify({
    topology_id: topology.topology_id, version: topology.version,
    selected_device_ids: selection.device_ids, selected_link_ids: selection.link_ids,
  })}\n请先读取此拓扑及所选对象的设备、连接标识；按用户目标使用当前 Skill 的工具。状态结论注明观察时间与证据。若直接证据建立了两端接口关系，先读取最新版本，再使用 record_discovered_link 写回；没有两端证据时不要把候选关系画成事实。`;
}

export function TopologyAgentPanel({ workspaceId, topology, skills, selection, onCompleted }: {
  workspaceId: string; topology: Topology; skills: Skill[]; selection: CanvasSelection; onCompleted: () => void;
}) {
  const storageKey = scopedLocalStorageKey(`topology_session:${topology.topology_id}`);
  const [sessionId, setSessionId] = useState<string | null>(() => {
    try { return localStorage.getItem(storageKey); } catch { return null; }
  });
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [catalog, setCatalog] = useState<WorkbenchSkill[]>([]);
  const [skillId, setSkillId] = useState(() => skills.find((skill) => skill.topology_id === topology.topology_id)?.skill_id || "");
  const messages = useWorkbenchStore((state) => state.bySession[sessionId || ""] || EMPTY);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const submittingRef = useRef(false);
  const refreshHistory = useCallback(async () => {
    if (!sessionId) return;
    const response = await sessionsApi.messages(sessionId, workspaceId);
    useWorkbenchStore.getState().mergeFromBackend(sessionId, response.messages);
  }, [sessionId, workspaceId]);
  const { send, stop, sending } = useChatStream({ workspaceId, sessionId, llmHealth: {} }, {
    onSessionResolved: setSessionId,
    onResult: () => { onCompleted(); },
    onInterruption: setError,
  });
  const { job, loaded, refresh } = useActiveTurn(workspaceId, sessionId, sending);
  const running = sending || job?.status === "running";
  const availableSkills = catalog.filter((entry) => entry.extension_id === "network.operations" && skills.some((s) => s.skill_id === entry.skill_id && s.topology_id === topology.topology_id));
  const selectedSkill = availableSkills.find((entry) => entry.skill_id === skillId);
  useEffect(() => {
    let disposed = false;
    apiRequest<{ skills: WorkbenchSkill[] }>({ method: "GET", url: "/workbench/skills", params: { workspace_id: workspaceId, enabled: "1" } })
      .then((data) => { if (!disposed) setCatalog(data.skills || []); })
      .catch(() => { if (!disposed) setError("无法读取 Skill，请刷新后重试。"); });
    return () => { disposed = true; };
  }, [workspaceId, skills]);
  useEffect(() => { void refreshHistory().catch(() => setError("会话记录读取失败；已有会话保留，请重试加载。")); }, [refreshHistory]);
  useEffect(() => {
    if (!loaded || sending) return;
    void refreshHistory().catch(() => setError("会话记录同步失败。"));
    if (job?.status !== "running") return;
    const timer = window.setInterval(() => { void refreshHistory().catch(() => {}); }, 2500);
    return () => window.clearInterval(timer);
  }, [job?.status, loaded, sending, refreshHistory]);
  useEffect(() => {
    if (pinnedRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const submit = async (request = input) => {
    if (!request.trim() || running || preparing || submittingRef.current || !selectedSkill || !loaded && sessionId) return;
    submittingRef.current = true;
    setPreparing(true); setError("");
    try {
      let id = sessionId;
      if (!id) {
        const created = await sessionsApi.create(workspaceId, `拓扑 · ${topology.name}`);
        id = created.session.session_id;
        setSessionId(id);
        try { localStorage.setItem(storageKey, id); } catch { /* session remains available via task history */ }
        useSessionStore.getState().bumpSessionList();
      } else {
        const response = await jobsApi.list(workspaceId);
        if (response.jobs.some((item) => item.status === "running" && String(item.payload?.session_id || item.metadata?.active_turn?.session_id || "") === id)) { setError("此拓扑的任务仍在运行，可以继续查看进度。"); return; }
      }
      setInput(""); pinnedRef.current = true;
      await send({ text: buildTopologyRequest(topology, selection, request.trim()), attachments: [], effectiveSessionId: id,
        turnMetadata: { workbench_selection: { extension_id: selectedSkill.extension_id, skill_id: selectedSkill.skill_id, skill_name: selectedSkill.name, resource_ids: selectedSkill.default_resource_ids } },
      });
      await refresh();
    } catch { setError("发送失败，请检查服务连接后重试。"); }
    finally { setPreparing(false); submittingRef.current = false; }
  };
  const cancel = async () => {
    if (sending) stop();
    else if (job?.job_id) { await jobsApi.cancel(job.job_id, workspaceId); await refresh(); }
  };
  return <section className="topology-agent" aria-label="拓扑协作">
    <header><IconSparkle size={18} /><div><strong>与 Agent 协作</strong><small>围绕这张网络图持续对话</small></div><span className={running ? "agent-pulse" : ""}>{running ? "执行中" : "就绪"}</span></header>
    <div className="topology-agent-scope"><label>使用 Skill<select aria-label="拓扑协作 Skill" value={selectedSkill?.skill_id || ""} disabled={running} onChange={(event) => setSkillId(event.target.value)}><option value="">选择已关联的 Skill</option>{availableSkills.map((skill) => <option value={skill.skill_id} key={skill.skill_id}>{skill.name}</option>)}</select></label><div className="topology-context-chip">{selection.label || "整张拓扑"}<small>随消息发送选中对象</small></div></div>
    <div className="topology-agent-messages" ref={scrollRef} onScroll={(event) => { const el = event.currentTarget; pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50; }}>
      {!messages.length && <div className="topology-agent-intro"><IconSparkle size={28} /><h3>从看懂网络，到完成操作</h3><p>选中图中的设备或链路，描述你的目标。模型会读取同一张图，并通过 Skill 获取设备事实。</p>{[
        ["了解网络", "读取当前拓扑与设备目录，解释网络结构、已有连接和待确认的信息。先只读取，不修改设备或图纸。"],
        ["检查所选对象", "检查当前选中设备或链路的运行状态，收集必要的只读证据，说明观察时间和仍未知的信息。"],
        ["补全连接关系", "通过只读采集确认设备间的接口连接关系，用确切证据补全当前拓扑，保持设备配置不变。"],
      ].map(([label, prompt]) => <button key={label} onClick={() => setInput(prompt)}>{label}<span>→</span></button>)}</div>}
      {messages.map((message, index) => <MessageRow key={message.id} m={message} idx={index} total={messages.length} lastUserInput="" onRetryOriginal={() => {}} />)}
      {running && !sending && <p role="status">服务端任务仍在运行，正在同步结果…</p>}
    </div>
    {error && <div className="topology-agent-error" role="alert">{error}<button onClick={() => { void refreshHistory().then(() => setError("")).catch(() => {}); }}>重试加载</button></div>}
    {!selectedSkill && <p className="topology-agent-hint">在 Skill 配置中关联这张拓扑后，即可开始协作。</p>}
    <form className="topology-agent-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <textarea aria-label="拓扑协作指令" placeholder="选择设备，然后告诉 Agent 你想做什么…" value={input} onChange={(event) => setInput(event.target.value)} rows={3} />
      <footer><small>{selection.device_ids.length ? `${selection.device_ids.length} 台设备已选中` : "上下文：整张拓扑"}</small>{running ? <button type="button" onClick={() => void cancel()}><IconStop size={14} />停止</button> : <button type="submit" disabled={!selectedSkill || !input.trim() || preparing}><IconSend size={14} />{preparing ? "连接中" : "发送"}</button>}</footer>
    </form>
  </section>;
}
