import { type FormEvent } from "react";
import { apiRequest } from "../../../../frontend/src/api/client";
import { confirm } from "../../../../frontend/src/components/ConfirmDialog";
import { TOPOLOGY_API_BASE as base } from "./topologyApi";
import type { Topology } from "./topologyDocument";

export type useTopologyMetadataPorts = {
  activeTopology: Topology | null;
  onReload: () => Promise<void>;
  pushState: (next: Topology) => void;
  setNotice: (notice: string, ok?: boolean) => void;
  setSelectedElement: import("react").Dispatch<
    import("react").SetStateAction<import("./topologyDocument").SelectedElement>
  >;
  setSelectedTopologyId: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setTopologyDescInput: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  setTopologyModalMode: import("react").Dispatch<
    import("react").SetStateAction<"create" | "edit" | null>
  >;
  setTopologyNameInput: import("react").Dispatch<
    import("react").SetStateAction<string>
  >;
  topologyDescInput: string;
  topologyModalMode: "create" | "edit" | null;
  topologyNameInput: string;
  workspaceId: string;
};

export function useTopologyMetadata({
  activeTopology,
  onReload,
  pushState,
  setNotice,
  setSelectedElement,
  setSelectedTopologyId,
  setTopologyDescInput,
  setTopologyModalMode,
  setTopologyNameInput,
  topologyDescInput,
  topologyModalMode,
  topologyNameInput,
  workspaceId,
}: useTopologyMetadataPorts) {
  const handleSaveTopologyMeta = async (e: FormEvent) => {
    e.preventDefault();
    if (!topologyNameInput.trim()) return;

    if (topologyModalMode === "create") {
      try {
        const res = await apiRequest<{ topology: Topology }>({
          method: "POST",
          url: `${base}/topologies`,
          data: {
            workspace_id: workspaceId,
            name: topologyNameInput.trim(),
            description: topologyDescInput.trim(),
            nodes: [],
            links: [],
            groups: [],
          },
        });
        setTopologyModalMode(null);
        setTopologyNameInput("");
        setTopologyDescInput("");
        await onReload();
        setSelectedTopologyId(res.topology.topology_id);
        setNotice(`拓扑“${res.topology.name}”创建成功`);
      } catch (err: unknown) {
        setNotice(
          (err as { message?: string })?.message || "创建拓扑失败",
          false,
        );
      }
    } else if (topologyModalMode === "edit" && activeTopology) {
      // Renaming is an ordinary canvas edit, so it goes through the same
      // save path. A second hand-rolled PUT here reported a raw
      // "topology_version_conflict" to the user instead of offering the merge.
      const nextName = topologyNameInput.trim();
      setTopologyModalMode(null);
      pushState({
        ...activeTopology,
        name: nextName,
        description: topologyDescInput.trim(),
      });
      setNotice(`拓扑“${nextName}”信息已更新`);
    }
  };

  // Delete current topology
  const handleDeleteTopology = async () => {
    if (!activeTopology) return;
    const confirmed = await confirm({
      title: "永久删除网络拓扑",
      body: `将永久删除拓扑“${activeTopology.name}”。\n只删除这张图纸及版本历史。此操作不可撤销。`,
      confirmLabel: "永久删除拓扑",
      destructive: true,
    });
    if (!confirmed) return;

    try {
      await apiRequest({
        method: "DELETE",
        url: `${base}/topologies/${activeTopology.topology_id}`,
        data: { workspace_id: workspaceId },
      });
      setSelectedElement(null);
      await onReload();
      setNotice(`拓扑“${activeTopology.name}”已删除`);
    } catch (err: unknown) {
      setNotice(
        (err as { message?: string })?.message || "删除拓扑失败",
        false,
      );
    }
  };
  return { handleSaveTopologyMeta, handleDeleteTopology };
}
