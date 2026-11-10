import { useEffect } from "react";
import type { Cy, Props } from "./canvasRendererTypes";

export type useCanvasPanningPorts = {
  cyRef: import("react").MutableRefObject<Cy | null>;
  hostRef: import("react").MutableRefObject<HTMLDivElement | null>;
  panStartRef: import("react").MutableRefObject<{
    clientX: number;
    clientY: number;
    panX: number;
    panY: number;
  } | null>;
  propsRef: import("react").MutableRefObject<Props>;
  setIsPanning: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setSpaceHeld: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setViewport: import("react").Dispatch<
    import("react").SetStateAction<{ x: number; y: number; zoom: number }>
  >;
  spaceHeld: boolean;
};

export function useCanvasPanning({
  cyRef,
  hostRef,
  panStartRef,
  propsRef,
  setIsPanning,
  setSpaceHeld,
  setViewport,
  spaceHeld,
}: useCanvasPanningPorts) {
  useEffect(() => {
    const isInput = (t: EventTarget | null) =>
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      (t instanceof HTMLElement && t.isContentEditable);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space" && !event.repeat && !isInput(event.target)) {
        event.preventDefault();
        setSpaceHeld(true);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        setSpaceHeld(false);
        panStartRef.current = null;
        setIsPanning(false);
      }
    };
    const release = () => {
      setSpaceHeld(false);
      panStartRef.current = null;
      setIsPanning(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", release);
    };
  }, []);

  // Middle-mouse drag (button === 1) or Space + left-drag pans the canvas smoothly
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const onMouseDown = (event: MouseEvent) => {
      const isMiddle = event.button === 1;
      const isSpaceDrag = event.button === 0 && spaceHeld;
      const isViewModeDrag =
        propsRef.current.interactionMode === "view" && event.button === 0;
      if (!isMiddle && !isSpaceDrag && !isViewModeDrag) return;
      if (!(event.target instanceof Node) || !host.contains(event.target))
        return;

      const cy = cyRef.current;
      if (!cy) return;

      event.preventDefault();
      event.stopPropagation();

      const pan = cy.pan();
      panStartRef.current = {
        clientX: event.clientX,
        clientY: event.clientY,
        panX: pan.x,
        panY: pan.y,
      };
      setIsPanning(true);
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!panStartRef.current) return;
      const cy = cyRef.current;
      if (!cy) return;

      event.preventDefault();
      const dx = event.clientX - panStartRef.current.clientX;
      const dy = event.clientY - panStartRef.current.clientY;
      cy.pan({
        x: panStartRef.current.panX + dx,
        y: panStartRef.current.panY + dy,
      });
      setViewport({ ...cy.pan(), zoom: cy.zoom() });
    };

    const onMouseUp = (event: MouseEvent) => {
      if (panStartRef.current) {
        event.preventDefault();
        panStartRef.current = null;
        setIsPanning(false);
      }
    };

    document.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mousemove", onMouseMove, { passive: false });
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [spaceHeld]);
}
