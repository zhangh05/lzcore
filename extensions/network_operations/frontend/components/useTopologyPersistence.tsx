import { useCallback, useEffect } from "react";
import { apiRequest } from "../../../../frontend/src/api/client";
import { TOPOLOGY_API_BASE as base } from "./topologyApi";
import {
  applyDrawingEdit,
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
import { fitRegions } from "./topologyRegions";

export type useTopologyPersistencePorts = {
  activeTopology: Topology | null;
  activeTopologyRef: import("react").MutableRefObject<Topology | null>;
  adoptServerTopology: (next: Topology) => void;
  conflict: {
    base: Topology;
    mine: Topology;
    theirs: Topology;
    merged: Topology;
    conflicts: MergeConflict[];
    stats: MergeStats;
  } | null;
  drawingActivities: DrawingActivity[];
  future: DrawingEdit[];
  history: DrawingEdit[];
  integrateRemoteDrawing: (remote: Topology) => boolean;
  onReload: () => Promise<void>;
  revisionRef: import("react").MutableRefObject<number>;
  saveChainRef: import("react").MutableRefObject<Promise<void>>;
  saveFailureRef: import("react").MutableRefObject<string | null>;
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
  workspaceId: string;
  workspaceIdRef: import("react").MutableRefObject<string>;
};

export function useTopologyPersistence({
  activeTopology,
  activeTopologyRef,
  adoptServerTopology,
  conflict,
  drawingActivities,
  future,
  history,
  integrateRemoteDrawing,
  onReload,
  revisionRef,
  saveChainRef,
  saveFailureRef,
  saveStatusRef,
  saveTimerRef,
  serverTopologyRef,
  serverVersionsRef,
  setActiveTopology,
  setConflict,
  setDrawingActivities,
  setFuture,
  setHistory,
  setNotice,
  setSaveStatus,
  setShowConflict,
  workspaceId,
  workspaceIdRef,
}: useTopologyPersistencePorts) {
  const resolveConflict = useCallback(
    async (mine: Topology) => {
      saveStatusRef.current = "conflict";
      setSaveStatus("conflict");
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      const requestedWorkspaceId = workspaceId;
      try {
        const res = await apiRequest<{ topology: Topology }>({
          method: "GET",
          url: `${base}/topologies/${mine.topology_id}`,
          params: { workspace_id: requestedWorkspaceId },
        });
        if (
          requestedWorkspaceId !== workspaceIdRef.current ||
          activeTopologyRef.current?.topology_id !== mine.topology_id
        )
          return;
        if (!res.topology) throw new Error("topology_not_found");
        return integrateRemoteDrawing(res.topology);
      } catch {
        if (
          requestedWorkspaceId !== workspaceIdRef.current ||
          activeTopologyRef.current?.topology_id !== mine.topology_id
        )
          return false;
        saveStatusRef.current = "unsaved";
        setSaveStatus("unsaved");
        setNotice(
          "拓扑版本冲突：已被其他操作修改，当前未保存编辑仍保留",
          false,
        );
        return false;
      }
    },
    [workspaceId, setNotice, integrateRemoteDrawing],
  );

  // Execute Save
  const executeSave = useCallback(
    (topo: Topology) => {
      const requestedWorkspaceId = workspaceId;
      const work = async () => {
        if (
          workspaceIdRef.current !== requestedWorkspaceId ||
          activeTopologyRef.current?.topology_id !== topo.topology_id
        )
          return;
        if (saveFailureRef.current) {
          // The previous write may have committed. A queued/clicked save first
          // reconciles that result and never replays the uncertain write.
          try {
            const response = await apiRequest<{ topology: Topology }>({
              method: "GET",
              url: `${base}/topologies/${topo.topology_id}`,
              params: { workspace_id: requestedWorkspaceId },
            });
            if (
              workspaceIdRef.current !== requestedWorkspaceId ||
              activeTopologyRef.current?.topology_id !== topo.topology_id
            )
              return;
            if (!response.topology)
              throw new Error("无法确认保存结果，请检查连接后重试");
            integrateRemoteDrawing(response.topology);
            if (
              !hasDrawingChanges(response.topology, activeTopologyRef.current)
            ) {
              adoptServerTopology(response.topology);
              setNotice("已核对服务端，图纸已保存", true);
            } else if (saveStatusRef.current !== "conflict") {
              setNotice(
                "已核对上次保存结果，本地编辑仍保留；请确认后再次保存",
                false,
              );
            }
            saveFailureRef.current = null;
          } catch (error) {
            if (
              workspaceIdRef.current !== requestedWorkspaceId ||
              activeTopologyRef.current?.topology_id !== topo.topology_id
            )
              return;
            setNotice(
              (error as Error).message || "无法确认上次保存结果",
              false,
            );
          }
          return;
        }
        if (saveStatusRef.current === "saved") return;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const revision = revisionRef.current;
          const snapshot: Topology | null = activeTopologyRef.current;
          if (!snapshot) return;
          // A conflict is an explicit decision point. Saves queued before it was
          // detected are stale by definition; sending them would only create more
          // 409s and could replace the snapshot the user is reviewing.
          if (saveStatusRef.current === "conflict") return;
          saveFailureRef.current = null;
          saveStatusRef.current = "saving";
          setSaveStatus("saving");
          try {
            const res: { topology: Topology } = await apiRequest<{
              topology: Topology;
            }>({
              method: "PUT",
              url: `${base}/topologies/${topo.topology_id}`,
              data: {
                workspace_id: workspaceId,
                name: snapshot.name,
                description: snapshot.description,
                version:
                  serverVersionsRef.current.get(topo.topology_id) ??
                  topo.version,
                nodes: snapshot.nodes,
                links: snapshot.links,
                groups: snapshot.groups,
                canvas_items: snapshot.canvas_items || [],
              },
            });
            if (
              requestedWorkspaceId !== workspaceIdRef.current ||
              activeTopologyRef.current?.topology_id !== topo.topology_id
            )
              return;
            serverVersionsRef.current.set(
              topo.topology_id,
              res.topology.version,
            );
            serverTopologyRef.current.set(topo.topology_id, res.topology);
            if (revision === revisionRef.current) {
              activeTopologyRef.current = res.topology;
              setActiveTopology(res.topology);
              saveStatusRef.current = "saved";
              setSaveStatus("saved");
              void onReload();
              setNotice("拓扑保存成功", true);
            } else {
              const latest: Topology | null = activeTopologyRef.current;
              if (latest?.topology_id === topo.topology_id) {
                activeTopologyRef.current = {
                  ...latest,
                  version: res.topology.version,
                };
                setActiveTopology(activeTopologyRef.current);
              }
              saveStatusRef.current = "unsaved";
              setSaveStatus("unsaved");
            }
          } catch (err: unknown) {
            if (
              requestedWorkspaceId !== workspaceIdRef.current ||
              activeTopologyRef.current?.topology_id !== topo.topology_id
            )
              return;
            const errMsg =
              (err as { message?: string })?.message || "保存拓扑失败";
            if (
              errMsg.includes("version_conflict") ||
              errMsg.includes("version conflict")
            ) {
              const merged = await resolveConflict(snapshot);
              // A rejected version performed no write. After a conflict-free
              // read/merge, finish the user's save once against the confirmed base.
              if (merged && !saveFailureRef.current && attempt === 0) continue;
              return;
            }
            saveStatusRef.current = "unsaved";
            setSaveStatus("unsaved");
            saveFailureRef.current = errMsg;
            setNotice(errMsg, false);
          }
          return;
        }
      };
      saveChainRef.current = saveChainRef.current.then(work, work);
      return saveChainRef.current;
    },
    [
      workspaceId,
      onReload,
      setNotice,
      resolveConflict,
      integrateRemoteDrawing,
      adoptServerTopology,
    ],
  );

  // Push state for undo/redo history tracking (manual save)
  const pushState = useCallback(
    (next: Topology) => {
      if (!activeTopology) return;
      next = fitRegions(next);
      const conflictPending = saveStatusRef.current === "conflict";
      setHistory((prev) => [
        ...prev.slice(-20),
        {
          before: activeTopologyRef.current || activeTopology,
          after: next,
          source: "manual",
        },
      ]);
      setFuture([]);
      revisionRef.current += 1;
      activeTopologyRef.current = next;
      setActiveTopology(next);
      if (conflictPending) {
        // The user may choose “稍后处理” and keep editing. Recompute against
        // the same confirmed base so the eventual decision contains every
        // local edit, not merely the snapshot that first hit the conflict.
        setConflict((pending) => {
          if (!pending) return pending;
          const merged = mergeTopologies(pending.base, next, pending.theirs);
          return {
            ...pending,
            mine: next,
            merged: merged.topology,
            conflicts: merged.conflicts,
            stats: merged.stats,
          };
        });
        return;
      }
      saveStatusRef.current = "unsaved";
      setSaveStatus("unsaved");

      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    },
    [activeTopology],
  );

  /**
   * Resolve a conflict the way the user asked. "Take theirs" is the only
   * branch that discards work, so it is also the only one that says so.
   */
  const applyConflictChoice = useCallback(
    (choice: "merged" | "theirs" | "mine") => {
      if (!conflict) return;
      setShowConflict(false);
      setConflict(null);
      if (choice === "theirs") {
        if (activeTopology)
          setHistory((previous) => [
            ...previous.slice(-20),
            {
              before: activeTopology,
              after: conflict.theirs,
              source: "collaboration",
            },
          ]);
        setFuture([]);
        setDrawingActivities((previous) =>
          previous.map((item) =>
            item.version === conflict.theirs.version
              ? { ...item, status: "displayed" }
              : item,
          ),
        );
        adoptServerTopology(conflict.theirs);
        setNotice("已采用服务端版本，本地未保存改动已放弃", true);
        return;
      }
      const target = choice === "merged" ? conflict.merged : conflict.mine;
      const nextTopology = { ...target, version: conflict.theirs.version };
      if (activeTopology) {
        setHistory((prev) => [
          ...prev.slice(-20),
          {
            before: activeTopology,
            after: nextTopology,
            source: choice === "mine" ? "manual" : "collaboration",
          },
        ]);
      }
      setFuture([]);
      revisionRef.current += 1;
      activeTopologyRef.current = nextTopology;
      serverTopologyRef.current.set(nextTopology.topology_id, conflict.theirs);
      setDrawingActivities((previous) =>
        choice === "mine"
          ? previous.filter((item) => item.version !== conflict.theirs.version)
          : previous.map((item) =>
              item.version === conflict.theirs.version
                ? { ...item, status: "displayed" }
                : item,
            ),
      );
      setActiveTopology(nextTopology);
      saveStatusRef.current = "unsaved";
      setSaveStatus("unsaved");
      void executeSave(nextTopology);
      setNotice(
        choice === "merged"
          ? `已合并双方改动并保存（自动合并 ${conflict.stats.autoMerged} 处，需人工确认 ${conflict.conflicts.length} 处）`
          : "已用本地版本覆盖服务端改动并保存",
        choice === "merged",
      );
    },
    [conflict, activeTopology, adoptServerTopology, executeSave, setNotice],
  );

  const applyHistoryEntry = useCallback(
    (entry: DrawingEdit, undo: boolean) => {
      const current = activeTopologyRef.current;
      if (!current || saveStatusRef.current === "conflict") return false;
      const result = applyDrawingEdit(current, entry, undo);
      if (result.conflicts.length) {
        setNotice(
          "这些对象在此后又被修改，无法直接撤销或恢复；请先核对相关对象",
          false,
        );
        return false;
      }
      activeTopologyRef.current = result.topology;
      setActiveTopology(result.topology);
      revisionRef.current += 1;
      saveStatusRef.current = "unsaved";
      setSaveStatus("unsaved");
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      return true;
    },
    [setNotice],
  );

  const handleUndo = useCallback(() => {
    const entry = history[history.length - 1];
    if (!entry || !applyHistoryEntry(entry, true)) return;
    setHistory((previous) => previous.slice(0, -1));
    setFuture((previous) => [entry, ...previous]);
  }, [history, applyHistoryEntry]);

  const handleRedo = useCallback(() => {
    const entry = future[0];
    if (!entry || !applyHistoryEntry(entry, false)) return;
    setFuture((previous) => previous.slice(1));
    setHistory((previous) => [...previous, entry]);
  }, [future, applyHistoryEntry]);

  const undoDrawingChange = useCallback(
    async (version: number) => {
      const index = history
        .map(
          (entry) =>
            entry.source === "collaboration" && entry.after.version === version,
        )
        .lastIndexOf(true);
      let entry = history[index];
      if (!entry) {
        const activity = drawingActivities.find(
          (item) => item.version === version,
        );
        const topology = activeTopologyRef.current;
        if (!activity?.revision_id || !topology) {
          setNotice("这次变化不在保留的记录中", false);
          return;
        }
        try {
          const response = await apiRequest<{
            edit: { before: Topology; after: Topology };
          }>({
            url: `/extensions/network.operations/topologies/${topology.topology_id}/revisions/${activity.revision_id}/edit`,
            params: { workspace_id: workspaceId },
          });
          if (
            activeTopologyRef.current?.topology_id !== topology.topology_id ||
            workspaceIdRef.current !== workspaceId
          )
            return;
          entry = { ...response.edit, source: "collaboration" };
        } catch {
          setNotice("无法读取这次变化，请重试", false);
          return;
        }
      }
      if (!applyHistoryEntry(entry, true)) return;
      setHistory((previous) =>
        previous.filter((_, itemIndex) => itemIndex !== index),
      );
      setFuture([]);
      setDrawingActivities((previous) =>
        previous.filter((item) => item.version !== version),
      );
      setNotice("已撤销这次协作变化，其他编辑已保留；保存后同步到服务端", true);
    },
    [history, drawingActivities, workspaceId, applyHistoryEntry, setNotice],
  );

  const prepareDrawing = useCallback(async () => {
    const targetId = activeTopologyRef.current?.topology_id;
    const targetWorkspace = workspaceId;
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await saveChainRef.current;
    if (saveFailureRef.current && targetId) {
      // A failed response may hide a committed write. Read back before any retry.
      const response = await apiRequest<{ topology: Topology }>({
        method: "GET",
        url: `${base}/topologies/${targetId}`,
        params: { workspace_id: targetWorkspace },
      });
      if (
        workspaceIdRef.current !== targetWorkspace ||
        activeTopologyRef.current?.topology_id !== targetId
      ) {
        throw new Error("图纸或工作区已切换，请在当前画板重新发送。");
      }
      if (!response.topology)
        throw new Error("无法确认保存结果，请检查连接后重试；指令尚未发送。");
      integrateRemoteDrawing(response.topology);
      if (
        activeTopologyRef.current &&
        !hasDrawingChanges(response.topology, activeTopologyRef.current)
      )
        adoptServerTopology(response.topology);
      saveFailureRef.current = null;
    }
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      const current = activeTopologyRef.current;
      if (
        !current ||
        current.topology_id !== targetId ||
        workspaceIdRef.current !== targetWorkspace
      ) {
        throw new Error("图纸或工作区已切换，请在当前画板重新发送。");
      }
      if (saveStatusRef.current === "conflict")
        throw new Error("请先处理图纸冲突，再让 Agent 编辑。");
      if (saveStatusRef.current === "saved") {
        return serverTopologyRef.current.get(current.topology_id) || current;
      }
      if (attempt < 3) {
        await executeSave(current);
        if (saveFailureRef.current)
          throw new Error(
            `图纸保存未确认：${saveFailureRef.current}。请检查保存状态后重试；指令尚未发送。`,
          );
      }
    }
    throw new Error(
      "图纸尚未保存完成，请检查保存状态或稍停编辑后重试；指令尚未发送。",
    );
  }, [workspaceId, executeSave, integrateRemoteDrawing, adoptServerTopology]);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (saveStatusRef.current === "unsaved") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, []);
  return {
    pushState,
    executeSave,
    handleRedo,
    handleUndo,
    prepareDrawing,
    undoDrawingChange,
    applyConflictChoice,
  };
}
