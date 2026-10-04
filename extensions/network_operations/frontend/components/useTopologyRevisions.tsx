import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "../../../../frontend/src/api/client";
import {
  onTopologyUpdated,
  onTransportResumed,
} from "../../../../frontend/src/realtime/turnTransport";
import { TOPOLOGY_API_BASE as base } from "./topologyApi";
import { type DrawingEdit } from "./topologyCollaboration";
import type { Topology } from "./topologyDocument";
import { RevisionDiff, TopologyRevision } from "./topologyRevisionModel";

export type useTopologyRevisionsPorts = {
  activeTopology: Topology | null;
  activeTopologyRef: import("react").MutableRefObject<Topology | null>;
  adoptServerTopology: (next: Topology) => void;
  currentTopology: Topology | null;
  integrateRemoteDrawing: (remote: Topology) => boolean;
  revisions: TopologyRevision[];
  saveChainRef: import("react").MutableRefObject<Promise<void>>;
  saveStatusRef: import("react").MutableRefObject<
    "saved" | "saving" | "unsaved" | "conflict"
  >;
  selectedTopologyId: string;
  setDiffLoading: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setFuture: import("react").Dispatch<
    import("react").SetStateAction<DrawingEdit[]>
  >;
  setHistory: import("react").Dispatch<
    import("react").SetStateAction<DrawingEdit[]>
  >;
  setNotice: (notice: string, ok?: boolean) => void;
  setRestoringId: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setRevisionDiff: import("react").Dispatch<
    import("react").SetStateAction<RevisionDiff | null>
  >;
  setRevisions: import("react").Dispatch<
    import("react").SetStateAction<TopologyRevision[]>
  >;
  setRevisionsLoading: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setShowRevisions: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  workspaceId: string;
  workspaceIdRef: import("react").MutableRefObject<string>;
};

export function useTopologyRevisions({
  activeTopology,
  activeTopologyRef,
  adoptServerTopology,
  currentTopology,
  integrateRemoteDrawing,
  revisions,
  saveChainRef,
  saveStatusRef,
  selectedTopologyId,
  setDiffLoading,
  setFuture,
  setHistory,
  setNotice,
  setRestoringId,
  setRevisionDiff,
  setRevisions,
  setRevisionsLoading,
  setShowRevisions,
  workspaceId,
  workspaceIdRef,
}: useTopologyRevisionsPorts) {
  const handleOpenRevisions = useCallback(async () => {
    if (!activeTopology) return;
    setRevisionsLoading(true);
    setRevisionDiff(null);
    setShowRevisions(true);
    try {
      const res = await apiRequest<{ revisions: TopologyRevision[] }>({
        method: "GET",
        url: `${base}/topologies/${activeTopology.topology_id}/revisions`,
        params: { workspace_id: workspaceId },
      });
      setRevisions(res.revisions || []);
    } catch {
      setNotice("版本历史读取失败，请稍后重试", false);
    } finally {
      setRevisionsLoading(false);
    }
  }, [activeTopology, workspaceId, setNotice]);

  const handleDiffRevision = useCallback(
    async (revisionId: string) => {
      if (!activeTopology) return;
      setDiffLoading(true);
      try {
        const res = await apiRequest<{ diff: RevisionDiff }>({
          method: "GET",
          url: `${base}/topologies/${activeTopology.topology_id}/revisions/${revisionId}/diff`,
          params: { workspace_id: workspaceId },
        });
        setRevisionDiff(res.diff);
      } catch {
        setNotice("版本差异读取失败，请稍后重试", false);
      } finally {
        setDiffLoading(false);
      }
    },
    [activeTopology, workspaceId, setNotice],
  );

  /**
   * Version notices, reconnects and completed turns share one coalesced read.
   * Merge over the confirmed baseline; preserve the local overlay and report
   * overlapping changes instead of replacing the drawing with an old snapshot.
   */
  const reconcileRequestsRef = useRef(new Map<string, Promise<void>>());
  const pendingReconcilesRef = useRef(new Set<string>());
  const reconcileServerTopology = useCallback(
    (topologyId: string): Promise<void> => {
      const requestedWorkspaceId = workspaceId;
      const key = JSON.stringify([requestedWorkspaceId, topologyId]);
      const inFlight = reconcileRequestsRef.current.get(key);
      if (inFlight) {
        pendingReconcilesRef.current.add(key);
        return inFlight;
      }
      const work = async () => {
        do {
          pendingReconcilesRef.current.delete(key);
          try {
            const res = await apiRequest<{ topology: Topology }>({
              method: "GET",
              url: `${base}/topologies/${topologyId}`,
              params: { workspace_id: requestedWorkspaceId },
            });
            if (
              requestedWorkspaceId !== workspaceIdRef.current ||
              activeTopologyRef.current?.topology_id !== topologyId
            )
              return;
            if (!res.topology || res.topology.topology_id !== topologyId)
              return;
            if (saveStatusRef.current === "saving") {
              await saveChainRef.current;
              pendingReconcilesRef.current.add(key);
            } else {
              integrateRemoteDrawing(res.topology);
            }
          } catch {
            // Preserve the current drawing; a later broadcast/resume retries reads.
            return;
          }
        } while (
          pendingReconcilesRef.current.has(key) &&
          requestedWorkspaceId === workspaceIdRef.current &&
          activeTopologyRef.current?.topology_id === topologyId
        );
      };
      const request = work().finally(() => {
        reconcileRequestsRef.current.delete(key);
        pendingReconcilesRef.current.delete(key);
      });
      reconcileRequestsRef.current.set(key, request);
      return request;
    },
    [workspaceId, integrateRemoteDrawing],
  );

  const handleAgentCompleted = useCallback(async () => {
    const topologyId = activeTopologyRef.current?.topology_id;
    if (!topologyId) return;
    await reconcileServerTopology(topologyId);
  }, [reconcileServerTopology]);

  useEffect(() => {
    return onTopologyUpdated((data) => {
      if (data.workspace_id !== workspaceId) return;
      if (
        !data.topology_id ||
        data.topology_id !== activeTopologyRef.current?.topology_id
      )
        return;
      if ((data.version || 0) <= (activeTopologyRef.current?.version || 0))
        return;
      void reconcileServerTopology(data.topology_id);
    });
  }, [workspaceId, reconcileServerTopology]);

  useEffect(() => {
    return onTransportResumed(() => {
      const topologyId = activeTopologyRef.current?.topology_id;
      if (topologyId) void reconcileServerTopology(topologyId);
    });
  }, [reconcileServerTopology]);

  useEffect(() => {
    const topologyId =
      activeTopologyRef.current?.topology_id || selectedTopologyId;
    if (topologyId) void reconcileServerTopology(topologyId);
  }, [
    selectedTopologyId,
    workspaceId,
    currentTopology?.version,
    reconcileServerTopology,
  ]);

  const [restoreLayout, setRestoreLayout] = useState(true);

  const handleRestoreRevision = useCallback(
    async (revisionId: string) => {
      if (!activeTopology) return;
      setRestoringId(revisionId);
      try {
        const res = await apiRequest<{ topology: Topology }>({
          method: "POST",
          url: `${base}/topologies/${activeTopology.topology_id}/revisions/${revisionId}/restore`,
          params: { workspace_id: workspaceId },
          data: { restore_layout: restoreLayout },
        });
        if (res.topology) {
          // Keep the pre-restore drawing on the undo stack, but treat the
          // restored one as already saved — it is, the server just wrote it.
          setHistory((prev) => [
            ...prev.slice(-20),
            { before: activeTopology, after: res.topology, source: "manual" },
          ]);
          setFuture([]);
          adoptServerTopology(res.topology);
          const restoredVersion = revisions.find(
            (item) => item.revision_id === revisionId,
          )?.version;
          setNotice(
            restoredVersion
              ? restoreLayout
                ? `已按版本 ${restoredVersion} 的结构恢复（含完整布局坐标）`
                : `已按版本 ${restoredVersion} 的结构恢复，节点保留当前布局`
              : "已成功恢复所选版本",
            true,
          );
        }
        setShowRevisions(false);
        setRevisionDiff(null);
      } catch (err: unknown) {
        setNotice(
          (err as { message?: string })?.message || "恢复失败，请稍后重试",
          false,
        );
      } finally {
        setRestoringId("");
      }
    },
    [
      activeTopology,
      workspaceId,
      restoreLayout,
      adoptServerTopology,
      setNotice,
      revisions,
    ],
  );
  return {
    handleOpenRevisions,
    handleAgentCompleted,
    restoreLayout,
    setRestoreLayout,
    handleDiffRevision,
    handleRestoreRevision,
  };
}
