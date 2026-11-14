/** canvasSceneProjection is a renderer port independent of React screen state. */
import type {
  CanvasElementSpec,
  Cy,
  CyElement,
  CyNode,
} from "./canvasRendererTypes";
import type { TopologyCanvasItem } from "./topologyDocument";

export const canvasItemDefaults: Record<
  TopologyCanvasItem["kind"],
  Required<TopologyCanvasItem>["style"]
> = {
  rectangle: { fill: "#f5f5f5", border: "#c7c7c7", color: "#424242" },
  ellipse: { fill: "#ebf3fc", border: "#96c6fa", color: "#0f548c" },
  text: { fill: "#ffffff", border: "#ffffff", color: "#424242" },
};

export const SKIPPED_DATA_KEYS = new Set(["id", "source", "target"]);

export function applyElements(
  cy: Cy,
  elements: CanvasElementSpec[],
  connectingId: string | null,
  syncPositions: boolean,
): void {
  const desired = new Map(
    elements.map((element) => [String(element.data.id), element]),
  );
  const stale: CyElement[] = [];
  const fresh: CanvasElementSpec[] = [];
  const dragActive = cy.$("node:grabbed").length > 0;
  cy.batch(() => {
    cy.elements().forEach((existing) => {
      const next = desired.get(existing.id());
      if (!next) {
        stale.push(existing);
        return;
      }
      for (const key of Object.keys(next.data)) {
        if (SKIPPED_DATA_KEYS.has(key) || key.startsWith("_")) continue;
        if (existing.data(key) !== next.data[key])
          existing.data(key, next.data[key]);
      }
      const classes = next.classes || "";
      // Preserve the transient connecting marker across reconciliation.
      const effective =
        existing.id() === connectingId
          ? `${classes} node-connecting`.trim()
          : classes;
      if (existing.data("_cls") !== effective) {
        existing.data("_cls", effective);
        existing.classes(effective);
      }
      // Never reposition a node the user is holding. A save round-trip replaces
      // the whole topology — the debounced PUT's reply, and then the list reload
      // that follows it — and neither knows a drag is in progress. Forcing the
      // position back mid-gesture springs the node to wherever the last save put
      // it, and the drag the user is in the middle of is then thrown away. The
      // pointer owns the node until it lets go.
      if (
        syncPositions &&
        existing.isNode() &&
        next.position &&
        !(existing as CyNode).grabbed() &&
        !(dragActive && (existing as CyNode).selected())
      ) {
        const current = (existing as CyNode).position();
        if (
          Math.abs(current.x - next.position.x) > 0.5 ||
          Math.abs(current.y - next.position.y) > 0.5
        ) {
          (existing as CyNode).position(next.position);
        }
      }
    });
    stale.forEach((element) => element.remove());
    elements.forEach((element) => {
      if (!cy.getElementById(String(element.data.id)).length) {
        // Initialise display mappings before Cytoscape styles new elements.
        // Reconciliation leaves existing label data to the LOD effects below.
        const defaults =
          element.group === "edges"
            ? { label: "", srcPort: "", tgtPort: "", visible: 1 }
            : { labelOpacity: 1 };
        fresh.push({ ...element, data: { ...defaults, ...element.data } });
      }
    });
    if (fresh.length) cy.add(fresh);
  });
}
