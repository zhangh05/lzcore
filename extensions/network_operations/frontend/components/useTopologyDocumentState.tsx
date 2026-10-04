import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "../../../../frontend/src/api/client";
import { desktopDirty } from "../../../../frontend/src/desktop/bridge";
import {
  type DrawingActivity,
  type DrawingEdit,
} from "./topologyCollaboration";
import type { Topology } from "./topologyDocument";
import { type MergeConflict, type MergeStats } from "./topologyMerge";

export type useTopologyDocumentStatePorts = {
  currentTopology: Topology | null;
  setNotice: (notice: string, ok?: boolean) => void;
  workspaceId: string;
};

export function useTopologyDocumentState({
  currentTopology,
  setNotice,
  workspaceId,
}: useTopologyDocumentStatePorts) {
  const [activeTopology, setActiveTopology] = useState<Topology | null>(
    currentTopology,
  );
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  const activeTopologyRef = useRef(activeTopology);
  activeTopologyRef.current = activeTopology;
  const saveStatusRef = useRef<"saved" | "saving" | "unsaved" | "conflict">(
    "saved",
  );
  const revisionRef = useRef(0);
  const serverVersionsRef = useRef(new Map<string, number>());
  /**
   * The last version the server confirmed, kept per drawing. A conflict can
   * only be merged against this base: without it we would know that two
   * drawings differ but not which side changed what.
   */
  const serverTopologyRef = useRef(new Map<string, Topology>());
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const saveFailureRef = useRef<string | null>(null);
  const baselineWorkspaceRef = useRef(workspaceId);
  useEffect(() => {
    if (baselineWorkspaceRef.current === workspaceId) return;
    baselineWorkspaceRef.current = workspaceId;
    serverTopologyRef.current.clear();
    serverVersionsRef.current.clear();
    saveChainRef.current = Promise.resolve();
    saveFailureRef.current = null;
    saveStatusRef.current = "saved";
    setSaveStatus("saved");
  }, [workspaceId]);
  useEffect(() => {
    if (saveStatusRef.current !== "saved") return;
    if (currentTopology) {
      // A reload can resolve *after* a later save has already been adopted. The
      // list it carries is older than what is on screen, and adopting it drags
      // every object back to where it was one edit ago — then the next reload
      // drags it forward again. Two jumps an edit apart is what the user
      // reports as a flash, and the guard above does not cover it: it only asks
      // whether a save is in flight, not whether this list is newer than what
      // we already have. `serverVersionsRef` holds exactly the number needed to
      // tell the two apart. Measured before this check: a list reply released
      // one edit late moved a node 74px back to its previous resting place.
      const known = serverVersionsRef.current.get(currentTopology.topology_id);
      if (
        known !== undefined &&
        currentTopology.version !== known &&
        activeTopologyRef.current?.topology_id === currentTopology.topology_id
      )
        return;
    }
    setActiveTopology(currentTopology);
    if (currentTopology?.region_migration_issues?.length)
      setNotice(
        `有 ${currentTopology.region_migration_issues.length} 台设备区域归属待确认，请在设备详情中指定区域`,
        false,
      );
    if (currentTopology) {
      serverVersionsRef.current.set(
        currentTopology.topology_id,
        currentTopology.version,
      );
      serverTopologyRef.current.set(
        currentTopology.topology_id,
        currentTopology,
      );
    }
  }, [currentTopology, setNotice]);

  // Undo / Redo history
  const [history, setHistory] = useState<DrawingEdit[]>([]);
  const [future, setFuture] = useState<DrawingEdit[]>([]);
  const [drawingActivities, setDrawingActivities] = useState<DrawingActivity[]>(
    [],
  );
  useEffect(() => {
    if (!activeTopology) return;
    let cancelled = false;
    void apiRequest<{
      revisions: Array<{
        revision_id: string;
        version: number;
        saved_at: string;
        source: string;
        activity?: Pick<
          DrawingActivity,
          "ids" | "added" | "modified" | "removed" | "removedLabels"
        >;
      }>;
    }>({
      url: `/extensions/network.operations/topologies/${activeTopology.topology_id}/revisions`,
      params: { workspace_id: workspaceId },
    })
      .then((response) => {
        if (cancelled) return;
        if (!Array.isArray(response.revisions))
          throw new Error("invalid_revision_response");
        setDrawingActivities((previous) =>
          [
            ...previous.filter(
              (local) =>
                !response.revisions.some(
                  (item) => item.version === local.version && item.activity,
                ),
            ),
            ...response.revisions
              .filter((item) => item.activity)
              .map(
                (item) =>
                  ({
                    ...item.activity!,
                    version: item.version,
                    revision_id: item.revision_id,
                    saved_at: item.saved_at,
                    source:
                      item.source === "agent" ? "collaboration" : "manual",
                    status:
                      previous.find(
                        (activity) => activity.version === item.version,
                      )?.status || "displayed",
                  }) as DrawingActivity,
              ),
          ]
            .sort((a, b) => a.version - b.version)
            .slice(-20),
        );
      })
      .catch(() => {
        if (!cancelled)
          setNotice("图纸变化记录暂未加载，画布与对话仍保留", false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    workspaceId,
    activeTopology?.topology_id,
    activeTopology?.version,
    setNotice,
  ]);
  const [highlightedIds, setHighlightedIds] = useState<string[]>([]);
  const [saveStatus, setSaveStatus] = useState<
    "saved" | "saving" | "unsaved" | "conflict"
  >("saved");
  useEffect(() => {
    desktopDirty("topology", saveStatus !== "saved");
    return () => desktopDirty("topology", false);
  }, [saveStatus]);
  // A conflict is a decision, not an error: hold both sides until the user picks.
  const [conflict, setConflict] = useState<{
    base: Topology;
    mine: Topology;
    theirs: Topology;
    merged: Topology;
    conflicts: MergeConflict[];
    stats: MergeStats;
  } | null>(null);
  const [showConflict, setShowConflict] = useState(false);
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;
  const saveTimerRef = useRef<number | null>(null);

  /**
   * Adopt a drawing the server has already written.
   *
   * Restore, agent write-back and "take the server version" all end with the
   * server holding a newer version than the one this tab remembers. Routing
   * those through `pushState` scheduled another save against the stale
   * version, so the next thing the user saw was a conflict with themselves.
   */
  const adoptServerTopology = useCallback(
    (next: Topology) => {
      revisionRef.current += 1;
      serverVersionsRef.current.set(next.topology_id, next.version);
      serverTopologyRef.current.set(next.topology_id, next);
      activeTopologyRef.current = next;
      setActiveTopology(next);
      if (next.region_migration_issues?.length)
        setNotice(
          `区域迁移完成，有 ${next.region_migration_issues.length} 台设备归属待确认，请在设备详情中指定区域`,
          false,
        );
      saveStatusRef.current = "saved";
      setSaveStatus("saved");
    },
    [setNotice],
  );
  return {
    setHistory,
    setFuture,
    setDrawingActivities,
    setHighlightedIds,
    activeTopology,
    activeTopologyRef,
    adoptServerTopology,
    highlightedIds,
    revisionRef,
    saveStatusRef,
    saveTimerRef,
    serverTopologyRef,
    serverVersionsRef,
    setActiveTopology,
    setConflict,
    setSaveStatus,
    setShowConflict,
    conflict,
    drawingActivities,
    future,
    history,
    saveChainRef,
    saveFailureRef,
    workspaceIdRef,
    saveStatus,
    showConflict,
  };
}
