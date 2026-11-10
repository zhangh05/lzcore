import { useCallback, useEffect, useState } from "react";
import { api, bodyOf, enc } from "../../api/client";
import type { HttpOutcome } from "../../contracts/auth";
import type { SessionSummary } from "./model";

export function useSessions(ws: string | null, status: "active" | "archived", currentId?: string | null) {
  const [list, setList] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<HttpOutcome | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!ws) return;
    let off = false;
    void api.get("/api/sessions", { workspace_id: ws, status, limit: 200 }).then((o) => {
      if (off) return;
      const b = bodyOf<{ sessions?: SessionSummary[] }>(o);
      if (o.kind === "http" && o.status === 200 && Array.isArray(b?.sessions)) { setList(b!.sessions!); setError(null); }
      else { setList([]); setError(o); }
    });
    return () => { off = true; };
  }, [ws, status, tick, currentId]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { list, error, reload };
}

export async function createSession(ws: string, title = ""): Promise<{ session?: SessionSummary; outcome: HttpOutcome }> {
  const o = await api.post("/api/sessions", { workspace_id: ws, title });
  const s = bodyOf<{ session?: SessionSummary }>(o)?.session;
  return { session: o.kind === "http" && o.status < 300 ? s : undefined, outcome: o };
}

export const sessionOps = {
  rename: (ws: string, id: string, title: string) => api.put(`/api/sessions/${enc(id)}`, { workspace_id: ws, title }),
  archive: (ws: string, id: string) => api.post(`/api/sessions/${enc(id)}/archive`, { workspace_id: ws }),
  restore: (ws: string, id: string) => api.post(`/api/sessions/${enc(id)}/restore`, { workspace_id: ws }),
  remove: (ws: string, id: string) => api.del(`/api/sessions/${enc(id)}`, { workspace_id: ws }, { workspace_id: ws }),
};
