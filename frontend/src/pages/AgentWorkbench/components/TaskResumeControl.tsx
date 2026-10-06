import { useEffect, useState } from "react";
import { apiRequest } from "../../../api/client";

interface TaskSnapshot {
  task?: { task_id: string; status: string };
}

export function TaskResumeControl({ workspaceId, sessionId, running, turnId, onResume }: {
  workspaceId: string | null; sessionId: string | null; running: boolean;
  turnId?: string; onResume: (text: string, metadata: Record<string, unknown>) => void;
}) {
  const [snapshot, setSnapshot] = useState<{ workspaceId: string; sessionId: string; value: TaskSnapshot } | null>(null);
  useEffect(() => {
    let disposed = false;
    setSnapshot(null);
    if (workspaceId && sessionId && !running) {
      void apiRequest<{ task_state: TaskSnapshot }>({
        url: `/runtime/sessions/${encodeURIComponent(sessionId)}/task-state`,
        params: { workspace_id: workspaceId },
      }).then((response) => { if (!disposed) setSnapshot({ workspaceId, sessionId, value: response?.task_state ?? {} }); })
        .catch(() => { if (!disposed) setSnapshot(null); });
    }
    return () => { disposed = true; };
  }, [workspaceId, sessionId, running, turnId]);
  const task = snapshot?.workspaceId === workspaceId && snapshot?.sessionId === sessionId ? snapshot.value.task : undefined;
  if (running || !task?.task_id) return null;
  return <div className="wb-retry-bar">
    <button type="button" data-testid="resume-task-btn" onClick={() => onResume(
      "继续当前任务。先核对已有结果和未完成事项；未知写入只回查，不重放。",
      { resume_task_id: task.task_id },
    )}>继续任务</button>
  </div>;
}
