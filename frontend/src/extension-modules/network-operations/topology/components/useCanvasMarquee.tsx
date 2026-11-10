import { useEffect } from "react";
import { elementUnderPointer, toHostPoint } from "./canvasHitTesting";
import type { Cy, Props } from "./canvasRendererTypes";

export type useCanvasMarqueePorts = {
  cyRef: import("react").MutableRefObject<Cy | null>;
  hostRef: import("react").MutableRefObject<HTMLDivElement | null>;
  ignoreBoxSelectionTapRef: import("react").MutableRefObject<boolean>;
  marqueeDrag: boolean;
  marqueeStartRef: import("react").MutableRefObject<{
    x: number;
    y: number;
  } | null>;
  props: Props;
  setMarquee: import("react").Dispatch<
    import("react").SetStateAction<{
      x: number;
      y: number;
      width: number;
      height: number;
    } | null>
  >;
  setMarqueeDrag: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  spaceHeld: boolean;
};

export function useCanvasMarquee({
  cyRef,
  hostRef,
  ignoreBoxSelectionTapRef,
  marqueeDrag,
  marqueeStartRef,
  props,
  setMarquee,
  setMarqueeDrag,
  spaceHeld,
}: useCanvasMarqueePorts) {
  const clientPoint = (event: { clientX: number; clientY: number }) => {
    const host = hostRef.current;
    if (!host) return null;
    // Layout pixels, because the marquee box is a CSS offset inside the host.
    return toHostPoint(host, event.clientX, event.clientY);
  };
  const modelPoint = (point: { x: number; y: number }) => {
    const cy = cyRef.current;
    if (!cy) return null;
    const pan = cy.pan();
    const zoom = cy.zoom();
    return { x: (point.x - pan.x) / zoom, y: (point.y - pan.y) / zoom };
  };
  const applyMarqueeSelection = (
    start: { x: number; y: number },
    end: { x: number; y: number },
  ) => {
    const first = modelPoint(start);
    const last = modelPoint(end);
    const cy = cyRef.current;
    if (!first || !last || !cy) return;
    const left = Math.min(first.x, last.x);
    const right = Math.max(first.x, last.x);
    const top = Math.min(first.y, last.y);
    const bottom = Math.max(first.y, last.y);
    const ids = [
      ...props.topology.nodes
        .filter(
          (node) =>
            node.x >= left &&
            node.x <= right &&
            node.y >= top &&
            node.y <= bottom,
        )
        .map((node) => node.node_id),
      ...(props.topology.canvas_items || [])
        .filter(
          (item) =>
            item.x >= left &&
            item.x <= right &&
            item.y >= top &&
            item.y <= bottom,
        )
        .map((item) => `canvas-${item.item_id}`),
    ];
    ignoreBoxSelectionTapRef.current = true;
    cy.elements().unselect();
    ids.forEach((id) => cy.getElementById(id).select());
    props.onSelectionChange(ids);
    window.setTimeout(() => {
      ignoreBoxSelectionTapRef.current = false;
    }, 0);
  };
  // Direct marquee selection on empty canvas left-drag (eNSP style).
  const isViewMode = props.interactionMode === "view";
  const marqueeArmed =
    !isViewMode &&
    props.mode === "select" &&
    !props.armedNodeType &&
    !spaceHeld;
  useEffect(() => {
    if (!marqueeArmed) return;
    const onDown = (event: MouseEvent) => {
      if (event.button !== 0 || spaceHeld) return;
      const host = hostRef.current;
      const cy = cyRef.current;
      if (!host || !cy) return;
      if (!(event.target instanceof Node) || !host.contains(event.target))
        return;
      // A press on a device or link belongs to Cytoscape: it selects, toggles or drags.
      if (elementUnderPointer(cy, host, event)) return;
      event.stopPropagation();
      event.preventDefault();
      const point = clientPoint(event);
      if (!point) return;
      marqueeStartRef.current = point;
      setMarqueeDrag(true);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [marqueeArmed, spaceHeld]);

  // The drag is tracked on window so that releasing the button over a floating
  // control (zoom cluster, minimap) still finishes the selection instead of
  // stranding the rectangle on screen.
  useEffect(() => {
    if (!marqueeDrag) return;
    const onMove = (event: MouseEvent) => {
      const start = marqueeStartRef.current;
      const point = clientPoint(event);
      if (!start || !point) return;
      const width = Math.abs(point.x - start.x);
      const height = Math.abs(point.y - start.y);
      if (width < 5 && height < 5) return;
      setMarquee({
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width,
        height,
      });
    };
    const onUp = (event: MouseEvent) => {
      const start = marqueeStartRef.current;
      const point = clientPoint(event);
      marqueeStartRef.current = null;
      setMarqueeDrag(false);
      setMarquee(null);
      if (!start || !point) return;
      if (Math.abs(point.x - start.x) < 5 && Math.abs(point.y - start.y) < 5) {
        cyRef.current?.elements().unselect();
        props.onSelectionChange([]);
        props.onClearSelection();
        return;
      }
      applyMarqueeSelection(start, point);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [marqueeDrag]);
  return { isViewMode, marqueeArmed };
}
