import { useState } from "react";
import { api } from "../../api/client";
import { Button } from "../../components/Button";
import type { HttpOutcome } from "../../contracts/auth";
import { useApi, listOf } from "../../kit/useApi";
import { Drawer, FailureNote, JsonBlock, LoadState } from "../../kit/ui";

interface Tool { tool_id: string; name?: string; description?: string; side_effects?: string; risk?: string }

/** 能力 / 工具目录（挂在工作台头部）。dry-run 只演示，不执行。 */
export function CatalogDrawer({ ws, onClose }: { ws: string; onClose: () => void }) {
  const [catalog, reload] = useApi("/api/tools/catalog", { workspace_id: ws });
  const [dry, setDry] = useState<{ tool: string; o: HttpOutcome } | null>(null);
  return (
    <Drawer title="能力与工具目录" onClose={onClose} testId="catalog-drawer">
      <p className="inline-alert tone-info">「演示调用」走 <code>/api/tools/dry-run</code>：只展示将如何调用，不会执行。</p>
      <LoadState value={catalog} onReload={reload}>{() => (
        <ul className="tool-catalog">
          {listOf<Tool>(catalog, "tools").map((t) => (
            <li key={t.tool_id} className="card">
              <strong>{t.name ?? t.tool_id}</strong> <code>{t.tool_id}</code>
              <p className="muted">{t.description}</p>
              <Button onClick={async () => setDry({ tool: t.tool_id, o: await api.post("/api/tools/dry-run", { workspace_id: ws, tool_id: t.tool_id, arguments: {} }) })} data-testid={`dry-run-${t.tool_id}`}>演示调用（不执行）</Button>
              {dry?.tool === t.tool_id ? (dry.o.kind === "http" && dry.o.status < 300 ? <div data-testid="dry-run-result"><p className="muted">仅演示结果：</p><JsonBlock value={dry.o.body} /></div> : <FailureNote outcome={dry.o} />) : null}
            </li>
          ))}
        </ul>
      )}</LoadState>
    </Drawer>
  );
}
