/**
 * Two people editing one drawing. The merge must keep both sets of real edits
 * and never silently drop one — a wrong merge is worse than a reported clash.
 */

import { describe, expect, it } from "vitest";
import { mergeTopologies } from "../../../extensions/network_operations/frontend/components/topologyMerge";

type Node = { node_id: string; display_name?: string; x?: number; y?: number };
type Link = { link_id: string; source_node_id: string; target_node_id: string; status?: string };
type Drawing = {
  topology_id: string;
  name: string;
  version: number;
  nodes: Node[];
  links: Link[];
  groups: unknown[];
  canvas_items: unknown[];
};

function drawing(overrides: Partial<Drawing> = {}): Drawing {
  return {
    topology_id: "topo_1",
    name: "生产网",
    version: 3,
    nodes: [
      { node_id: "n1", display_name: "PE1", x: 100, y: 100 },
      { node_id: "n2", display_name: "PE2", x: 400, y: 100 },
    ],
    links: [{ link_id: "l1", source_node_id: "n1", target_node_id: "n2", status: "unknown" }],
    groups: [],
    canvas_items: [],
    ...overrides,
  };
}

describe("topology three-way merge", () => {
  it("keeps one side's edit when the other left it alone", () => {
    const base = drawing();
    const mine = drawing({ nodes: [{ node_id: "n1", display_name: "PE1", x: 260, y: 180 }, base.nodes[1]] });
    const theirs = drawing({
      version: 4,
      links: [{ link_id: "l2", source_node_id: "n2", target_node_id: "n1", status: "up" }, base.links[0]],
    });

    const { topology, conflicts, stats } = mergeTopologies(base, mine, theirs);
    const node = topology.nodes.find((item) => item.node_id === "n1");
    expect(node).toMatchObject({ x: 260, y: 180 }); // my move survived
    expect(topology.links.map((link) => link.link_id).sort()).toEqual(["l1", "l2"]); // their link survived
    expect(conflicts).toHaveLength(0);
    expect(stats.autoMerged).toBeGreaterThan(0);
  });

  it("merges independent nested metadata keys instead of dropping one object", () => {
    const base = drawing({
      links: [{ link_id: "l1", source_node_id: "n1", target_node_id: "n2", status: "unknown", metadata: { speed: "1G" } } as Link & { metadata: Record<string, string> }],
    });
    const mine = drawing({
      links: [{ ...base.links[0], metadata: { speed: "1G", vlan: "10" } } as Link & { metadata: Record<string, string> }],
    });
    const theirs = drawing({
      version: 4,
      links: [{ ...base.links[0], metadata: { speed: "10G" } } as Link & { metadata: Record<string, string> }],
    });

    const { topology, conflicts } = mergeTopologies(base, mine, theirs);
    expect((topology.links[0] as Link & { metadata: Record<string, string> }).metadata).toEqual({
      speed: "10G",
      vlan: "10",
    });
    expect(conflicts.some((item) => item.field === "metadata")).toBe(false);
  });

  it("reports a field both sides changed instead of dropping either silently", () => {
    const base = drawing();
    const mine = drawing({ name: "生产网-A" });
    const theirs = drawing({ name: "生产网-B", version: 4 });

    const { topology, conflicts } = mergeTopologies(base, mine, theirs);
    expect(topology.name).toBe("生产网-B"); // server copy stays authoritative
    expect(conflicts).toEqual([
      expect.objectContaining({ collection: "图纸", field: "name", mine: "生产网-A", theirs: "生产网-B" }),
    ]);
  });

  it("treats a deletion as deliberate but reports a delete-vs-edit clash", () => {
    const base = drawing();
    // They deleted n2; I only moved it.
    const mine = drawing({ nodes: [base.nodes[0], { ...base.nodes[1], x: 900 }] });
    const theirs = drawing({ nodes: [base.nodes[0]], links: [], version: 4 });

    const { topology, conflicts, stats } = mergeTopologies(base, mine, theirs);
    expect(topology.nodes.map((node) => node.node_id)).toEqual(["n1"]);
    expect(stats.removed).toBeGreaterThanOrEqual(1);
    expect(conflicts).toEqual([expect.objectContaining({ collection: "节点", id: "n2", field: "删除" })]);
  });

  it("keeps a deletion that was not contested", () => {
    const base = drawing();
    const mine = drawing({ nodes: [base.nodes[0]], links: [] }); // I deleted n2
    const theirs = drawing({ version: 4 }); // they changed nothing

    const { topology, conflicts } = mergeTopologies(base, mine, theirs);
    expect(topology.nodes.map((node) => node.node_id)).toEqual(["n1"]);
    expect(conflicts).toHaveLength(0);
  });

  it("adds objects created on either side", () => {
    const base = drawing();
    const mine = drawing({ nodes: [...base.nodes, { node_id: "n3", display_name: "CE1", x: 0, y: 300 }] });
    const theirs = drawing({ nodes: [...base.nodes, { node_id: "n4", display_name: "CE2", x: 600, y: 300 }], version: 4 });

    const { topology, stats } = mergeTopologies(base, mine, theirs);
    expect(topology.nodes.map((node) => node.node_id)).toEqual(["n1", "n2", "n3", "n4"]);
    expect(stats.added).toBe(2);
  });

  it("drops links whose endpoint did not survive the merge", () => {
    const base = drawing();
    // They deleted n2 but left l1 behind in their payload. A link with a
    // missing endpoint is rejected by the backend, so it must not be sent.
    const theirs = drawing({ nodes: [base.nodes[0]], links: base.links, version: 4 });
    const mine = drawing();

    const { topology, stats } = mergeTopologies(base, mine, theirs);
    expect(topology.nodes.map((node) => node.node_id)).toEqual(["n1"]);
    expect(topology.links).toEqual([]);
    expect(stats.orphanedLinks).toBe(1);
  });

  it("reports an id both sides created independently", () => {
    const base = drawing();
    const mine = drawing({ nodes: [...base.nodes, { node_id: "dup", display_name: "我的", x: 1, y: 1 }] });
    const theirs = drawing({ nodes: [...base.nodes, { node_id: "dup", display_name: "对方的", x: 2, y: 2 }], version: 4 });

    const { topology, conflicts } = mergeTopologies(base, mine, theirs);
    expect(topology.nodes.find((node) => node.node_id === "dup")?.display_name).toBe("对方的");
    expect(conflicts).toEqual([expect.objectContaining({ collection: "节点", id: "dup", field: "同时新增" })]);
  });

  it("takes the server version untouched when nothing changed locally", () => {
    const base = drawing();
    const theirs = drawing({ name: "生产网-B", version: 4 });
    const { topology, conflicts, stats } = mergeTopologies(base, base, theirs);
    expect(topology.name).toBe("生产网-B");
    expect(conflicts).toHaveLength(0);
    expect(stats).toMatchObject({ added: 0, removed: 0, orphanedLinks: 0 });
  });
});
