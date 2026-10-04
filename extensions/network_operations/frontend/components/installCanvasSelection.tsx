import { edgeUnderPointer, toHostPoint } from "./canvasHitTesting";
import type { CanvasContextTarget, Cy, Props } from "./canvasRendererTypes";

export type installCanvasSelectionPorts = {
  clickIntentRef: import("react").MutableRefObject<{
    ids: string[];
    additive: boolean;
  }>;
  connectingFromRef: import("react").MutableRefObject<string | null>;
  cy: Cy;
  hostRef: import("react").MutableRefObject<HTMLDivElement | null>;
  ignoreBoxSelectionTapRef: import("react").MutableRefObject<boolean>;
  propsRef: import("react").MutableRefObject<Props>;
};

export function installCanvasSelection({
  clickIntentRef,
  connectingFromRef,
  cy,
  hostRef,
  ignoreBoxSelectionTapRef,
  propsRef,
}: installCanvasSelectionPorts) {
  const nextSelectionFor = (id: string): string[] => {
    const { ids, additive } = clickIntentRef.current;
    if (!additive) return [id];
    return ids.includes(id)
      ? ids.filter((entry) => entry !== id)
      : [...ids, id];
  };
  const applySelection = (ids: string[]) => {
    cy.elements().unselect();
    ids.forEach((entry) => cy.getElementById(entry).select());
    propsRef.current.onSelectionChange(ids);
  };
  cy.on("tap", (event) => {
    const current = propsRef.current;
    if (current.interactionMode === "view") {
      if (event.target.isNode?.()) {
        const id = event.target.id?.() || "";
        if (id && !id.startsWith("group-") && !id.startsWith("canvas-"))
          current.onSelectNode(id);
        else current.onClearSelection();
      } else {
        current.onClearSelection();
      }
      return;
    }
    if (current.armedNodeType) {
      const id = event.target.isNode?.() ? event.target.id?.() || "" : "";
      if (!id || id.startsWith("canvas-") || id.startsWith("group-")) {
        const host = hostRef.current;
        const point =
          event.position ||
          (() => {
            const nativeEvent = event.originalEvent;
            if (!nativeEvent || !host) return null;
            const local = toHostPoint(
              host,
              nativeEvent.clientX,
              nativeEvent.clientY,
            );
            const pan = cy.pan();
            const zoom = cy.zoom();
            return { x: (local.x - pan.x) / zoom, y: (local.y - pan.y) / zoom };
          })();
        if (point) current.onPlaceNodeType(current.armedNodeType, point);
        return;
      }
    }
    if (event.target.isNode?.()) {
      const id = event.target.id?.() || "";
      if (!id) return;
      if (id.startsWith("group-")) return;
      current.onDisarmNodeType();
      if (id.startsWith("canvas-")) {
        if (current.mode !== "connect") {
          const next = nextSelectionFor(id);
          window.setTimeout(() => applySelection(next), 0);
          // A multi-selection is not about any one object, so it must not
          // pull the inspector onto whichever one happened to be clicked.
          if (!clickIntentRef.current.additive)
            current.onSelectCanvasItem(id.slice("canvas-".length));
        }
        return;
      }
      if (current.mode === "connect") {
        const source = connectingFromRef.current;
        if (!source) {
          connectingFromRef.current = id;
          event.target.addClass?.("node-connecting");
          return;
        }
        cy.getElementById(source).removeClass("node-connecting");
        connectingFromRef.current = null;
        if (source !== id) current.onConnect(source, id);
        return;
      }
      // Cytoscape must use additive selection for a marquee to retain all
      // enclosed objects.  Restore familiar single-click semantics here —
      // and let Ctrl/⌘/Shift grow or shrink the selection instead.
      const next = nextSelectionFor(id);
      const additive = clickIntentRef.current.additive;
      window.setTimeout(() => applySelection(next), 0);
      // Keep the single-object inspector honest when a toggle happens to
      // leave exactly one object selected. Above that the multi-selection
      // panel takes over and does not care what was clicked last.
      if (!additive) current.onSelectNode(id);
      else if (next.length === 1) current.onSelectNode(next[0]);
      else if (next.length === 0) current.onClearSelection();
      return;
    }
    if (event.target.isEdge?.()) {
      const id = event.target.id?.();
      if (id) {
        cy.elements().unselect();
        cy.getElementById(id).select();
        current.onSelectLink(id);
      }
      current.onDisarmNodeType();
      return;
    }
    // Fallback: If tap event was treated as canvas background but clicked on or near a link
    const host = hostRef.current;
    const native = event.originalEvent;
    if (host && native && native instanceof MouseEvent) {
      const nearEdge = edgeUnderPointer(cy, host, native);
      if (nearEdge) {
        const id = nearEdge.id?.();
        if (id) {
          cy.elements().unselect();
          cy.getElementById(id).select();
          current.onSelectLink(id);
          current.onDisarmNodeType();
          return;
        }
      }
    }
    connectingFromRef.current = null;
    // The release of our own marquee is not an intent to clear selection.
    if (ignoreBoxSelectionTapRef.current) return;
    // A picked palette type turns the next empty-sheet click into a
    // placement, the way eNSP and HCL behave after you choose a model.
    // Cytoscape reports the tap's own model position, which is what the
    // node should land on; the client-coordinate fallback exists only
    // because the field is not guaranteed on every event flavour.
    if (current.armedNodeType) {
      const point =
        event.position ||
        (() => {
          const nativeEvent = event.originalEvent;
          if (!nativeEvent || !host) return null;
          const local = toHostPoint(
            host,
            nativeEvent.clientX,
            nativeEvent.clientY,
          );
          const pan = cy.pan();
          const zoom = cy.zoom();
          return { x: (local.x - pan.x) / zoom, y: (local.y - pan.y) / zoom };
        })();
      if (point) current.onPlaceNodeType(current.armedNodeType, point);
      return;
    }
    cy.elements().unselect();
    current.onClearSelection();
  });
  cy.on("dbltap", (event) => {
    const current = propsRef.current;
    if (event.target.isNode?.()) {
      const id = event.target.id?.() || "";
      if (!id || id.startsWith("group-")) return;
      if (id.startsWith("canvas-")) {
        current.onSelectCanvasItem(id.slice("canvas-".length));
        current.onOpenInspector?.();
        return;
      }
      current.onSelectNode(id);
      current.onOpenInspector?.();
      return;
    }
    if (event.target.isEdge?.()) {
      const id = event.target.id?.();
      if (id) {
        current.onSelectLink(id);
        current.onOpenInspector?.();
      }
      return;
    }
  });
  cy.on("mouseover", "node, edge", () => {
    if (propsRef.current.mode === "select") {
      const container = cy.container?.();
      if (container) container.style.cursor = "pointer";
    }
  });
  cy.on("mouseout", "node, edge", () => {
    if (propsRef.current.mode === "select") {
      const container = cy.container?.();
      if (container) container.style.cursor = "default";
    }
  });
  cy.on("select unselect", "node", () => {
    propsRef.current.onSelectionChange(
      cy
        .$("node:selected")
        .map((node) => node.id())
        .filter((id) => !id.startsWith("group-")),
    );
  });
  cy.on("cxttap", (event) => {
    const native = event.originalEvent;
    if (native) {
      native.preventDefault?.();
      native.stopPropagation?.();
    }
    if (propsRef.current.interactionMode === "view") {
      return;
    }
    if (propsRef.current.armedNodeType) {
      propsRef.current.onDisarmNodeType();
      return;
    }
    if (connectingFromRef.current) {
      cy.getElementById(connectingFromRef.current).removeClass(
        "node-connecting",
      );
      connectingFromRef.current = null;
      return;
    }
    if (!native) return;
    const id = event.target?.id?.() || "";
    let kind: CanvasContextTarget["kind"] = "canvas";
    if (event.target?.isEdge?.()) kind = "link";
    else if (event.target?.isNode?.())
      kind = id.startsWith("canvas-") ? "canvas_item" : "node";
    propsRef.current.onContextMenu?.({
      x: native.clientX,
      y: native.clientY,
      kind,
      id,
    });
  });
}
