import { useEffect } from "react";
import { loadNetOpsCytoscape } from "./canvasRendererLoader";
import { canvasRendererStyle } from "./canvasRendererStyle";
import type { AlignGuide, Cy, Props } from "./canvasRendererTypes";
import { installCanvasDragging } from "./installCanvasDragging";
import { installCanvasPortGeometry } from "./installCanvasPortGeometry";
import { installCanvasSelection } from "./installCanvasSelection";

export type useCanvasRendererPorts = {
  clickIntentRef: import("react").MutableRefObject<{
    ids: string[];
    additive: boolean;
  }>;
  connectingFromRef: import("react").MutableRefObject<string | null>;
  cyRef: import("react").MutableRefObject<Cy | null>;
  grabAnchorRef: import("react").MutableRefObject<{
    id: string;
    x: number;
    y: number;
  } | null>;
  guideSignatureRef: import("react").MutableRefObject<string>;
  hostRef: import("react").MutableRefObject<HTMLDivElement | null>;
  ignoreBoxSelectionTapRef: import("react").MutableRefObject<boolean>;
  lockGroupInitialPositionsRef: import("react").MutableRefObject<
    Map<string, { x: number; y: number }>
  >;
  props: Props;
  propsRef: import("react").MutableRefObject<Props>;
  rendererReady: boolean;
  setAlignGuides: import("react").Dispatch<
    import("react").SetStateAction<AlignGuide[]>
  >;
  setRendererReady: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setViewport: import("react").Dispatch<
    import("react").SetStateAction<{ x: number; y: number; zoom: number }>
  >;
  snapResidualRef: import("react").MutableRefObject<{ x: number; y: number }>;
  snapTargetRef: import("react").MutableRefObject<{
    x: string | null;
    y: string | null;
  }>;
};

export function useCanvasRenderer({
  clickIntentRef,
  connectingFromRef,
  cyRef,
  grabAnchorRef,
  guideSignatureRef,
  hostRef,
  ignoreBoxSelectionTapRef,
  lockGroupInitialPositionsRef,
  props,
  propsRef,
  rendererReady,
  setAlignGuides,
  setRendererReady,
  setViewport,
  snapResidualRef,
  snapTargetRef,
}: useCanvasRendererPorts) {
  useEffect(() => {
    let disposed = false;
    const host = hostRef.current;
    const preventContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    host?.addEventListener("contextmenu", preventContextMenu, {
      capture: true,
    });
    void loadNetOpsCytoscape()
      .then(() => {
        if (disposed || !hostRef.current || !window.cytoscape) return;
        const origWarn = console.warn;
        console.warn = (...args: unknown[]) => {
          if (
            typeof args[0] === "string" &&
            args[0].includes("wheel sensitivity")
          )
            return;
          origWarn.apply(console, args);
        };
        let cy: Cy | undefined;
        try {
          cy = window.cytoscape({
            container: hostRef.current,
            layout: { name: "preset" },
            // The sheet itself is fixed. Editing changes object coordinates only.
            panningEnabled: true,
            // Cytoscape 3.28 gates wheel zoom behind userPanningEnabled as well
            // (see the wheel handler in cytoscape.min.js). Keeping panning on for
            // every mode is what makes the wheel work outside layout mode.
            userPanningEnabled: true,
            // Default 1 means one mouse notch (deltaY 100) zooms 10^(100/250)
            // = 2.5x. 0.25 puts a notch near 1.26x, which is the familiar feel.
            wheelSensitivity: 0.25,
            minZoom: 0.15,
            maxZoom: 4,
            boxSelectionEnabled: false,
            pixelRatio:
              typeof window !== "undefined"
                ? Math.min(window.devicePixelRatio || 1, 2)
                : 1,
            style: canvasRendererStyle({}),
          });
        } catch (err) {
          console.error("Failed to initialize Cytoscape", err);
          return;
        }
        if (!cy) return;
        cyRef.current = cy;
        // Prevent low-resolution texture caching for text and interface labels:
        // Cytoscape by default rasterizes labels into fixed power-of-two offscreen
        // textures and scales them up with drawImage(), causing blurry text on zoom.
        // Returning null from getElement forces Cytoscape to render vector font glyphs
        // directly via canvas 2D fillText() at the native screen pixel density.
        try {
          const r = (cy as any).renderer?.();
          if (r && r.data) {
            if (r.data.eleTxrCache) r.data.eleTxrCache.getElement = () => null;
            if (r.data.lyrTxrCache) r.data.lyrTxrCache.getLayers = () => null;
            if (r.data.lblTxrCache) r.data.lblTxrCache.getElement = () => null;
            if (r.data.slbTxrCache) r.data.slbTxrCache.getElement = () => null;
            if (r.data.tlbTxrCache) r.data.tlbTxrCache.getElement = () => null;
          }
        } catch {
          // Fallback safely if renderer internals vary
        }
        // Use renderer geometry, including the clipped node boundary and the
        // direction of each edge. A reverse-direction link still labels its own
        // source/target. Native labels remain available to image export/hit tests.
        // Render runs after bundle recalculation (add/remove/drag/layout); cache
        // geometry so pan, zoom and the follow-up style render do no extra work.
        installCanvasPortGeometry({ cy });
        setRendererReady(true);
        const syncViewport = () =>
          setViewport({ ...cy.pan(), zoom: cy.zoom() });
        cy.on("zoom pan", syncViewport);
        /**
         * What a click on `id` should leave selected.
         *
         * Ctrl/⌘ (and Shift) turn the click into a toggle: the object joins the
         * selection, or drops out of it if it was already in. Without a modifier
         * it stays a plain single selection, which is what `selectionType`
         * `"additive"` would otherwise override — and that has to stay on, because
         * it is what keeps everything a marquee encloses.
         *
         * The pre-click set comes from `clickIntentRef`; see its declaration for
         * why it cannot be read from `cy` here.
         */
        installCanvasSelection({
          clickIntentRef,
          connectingFromRef,
          cy,
          hostRef,
          ignoreBoxSelectionTapRef,
          propsRef,
        });
        // Smart guides. Aligning by eye is the slowest part of tidying a
        // diagram, so a dragged node snaps to the edges and centres of its
        // neighbours and shows why.
        installCanvasDragging({
          cy,
          grabAnchorRef,
          guideSignatureRef,
          host,
          lockGroupInitialPositionsRef,
          propsRef,
          setAlignGuides,
          setViewport,
          snapResidualRef,
          snapTargetRef,
        });
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      host?.removeEventListener("contextmenu", preventContextMenu, {
        capture: true,
      });
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, []);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const isViewMode = props.interactionMode === "view";
    const layoutEditing = !isViewMode && props.mode !== "connect";
    cy.panningEnabled(true);
    cy.userPanningEnabled(true);
    cy.boxSelectionEnabled(!isViewMode);
    cy.autounselectify?.(isViewMode);
    cy.autoungrabify(!layoutEditing);
    if (isViewMode) {
      cy.elements().unselect();
    }
    cy.selectionType("additive");
    cy.nodes().forEach((node) => {
      if (node.id().startsWith("group-")) return;
      if (layoutEditing) node.grabify();
      else node.ungrabify();
    });
  }, [rendererReady, props.mode, props.interactionMode]);
}
