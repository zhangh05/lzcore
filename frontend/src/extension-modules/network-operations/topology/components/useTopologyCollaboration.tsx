import { useCallback, useEffect } from "react";
import {
  drawingActivity,
  hasDrawingChanges,
  type DrawingActivity,
  type DrawingEdit,
} from "./topologyCollaboration";
import type { Topology } from "./topologyDocument";
import {
  mergeTopologies,
  type MergeConflict,
  type MergeStats,
} from "./topologyMerge";

export type useTopologyCollaborationPorts = {
  activeTopologyRef: import("react").MutableRefObject<Topology | null>;
  adoptServerTopology: (next: Topology) => void;
  highlightedIds: string[];
  revisionRef: import("react").MutableRefObject<number>;
  saveStatusRef: import("react").MutableRefObject<
    "saved" | "saving" | "unsaved" | "conflict"
  >;
  saveTimerRef: import("react").MutableRefObject<number | null>;
  serverTopologyRef: import("react").MutableRefObject<Map<string, Topology>>;
  serverVersionsRef: import("react").MutableRefObject<Map<string, number>>;
  setActiveTopology: import("react").Dispatch<
    import("react").SetStateAction<Topology | null>
  >;
  setConflict: import("react").Dispatch<
    import("react").SetStateAction<{
      base: Topology;
      mine: Topology;
      theirs: Topology;
      merged: Topology;
      conflicts: MergeConflict[];
      stats: MergeStats;
    } | null>
  >;
  setDrawingActivities: import("react").Dispatch<
    import("react").SetStateAction<DrawingActivity[]>
  >;
  setFuture: import("react").Dispatch<
    import("react").SetStateAction<DrawingEdit[]>
  >;
  setHighlightedIds: import("react").Dispatch<
    import("react").SetStateAction<string[]>
  >;
  setHistory: import("react").Dispatch<
    import("react").SetStateAction<DrawingEdit[]>
  >;
  setNotice: (notice: string, ok?: boolean) => void;
  setSaveStatus: import("react").Dispatch<
    import("react").SetStateAction<"saved" | "saving" | "unsaved" | "conflict">
  >;
  setShowConflict: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
};

export function useTopologyCollaboration({
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
  setDrawingActivities,
  setFuture,
  setHighlightedIds,
  setHistory,
  setNotice,
  setSaveStatus,
  setShowConflict,
}: useTopologyCollaborationPorts) {
  const integrateRemoteDrawing = useCallback(
    (remote: Topology) => {
      const current = activeTopologyRef.current;
      if (!current || remote.topology_id !== current.topology_id) return false;
      const confirmed =
        serverTopologyRef.current.get(remote.topology_id) || current;
      if (remote.version <= confirmed.version) return false;
      const result = mergeTopologies(confirmed, current, remote);
      const pending = result.conflicts.length > 0;
      const activity = drawingActivity(
        confirmed,
        remote,
        pending ? "pending" : "displayed",
      );
      if (activity.added + activity.modified + activity.removed > 0) {
        setDrawingActivities((previous) =>
          [
            ...previous.filter((item) => item.version !== remote.version),
            activity,
          ].slice(-20),
        );
      }
      serverVersionsRef.current.set(remote.topology_id, remote.version);
      if (pending) {
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        saveStatusRef.current = "conflict";
        setSaveStatus("conflict");
        setConflict({
          base: confirmed,
          mine: current,
          theirs: remote,
          merged: result.topology,
          conflicts: result.conflicts,
          stats: result.stats,
        });
        setShowConflict(true);
        setNotice(
          "协作修改与本地编辑有冲突，请核对具体对象；你的编辑仍保留",
          false,
        );
        return false;
      }
      if (hasDrawingChanges(current, result.topology)) {
        setHistory((previous) => [
          ...previous.slice(-20),
          { before: current, after: result.topology, source: "collaboration" },
        ]);
        setFuture([]);
        setHighlightedIds(activity.ids);
      }
      serverTopologyRef.current.set(remote.topology_id, remote);
      setConflict(null);
      setShowConflict(false);
      if (hasDrawingChanges(remote, result.topology)) {
        // Keep the local overlay dirty on top of the new confirmed server base.
        revisionRef.current += 1;
        activeTopologyRef.current = result.topology;
        setActiveTopology(result.topology);
        saveStatusRef.current = "unsaved";
        setSaveStatus("unsaved");
        setNotice(
          "协作修改已显示，互不冲突的本地编辑已保留；可继续编辑或保存",
          true,
        );
      } else {
        adoptServerTopology(remote);
        setNotice(
          `协作修改已写入画板（v${remote.version}），可定位或撤销这次变化`,
          true,
        );
      }
      return true;
    },
    [adoptServerTopology, setNotice],
  );

  useEffect(() => {
    if (!highlightedIds.length) return;
    const timer = window.setTimeout(() => setHighlightedIds([]), 6000);
    return () => window.clearTimeout(timer);
  }, [highlightedIds]);
  return { integrateRemoteDrawing };
}
