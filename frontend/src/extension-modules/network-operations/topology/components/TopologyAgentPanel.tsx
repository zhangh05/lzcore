/**
 * 迁移适配：旧画布内嵌的 Agent 对话面板依赖旧工作台（useChatStream / useActiveTurn / workbench store /
 * MessageRow），新前端的工作台是另一套实现，这里**没有迁移画布内对话**。
 * 面板保留原入口与 props：说明原因、列出本图的协作改动（可定位 / 撤销），并能在新工作台打开本图专属会话
 * （仍由旧 resolveTopologySession 保证 1 图 1 会话）。导出的 buildTopology* 与旧文件一致。
 */
import { useState } from "react";
import { useNavigate } from "../platform/router";
import { Button } from "../platform/components/ui";
import { IconSparkle, IconClose } from "../platform/components/Icon";
import type { Topology } from "./topologyDocument";
import type { CanvasSelection } from "./canvasSelection";
import { resolveTopologySession } from "./TopologySessionResolver";
import type { DrawingActivity } from "./topologyCollaboration";

export type { CanvasSelection } from "./canvasSelection";

export function buildTopologyRequest(request: string) {
  return request.trim();
}

export function buildTopologySelection(topology: Topology, selection: CanvasSelection, allowEdit = true) {
  return {
    extension_id: "network.operations",
    skill_id: `drawing:${topology.topology_id}${allowEdit ? "" : ":ro"}`,
    resource_ids: [topology.topology_id],
    allow_edit: allowEdit,
    drawing_version: topology.version,
    canvas_selection: selection,
  };
}

export function TopologyAgentPanel({
  workspaceId,
  topology,
  activities = [],
  onLocate,
  onUndoChange,
  onClose,
}: {
  workspaceId: string;
  topology: Topology;
  selection: CanvasSelection;
  onCompleted: () => void;
  prepareDrawing?: () => Promise<Topology>;
  activities?: DrawingActivity[];
  onLocate?: (ids: string[]) => void;
  onUndoChange?: (version: number) => void;
  onClose?: () => void;
}) {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true); setError("");
    try {
      const sid = await resolveTopologySession(workspaceId, topology);
      navigate(`/workbench?ws=${encodeURIComponent(workspaceId)}${sid ? `&session=${encodeURIComponent(sid)}` : ""}`);
    } catch {
      setError("无法打开本图的专属会话（会话接口失败），请稍后重试。");
    } finally { setBusy(false); }
  };
  return (
    <section className="topology-agent-panel" data-testid="topology-agent-panel" aria-label="绘图助手">
      <header className="topology-agent-head">
        <IconSparkle size={16} /> <strong>绘图助手</strong>
        {onClose ? <Button variant="ghost" iconOnly aria-label="关闭" icon={<IconClose size={14} />} onClick={onClose} /> : null}
      </header>
      <p className="muted" data-testid="agent-panel-not-migrated">
        画布内对话尚未迁入新前端。请在工作台打开本图的专属会话，助手的改动会带版本写回本图，画布回读服务端版本后显示。
      </p>
      <Button variant="primary" onClick={() => void open()} disabled={busy} data-testid="agent-open-workbench">在工作台打开本图会话</Button>
      {error ? <p role="alert">{error}</p> : null}
      {activities.length ? (
        <ul className="topology-agent-activities">
          {activities.map((a) => (
            <li key={`${a.version}:${a.revision_id ?? ""}`}>
              v{a.version} · 新增 {a.added} / 修改 {a.modified} / 删除 {a.removed}
              {a.ids.length && onLocate ? <Button size="sm" onClick={() => onLocate(a.ids)}>定位</Button> : null}
              {onUndoChange ? <Button size="sm" onClick={() => onUndoChange(a.version)}>撤销此改动</Button> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
