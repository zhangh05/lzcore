import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionStore } from "../../../frontend/src/stores/session";
import { apiRequest } from "../../../frontend/src/api/client";
import TopologyWorkspace, { type Topology } from "./components/TopologyWorkspace";
import "./NetworkOperations.css";

/** Drawing page has no dependency on the asset/connection/inspection catalogs. */
export default function TopologyPage() {
  const workspaceId = useSessionStore(state => state.currentWorkspaceId);
  return <DrawingPage key={workspaceId} workspaceId={workspaceId} />;
}

function DrawingPage({ workspaceId }: { workspaceId: string }) {
  const [topologies, setTopologies] = useState<Topology[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [notice, setNoticeState] = useState({ text: "", ok: true });
  const requestId = useRef(0);
  const setNotice = useCallback((text: string, ok = true) => setNoticeState({ text, ok }), []);
  const load = useCallback(async () => {
    const current = ++requestId.current;
    setBusy(true);
    try {
      const result = await apiRequest<{ topologies: Topology[] }>({ method: "GET", url: "/extensions/network.operations/topologies", params: { workspace_id: workspaceId } });
      if (current !== requestId.current) return;
      setTopologies(result.topologies || []);
      setError("");
    } catch { if (current === requestId.current) setError("图纸加载失败，请重试。"); }
    finally { if (current === requestId.current) setBusy(false); }
  }, [workspaceId]);
  useEffect(() => { void load(); return () => { requestId.current++; }; }, [load]);
  return <div className="network-admin is-topology topology-route">
    {notice.text && <div role="status" className={`network-notice${notice.ok ? " kind-ok" : ""}`}>{notice.text}</div>}
    <TopologyWorkspace workspaceId={workspaceId} topologies={topologies} loadError={error} busy={busy} onReload={load} setNotice={setNotice} />
  </div>;
}
