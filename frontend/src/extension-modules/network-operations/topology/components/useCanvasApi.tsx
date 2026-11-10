import { useEffect } from "react";
import type {
  Cy,
  CyEdge,
  CyNode,
  ElementBoundingBox,
  ElementPositionResult,
  Props,
} from "./canvasRendererTypes";

export type useCanvasApiPorts = {
  connectingFromRef: import("react").MutableRefObject<string | null>;
  cyRef: import("react").MutableRefObject<Cy | null>;
  hostRef: import("react").MutableRefObject<HTMLDivElement | null>;
  propsRef: import("react").MutableRefObject<Props>;
  rendererReady: boolean;
  setViewport: import("react").Dispatch<
    import("react").SetStateAction<{ x: number; y: number; zoom: number }>
  >;
  viewport: { x: number; y: number; zoom: number };
};

export function useCanvasApi({
  connectingFromRef,
  cyRef,
  hostRef,
  propsRef,
  rendererReady,
  setViewport,
  viewport,
}: useCanvasApiPorts) {
  useEffect(() => {
    const cy = cyRef.current;
    if (!rendererReady || !cy) {
      propsRef.current.onReady?.(null);
      return;
    }
    (window as unknown as { __netops_cy?: Cy | null }).__netops_cy = cy;
    propsRef.current.onReady?.({
      exportPNG: (options) => {
        try {
          return cy.png({ full: true, scale: 2, bg: "#ffffff", ...options });
        } catch {
          return "";
        }
      },
      exportSVG: (options) => {
        try {
          return typeof (cy as any).svg === "function"
            ? (cy as any).svg({ full: true, ...options })
            : "";
        } catch {
          return "";
        }
      },
      fit: () => {
        cy.fit(undefined, 48);
        if (cy.zoom() > 1.0) {
          cy.zoom(1.0);
          cy.center();
        }
        setViewport({ ...cy.pan(), zoom: cy.zoom() });
      },
      resize: () => {
        cy.resize();
        setViewport({ ...cy.pan(), zoom: cy.zoom() });
      },
      zoomBy: (delta) => {
        const zoom = Math.min(4, Math.max(0.15, cy.zoom() + delta));
        cy.zoom(zoom);
        setViewport({ ...cy.pan(), zoom });
      },
      focusIds: (ids, zoom) => {
        if (!ids.length) return;
        const collection = cy.$(ids.map((id) => `[id = "${id}"]`).join(","));
        if (!collection.length) return;
        // Locating an object must also select it. Centring the viewport alone
        // left the inspector showing a node that the canvas did not consider
        // selected, so every selection-dependent action (nudge, batch edit,
        // delete) silently did nothing after a search jump.
        const selectable = collection.filter(
          (element) => !element.id().startsWith("group-"),
        );
        cy.elements().unselect();
        selectable.forEach((element) => element.select());
        propsRef.current.onSelectionChange(
          selectable.map((element) => element.id()),
        );
        // Selecting an object usually opens the inspector, which resizes the
        // container. Centring against a stale size lands the node off screen,
        // so measure again first and zoom about the rendered centre.
        cy.resize();
        const finish = () => setViewport({ ...cy.pan(), zoom: cy.zoom() });
        if (!zoom) {
          cy.animate(
            { fit: { eles: collection, padding: 90 } },
            { duration: 220 },
          );
          window.setTimeout(finish, 280);
          return;
        }
        cy.animate({ center: { eles: collection } }, { duration: 200 });
        window.setTimeout(() => {
          cy.resize();
          const host = hostRef.current;
          cy.zoom({
            level: zoom,
            renderedPosition: {
              x: (host?.clientWidth || 0) / 2,
              y: (host?.clientHeight || 0) / 2,
            },
          });
          finish();
        }, 230);
      },
      selectAll: () => {
        const ids = cy
          .$("node")
          .map((node) => node.id())
          .filter((id) => !id.startsWith("group-"));
        cy.elements().unselect();
        ids.forEach((id) => cy.getElementById(id).select());
        propsRef.current.onSelectionChange(ids);
        return ids;
      },
      selectElements: (ids: string[]) => {
        cy.elements().unselect();
        if (!ids.length) {
          propsRef.current.onSelectionChange([]);
          propsRef.current.onClearSelection();
          return;
        }
        const selector = ids.map((id) => `[id = "${id}"]`).join(",");
        const collection = cy.$(selector);
        const selectable = collection.filter(
          (element) => !element.id().startsWith("group-"),
        );
        selectable.forEach((element) => element.select());
        const selectedIds = selectable.map((element) => element.id());
        propsRef.current.onSelectionChange(selectedIds);
      },
      clearSelection: () => {
        cy.elements().unselect();
        propsRef.current.onSelectionChange([]);
        propsRef.current.onClearSelection();
      },
      getBodies: (ids) =>
        ids.flatMap((id) => {
          const node = cy.getElementById(id) as CyNode;
          return node.length
            ? [
                {
                  id,
                  ...node.position(),
                  halfW: node.width() / 2,
                  halfH: node.height() / 2,
                },
              ]
            : [];
        }),
      getViewport: () => ({ ...cy.pan(), zoom: cy.zoom() }),
      setViewport: (view) => {
        cy.zoom(view.zoom);
        cy.pan({ x: view.x, y: view.y });
        setViewport({ ...cy.pan(), zoom: cy.zoom() });
      },
      startConnectFrom: (nodeId: string) => {
        const targetNode = cy.getElementById(nodeId);
        if (targetNode && targetNode.length) {
          connectingFromRef.current = nodeId;
          targetNode.addClass("node-connecting");
        }
      },
      getElementPosition: (
        id: string,
        kind: "node" | "link" | "canvas_item",
      ): ElementPositionResult | null => {
        if (!cy) return null;
        if (kind === "node") {
          const node = cy.getElementById(id);
          if (!node || !node.length) return null;
          const rp = node.renderedPosition ? node.renderedPosition() : null;
          if (!rp) return null;
          const rawBB = node.renderedBoundingBox
            ? node.renderedBoundingBox()
            : null;
          const bb: ElementBoundingBox = rawBB
            ? {
                x1: rawBB.x1,
                y1: rawBB.y1,
                x2: rawBB.x2,
                y2: rawBB.y2,
                w: rawBB.w,
                h: rawBB.h,
              }
            : {
                x1: rp.x - 47,
                y1: rp.y - 38,
                x2: rp.x + 47,
                y2: rp.y + 38,
                w: 94,
                h: 76,
              };
          const neighborCollection = node.neighborhood
            ? node.neighborhood("node")
            : null;
          const neighbors = (
            neighborCollection?.map
              ? neighborCollection.map((n: CyNode) => {
                  const nRp = n.renderedPosition?.() || { x: 0, y: 0 };
                  const nRawBB = n.renderedBoundingBox?.();
                  const nBB: ElementBoundingBox = nRawBB
                    ? {
                        x1: nRawBB.x1,
                        y1: nRawBB.y1,
                        x2: nRawBB.x2,
                        y2: nRawBB.y2,
                        w: nRawBB.w,
                        h: nRawBB.h,
                      }
                    : {
                        x1: nRp.x - 47,
                        y1: nRp.y - 38,
                        x2: nRp.x + 47,
                        y2: nRp.y + 38,
                        w: 94,
                        h: 76,
                      };
                  return { id: n.id(), pos: nRp, bb: nBB };
                })
              : []
          ) as Array<{
            id: string;
            pos: { x: number; y: number };
            bb: ElementBoundingBox;
          }>;
          const otherNodes = cy
            .nodes()
            .filter(
              (n: CyNode) => n.id() !== id && !n.id().startsWith("group-"),
            )
            .map((n: CyNode) => {
              const oRp = n.renderedPosition?.() || { x: 0, y: 0 };
              const oRawBB = n.renderedBoundingBox?.();
              const oBB: ElementBoundingBox = oRawBB
                ? {
                    x1: oRawBB.x1,
                    y1: oRawBB.y1,
                    x2: oRawBB.x2,
                    y2: oRawBB.y2,
                    w: oRawBB.w,
                    h: oRawBB.h,
                  }
                : {
                    x1: oRp.x - 47,
                    y1: oRp.y - 38,
                    x2: oRp.x + 47,
                    y2: oRp.y + 38,
                    w: 94,
                    h: 76,
                  };
              return { id: n.id(), pos: oRp, bb: oBB };
            });
          return { x: rp.x, y: rp.y, bb, neighbors, otherNodes };
        }
        if (kind === "link") {
          const edge = cy.getElementById(id) as CyEdge;
          if (!edge || !edge.length) return null;
          let mid: { x: number; y: number } | null = null;
          if (edge.renderedMidpoint) {
            mid = edge.renderedMidpoint();
          }
          if (!mid) {
            const s = edge.source ? edge.source().renderedPosition?.() : null;
            const t = edge.target ? edge.target().renderedPosition?.() : null;
            if (s && t) mid = { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 };
          }
          if (!mid) return null;
          const rawBB = edge.renderedBoundingBox
            ? edge.renderedBoundingBox()
            : null;
          const bb: ElementBoundingBox = rawBB
            ? {
                x1: rawBB.x1,
                y1: rawBB.y1,
                x2: rawBB.x2,
                y2: rawBB.y2,
                w: rawBB.w,
                h: rawBB.h,
              }
            : {
                x1: mid.x - 20,
                y1: mid.y - 20,
                x2: mid.x + 20,
                y2: mid.y + 20,
                w: 40,
                h: 40,
              };
          return { x: mid.x, y: mid.y, bb };
        }
        if (kind === "canvas_item") {
          const item = cy.getElementById(`canvas-${id}`);
          if (!item || !item.length) return null;
          const rp = item.renderedPosition ? item.renderedPosition() : null;
          if (!rp) return null;
          const rawBB = item.renderedBoundingBox
            ? item.renderedBoundingBox()
            : null;
          const bb: ElementBoundingBox = rawBB
            ? {
                x1: rawBB.x1,
                y1: rawBB.y1,
                x2: rawBB.x2,
                y2: rawBB.y2,
                w: rawBB.w,
                h: rawBB.h,
              }
            : {
                x1: rp.x - 50,
                y1: rp.y - 30,
                x2: rp.x + 50,
                y2: rp.y + 30,
                w: 100,
                h: 60,
              };
          return { x: rp.x, y: rp.y, bb };
        }
        return null;
      },
    });
    return () => {
      propsRef.current.onReady?.(null);
      (window as unknown as { __netops_cy?: Cy | null }).__netops_cy = null;
    };
  }, [rendererReady]);

  // Sync viewport changes out to parent for popover bubble positioning
  useEffect(() => {
    propsRef.current.onViewportChange?.(viewport);
  }, [viewport]);
}
