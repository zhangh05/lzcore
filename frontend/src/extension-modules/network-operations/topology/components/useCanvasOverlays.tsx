import { useEffect } from "react";
import { renderMotionOverlay, renderWorldGrid } from "./canvasOverlayDrawing";
import type { AlignGuide, Cy, CyNode, Props } from "./canvasRendererTypes";

export type useCanvasOverlaysPorts = {
  alignGuides: AlignGuide[];
  cyRef: import("react").MutableRefObject<Cy | null>;
  gridCanvasRef: import("react").MutableRefObject<HTMLCanvasElement | null>;
  hostRef: import("react").MutableRefObject<HTMLDivElement | null>;
  overlayCanvasRef: import("react").MutableRefObject<HTMLCanvasElement | null>;
  props: Props;
  theme: string;
  viewport: { x: number; y: number; zoom: number };
};

export function useCanvasOverlays({
  alignGuides,
  cyRef,
  gridCanvasRef,
  hostRef,
  overlayCanvasRef,
  props,
  theme,
  viewport,
}: useCanvasOverlaysPorts) {
  useEffect(() => {
    if (gridCanvasRef.current) {
      renderWorldGrid(
        gridCanvasRef.current,
        viewport,
        theme === "dark",
        props.gridEnabled,
      );
    }
  }, [viewport, theme, props.gridEnabled]);

  // Window and container resize handler for world grid & cytoscape
  useEffect(() => {
    const handleResize = () => {
      if (cyRef.current) {
        cyRef.current.resize();
      }
      if (gridCanvasRef.current) {
        renderWorldGrid(
          gridCanvasRef.current,
          viewport,
          theme === "dark",
          props.gridEnabled,
        );
      }
    };
    window.addEventListener("resize", handleResize);

    const host = hostRef.current;
    let ro: ResizeObserver | null = null;
    if (host && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        handleResize();
      });
      ro.observe(host);
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      ro?.disconnect();
    };
  }, [viewport, theme, props.gridEnabled]);

  // Static evidence markers and alignment guides. No inferred status animation.
  useEffect(() => {
    if (!overlayCanvasRef.current) return;
    const topology = {
      ...props.topology,
      nodes: props.topology.nodes.map((node) => {
        const position = (
          cyRef.current?.getElementById(node.node_id) as CyNode | undefined
        )?.position();
        return position ? { ...node, ...position } : node;
      }),
    };
    renderMotionOverlay(
      overlayCanvasRef.current,
      viewport,
      topology,
      alignGuides,
      props.nodeObservationStatus || {},
      theme === "dark",
      Boolean(props.compactMode),
      props.dimmedNodeIds || [],
    );
  }, [
    viewport,
    props.topology,
    alignGuides,
    theme,
    props.nodeObservationStatus,
    props.compactMode,
    props.dimmedNodeIds,
  ]);
}
