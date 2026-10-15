import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "../../../../frontend/src/api/client";
import { Button } from "../../../../frontend/src/components/ui";
import { NetworkToolResult } from "./NetworkToolResult";
import { object, rows, text } from "./networkEvidence";

export function NetworkInspectionPanel({
  workspaceId,
  refreshVersion = 0,
}: {
  workspaceId: string;
  refreshVersion?: number;
}) {
  const [tasks, setTasks] = useState<Record<string, unknown>[]>([]);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState("");
  const [exceptionsOnly, setExceptionsOnly] = useState(false);
  const generation = useRef(0);
  const readRequest = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    if (!workspaceId) return;
    readRequest.current?.abort();
    const controller = new AbortController();
    readRequest.current = controller;
    try {
      const response = await apiRequest<{ inspections: unknown[] }>(
        {
          method: "GET",
          url: "/extensions/network.operations/inspections",
          params: { workspace_id: workspaceId, limit: 20 },
        },
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setTasks(rows(response.inspections));
        setError("");
      }
    } catch {
      if (!controller.signal.aborted)
        setError("巡检记录读取失败，请刷新核对。");
    }
  }, [workspaceId]);
  const lastRefresh = useRef(refreshVersion);
  useEffect(() => {
    if (lastRefresh.current !== refreshVersion) {
      lastRefresh.current = refreshVersion;
      void load();
    }
  }, [load, refreshVersion]);
  useEffect(() => {
    generation.current += 1;
    setTasks([]);
    setBusy("");
    setError("");
    setActionError("");
    void load();
    return () => {
      generation.current += 1;
      readRequest.current?.abort();
    };
  }, [load]);
  const hasActiveTasks = tasks.some((task) =>
    ["queued", "running"].includes(text(task.status)),
  );
  useEffect(() => {
    if (!hasActiveTasks) return;
    let stopped = false;
    let inFlight = false;
    let timer: number | undefined;
    const refresh = async () => {
      if (stopped || inFlight || document.hidden) return;
      inFlight = true;
      await load();
      inFlight = false;
      // Schedule after either success or failure; an unchanged task list must
      // not disable monitoring after one transient read failure.
      if (!stopped && !document.hidden)
        timer = window.setTimeout(() => void refresh(), 3000);
    };
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (!document.hidden) void refresh();
    };
    timer = window.setTimeout(() => void refresh(), 3000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, hasActiveTasks]);
  const operate = async (taskId: string, action: "retry" | "cancel") => {
    const current = generation.current;
    setBusy(taskId);
    setActionError("");
    try {
      await apiRequest({
        method: "POST",
        url: `/extensions/network.operations/inspections/${encodeURIComponent(taskId)}/${action}`,
        data: { workspace_id: workspaceId },
      });
      if (current === generation.current) await load();
    } catch {
      if (current === generation.current) {
        setActionError(
          "操作结果未确认，请刷新核对后续巡检；不要重新发起同一巡检。",
        );
        await load();
      }
    } finally {
      if (current === generation.current) setBusy("");
    }
  };
  return (
    <section
      className="network-panel network-inspections"
      aria-label="网络巡检记录"
    >
      <div className="panel-heading">
        <div>
          <h2>最近巡检</h2>
          <p>最近 20 项任务。重试只处理未成功设备，原任务证据保留。</p>
        </div>
        <Button onClick={() => void load()}>刷新巡检</Button>
      </div>
      <Button
        aria-pressed={exceptionsOnly}
        onClick={() => setExceptionsOnly(!exceptionsOnly)}
      >
        {exceptionsOnly ? "显示全部任务" : "仅显示需处理任务"}
      </Button>
      {error && <p role="alert">{error}</p>}
      {actionError && <p role="alert">{actionError}</p>}
      {tasks
        .filter((task) => !exceptionsOnly || task.status !== "succeeded")
        .map((task) => {
          const id = text(task.task_id);
          const active = ["queued", "running"].includes(text(task.status));
          return (
            <article key={id} className="network-inspection-record">
              <NetworkToolResult
                toolId="network.operations.inspection"
                result={{ task, presentation: object(task.presentation) }}
              />
              {task.retry_of_task_id ? (
                <p>接续巡检：{text(task.retry_of_task_id)}</p>
              ) : null}
              {task.retry_task_id ? (
                <p>后续巡检：{text(task.retry_task_id)}</p>
              ) : null}
              {!task.retry_task_id &&
                ["partial", "failed", "cancelled"].includes(
                  text(task.status),
                ) && (
                  <Button
                    disabled={!!busy}
                    onClick={() => void operate(id, "retry")}
                  >
                    {task.error === "inspection_evidence_persist_failed" ? "重新采集未保存证据" : "重试未完成设备"}
                  </Button>
                )}
              {active && (
                <Button
                  disabled={!!busy}
                  onClick={() => void operate(id, "cancel")}
                >
                  取消巡检
                </Button>
              )}
            </article>
          );
        })}
      {!tasks.length && !error && (
        <p>暂无巡检记录。可在工作台选择设备 Skill 后发起巡检。</p>
      )}
    </section>
  );
}
