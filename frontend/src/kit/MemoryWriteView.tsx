import { useState } from "react";
import { Button } from "../components/Button";
import { FailureNote } from "./ui";
import { readBackMemory, type MemoryWriteState } from "./memoryWrite";

/** 写记忆结果展示：未知态专门界面（只回读，不重复写入）。 */
export function MemoryWriteView({ ws, state, onState }: { ws: string; state: MemoryWriteState; onState: (s: MemoryWriteState) => void }) {
  const [busy, setBusy] = useState(false);
  switch (state.kind) {
    case "idle": return null;
    case "writing": return <p role="status" className="muted">正在写入…</p>;
    case "reading_back": return <p role="status" className="muted">正在回读 {state.memoryId}…</p>;
    case "written": {
      const status = String(state.record.status ?? "");
      if (status === "conflict") return <p role="alert" className="inline-alert tone-warn" data-testid="memory-conflict">已写入但与已有记忆冲突（memory_id: <code>{state.memoryId}</code>），当前不会生效；请到「资料 / 记忆」确认采用哪一条。</p>;
      if (status === "pending") return <p role="status" className="inline-alert tone-info" data-testid="memory-pending">已写入，待确认后生效（memory_id: <code>{state.memoryId}</code>）。</p>;
      return <p role="status" className="inline-alert tone-ok" data-testid="memory-written">已记住并回读确认（memory_id: <code>{state.memoryId}</code>）。</p>;
    }
    case "readback_missing": return <p role="alert" className="inline-alert tone-warn" data-testid="memory-missing">回读未找到 <code>{state.memoryId}</code>：写入可能未生效。请到「资料 / 记忆」核对后再决定，这里不会自动重写。</p>;
    case "failed": return <FailureNote outcome={state.outcome} />;
    case "unknown":
      return (
        <div role="alert" className="inline-alert tone-unknown" data-testid="memory-unknown">
          <strong>结果未知 · 需核对</strong>
          <p>{state.detail} memory_id：<code>{state.memoryId}</code>。为避免重复写入，这里不提供再次写入。</p>
          <Button disabled={busy} onClick={async () => { setBusy(true); onState(await readBackMemory(ws, state.memoryId)); setBusy(false); }} data-testid="memory-readback">回读核对</Button>
        </div>
      );
  }
}
