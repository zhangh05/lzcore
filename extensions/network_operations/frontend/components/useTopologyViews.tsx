import { useEffect, useMemo, useRef, useState } from "react";
import { type CanvasApi } from "./NetOpsCanvas";
import { promptForm } from "../../../../frontend/src/components/FormDialog";
import type { SelectedElement, Topology } from "./topologyDocument";

export type useTopologyViewsPorts = {
  activeTopology: Topology | null;
  canvasApiRef: import("react").MutableRefObject<CanvasApi | null>;
  selectedElement: SelectedElement;
  selectedTopologyId: string;
  setNotice: (notice: string, ok?: boolean) => void;
  setSelectedElement: import("react").Dispatch<
    import("react").SetStateAction<SelectedElement>
  >;
  setSelectedTopologyId: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  topologies: Topology[];
  workspaceId: string;
};

export function useTopologyViews({
  activeTopology,
  canvasApiRef,
  selectedElement,
  selectedTopologyId,
  setNotice,
  setSelectedElement,
  setSelectedTopologyId,
  topologies,
  workspaceId,
}: useTopologyViewsPorts) {
  const deepLinkTopologyRef = useRef(false);
  const deepLinkNodeRef = useRef(false);
  // Only consume the incoming node link. Selection updates the URL too;
  // rereading that URL after a save used to schedule an unsolicited refocus.
  const incomingNodeRef = useRef(
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("node"),
  );
  useEffect(() => {
    if (deepLinkTopologyRef.current || !topologies.length) return;
    const wanted = new URLSearchParams(window.location.search).get("topology");
    if (wanted && topologies.some((item) => item.topology_id === wanted))
      setSelectedTopologyId(wanted);
    deepLinkTopologyRef.current = true;
  }, [topologies]);
  useEffect(() => {
    const nodeId = incomingNodeRef.current;
    if (!nodeId || !activeTopology || deepLinkNodeRef.current) return;
    if (!activeTopology.nodes.some((node) => node.node_id === nodeId)) return;
    deepLinkNodeRef.current = true;
    setSelectedElement({ type: "node", nodeId });
    window.setTimeout(() => canvasApiRef.current?.focusIds([nodeId], 1.1), 400);
  }, [activeTopology]);
  useEffect(() => {
    if (!selectedTopologyId || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("topology", selectedTopologyId);
    if (selectedElement?.type === "node")
      url.searchParams.set("node", selectedElement.nodeId);
    else url.searchParams.delete("node");
    window.history.replaceState({}, "", url.toString());
  }, [selectedTopologyId, selectedElement]);

  // Named views. On a large diagram, scrolling back to "the core layer" is
  // work people redo every time; a saved viewport costs one click.
  const bookmarkKey = useMemo(
    () => `lzcore.topology.views.${workspaceId}.${selectedTopologyId}`,
    [workspaceId, selectedTopologyId],
  );
  const [bookmarks, setBookmarks] = useState<
    Array<{ name: string; x: number; y: number; zoom: number }>
  >([]);
  const [currentBookmarkName, setCurrentBookmarkName] = useState<string>("");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(bookmarkKey);
      const list = stored ? JSON.parse(stored) : [];
      setBookmarks(list);
      if (list.length > 0) setCurrentBookmarkName(list[0].name);
    } catch {
      setBookmarks([]);
    }
  }, [bookmarkKey]);
  const saveBookmark = async () => {
    const view = canvasApiRef.current?.getViewport();
    if (!view) return;
    const name = await promptForm({
      title: "保存当前视图",
      label: "视图名称",
      initialValue: `视图 ${bookmarks.length + 1}`,
      hint: "同名视图会被覆盖。",
      requiredMessage: "请输入视图名称",
      confirmLabel: "保存视图",
    });
    if (!name) return;
    const next = [
      ...bookmarks.filter((item) => item.name !== name),
      { name, ...view },
    ];
    setBookmarks(next);
    setCurrentBookmarkName(name);
    window.localStorage.setItem(bookmarkKey, JSON.stringify(next));
    setNotice(`已保存视图「${name}」`);
  };
  const applyBookmark = (bookmark: {
    name: string;
    x: number;
    y: number;
    zoom: number;
  }) => {
    canvasApiRef.current?.setViewport(bookmark);
    setCurrentBookmarkName(bookmark.name);
    setNotice(`已切换到视图「${bookmark.name}」`);
  };
  const removeBookmark = (name: string) => {
    const next = bookmarks.filter((item) => item.name !== name);
    setBookmarks(next);
    if (currentBookmarkName === name) {
      setCurrentBookmarkName(next.length ? next[0].name : "");
    }
    window.localStorage.setItem(bookmarkKey, JSON.stringify(next));
  };
  return {
    applyBookmark,
    bookmarks,
    removeBookmark,
    saveBookmark,
    currentBookmarkName,
  };
}
