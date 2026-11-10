import { useEffect } from "react";
import { toHostPoint } from "./canvasHitTesting";
import type { AlignGuide, Cy, Props } from "./canvasRendererTypes";

export type useCanvasConnectionPorts = {
  connectStartRef: import("react").MutableRefObject<string | null>;
  cyRef: import("react").MutableRefObject<Cy | null>;
  hostRef: import("react").MutableRefObject<HTMLDivElement | null>;
  props: Props;
  propsRef: import("react").MutableRefObject<Props>;
  setLinkPreview: import("react").Dispatch<
    import("react").SetStateAction<AlignGuide | null>
  >;
};

export function useCanvasConnection({
  connectStartRef,
  cyRef,
  hostRef,
  props,
  propsRef,
  setLinkPreview,
}: useCanvasConnectionPorts) {
  useEffect(() => {
    if (props.mode !== "connect") return;
    const nodeAtClient = (clientX: number, clientY: number) => {
      const cy = cyRef.current;
      const host = hostRef.current;
      if (!cy || !host) return null;
      const local = toHostPoint(host, clientX, clientY);
      const pan = cy.pan();
      const zoom = cy.zoom();
      const modelX = (local.x - pan.x) / zoom;
      const modelY = (local.y - pan.y) / zoom;
      return (
        propsRef.current.topology.nodes.find(
          (node) =>
            Math.abs(node.x - modelX) <= 47 && Math.abs(node.y - modelY) <= 38,
        ) || null
      );
    };
    const pointInHost = (clientX: number, clientY: number) => {
      const host = hostRef.current;
      if (!host) return null;
      // Layout pixels, because these are used as CSS offsets inside the host.
      return toHostPoint(host, clientX, clientY);
    };
    const onDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const node = nodeAtClient(event.clientX, event.clientY);
      if (!node) return;
      const point = pointInHost(event.clientX, event.clientY);
      if (!point) return;
      connectStartRef.current = node.node_id;
      setLinkPreview({ x1: point.x, y1: point.y, x2: point.x, y2: point.y });
    };
    const onMove = (event: MouseEvent) => {
      if (!connectStartRef.current) return;
      const point = pointInHost(event.clientX, event.clientY);
      if (!point) return;
      setLinkPreview((current) =>
        current ? { ...current, x2: point.x, y2: point.y } : current,
      );
    };
    const onUp = (event: MouseEvent) => {
      const source = connectStartRef.current;
      connectStartRef.current = null;
      setLinkPreview(null);
      if (!source) return;
      const target = nodeAtClient(event.clientX, event.clientY);
      if (target && target.node_id !== source)
        propsRef.current.onConnect(source, target.node_id);
    };
    // Capture phase: Cytoscape owns the bubble-phase handlers on this element
    // and stops propagation of the gestures it recognises.
    const host = hostRef.current;
    host?.addEventListener("mousedown", onDown, true);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    return () => {
      host?.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
    };
  }, [props.mode]);
}
