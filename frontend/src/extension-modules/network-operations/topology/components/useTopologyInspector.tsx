import { useCallback, useEffect, useRef, useState } from "react";
import { type CanvasApi, type ElementPositionResult } from "./NetOpsCanvas";
import type { SelectedElement } from "./topologyDocument";

export type useTopologyInspectorPorts = {
  canvasApiRef: import("react").MutableRefObject<CanvasApi | null>;
};

export function useTopologyInspector({
  canvasApiRef,
}: useTopologyInspectorPorts) {
  const [selectedElement, setSelectedElement] = useState<SelectedElement>(null);
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const [popoverPlacement, setPopoverPlacement] = useState<
    "left" | "right" | "corner"
  >("right");
  const [popoverCoords, setPopoverCoords] = useState<{
    left?: number;
    right?: number;
    top?: number;
  }>({ right: 16, top: 16 });
  const [arrowY, setArrowY] = useState<number>(36);
  const [isDragged, setIsDragged] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const dragStartRef = useRef<{
    startX: number;
    startY: number;
    initialLeft: number;
    initialTop: number;
  } | null>(null);

  // Reset drag position when switching to a different element
  useEffect(() => {
    setIsDragged(false);
  }, [selectedElement]);

  const updatePopoverAnchor = useCallback(() => {
    if (!isInspectorOpen || isDragged) return;
    const viewportEl = viewportRef.current;
    if (!viewportEl) return;

    if (isPinned) {
      setPopoverPlacement("corner");
      setPopoverCoords({ right: 16, top: 16 });
      return;
    }

    const vw = viewportEl.clientWidth || 800;
    const vh = viewportEl.clientHeight || 600;
    const inspectorEl = inspectorRef.current;
    const bubbleWidth = Math.min(240, vw - 16);
    const bubbleHeight = inspectorEl?.offsetHeight || 440;
    const maxTop = Math.max(12, vh - bubbleHeight - 16);

    if (!selectedElement) {
      setPopoverPlacement("corner");
      setPopoverCoords({ right: 16, top: 16 });
      return;
    }

    const api = canvasApiRef.current;
    let pos: ElementPositionResult | null = null;
    if (api?.getElementPosition) {
      if (selectedElement.type === "node") {
        pos = api.getElementPosition(selectedElement.nodeId, "node");
      } else if (selectedElement.type === "link") {
        pos = api.getElementPosition(selectedElement.linkId, "link");
      } else if (selectedElement.type === "canvas_item") {
        pos = api.getElementPosition(selectedElement.itemId, "canvas_item");
      }
    }

    if (!pos) {
      setPopoverPlacement("corner");
      setPopoverCoords({ right: 16, top: 16 });
      return;
    }

    const targetBB = pos.bb || {
      x1: pos.x - 47,
      y1: pos.y - 38,
      x2: pos.x + 47,
      y2: pos.y + 38,
      w: 94,
      h: 76,
    };

    // A comfortable, non-overlapping margin between the node boundary and popover
    const margin = 20;

    const rightLeft = targetBB.x2 + margin;
    const canFitRight = rightLeft + bubbleWidth + 12 <= vw;

    const leftLeft = targetBB.x1 - margin - bubbleWidth;
    const canFitLeft = leftLeft >= 12;

    const top = Math.max(12, Math.min(pos.y - 70, maxTop));
    const arrowPos = Math.max(20, Math.min(pos.y - top, bubbleHeight - 24));

    const rightRect = {
      x1: rightLeft,
      y1: top,
      x2: rightLeft + bubbleWidth,
      y2: top + bubbleHeight,
    };
    const leftRect = {
      x1: leftLeft,
      y1: top,
      x2: leftLeft + bubbleWidth,
      y2: top + bubbleHeight,
    };

    const checkOverlap = (
      r1: { x1: number; y1: number; x2: number; y2: number },
      r2: { x1: number; y1: number; x2: number; y2: number },
    ) => {
      return !(
        r1.x2 <= r2.x1 ||
        r1.x1 >= r2.x2 ||
        r1.y2 <= r2.y1 ||
        r1.y1 >= r2.y2
      );
    };

    const neighbors = pos.neighbors || [];
    const otherNodes = pos.otherNodes || [];

    // Collision with connected neighbor devices
    const rightCollidesNeighbor = neighbors.some((n) =>
      checkOverlap(rightRect, n.bb),
    );
    const leftCollidesNeighbor = neighbors.some((n) =>
      checkOverlap(leftRect, n.bb),
    );

    // Collision with any other nodes
    const rightCollidesOther = otherNodes.some((n) =>
      checkOverlap(rightRect, n.bb),
    );
    const leftCollidesOther = otherNodes.some((n) =>
      checkOverlap(leftRect, n.bb),
    );

    let chosenSide: "right" | "left" | "corner" = "right";

    if (canFitRight && canFitLeft) {
      if (rightCollidesNeighbor && !leftCollidesNeighbor) {
        // Connected device is on the right -> place on the left to avoid occluding it!
        chosenSide = "left";
      } else if (leftCollidesNeighbor && !rightCollidesNeighbor) {
        // Connected device is on the left -> place on the right to avoid occluding it!
        chosenSide = "right";
      } else if (!rightCollidesNeighbor && !leftCollidesNeighbor) {
        // Neither collides with a connected neighbor. Check collisions with other nodes.
        if (rightCollidesOther && !leftCollidesOther) {
          chosenSide = "left";
        } else if (leftCollidesOther && !rightCollidesOther) {
          chosenSide = "right";
        } else {
          // Both sides are clear of node collisions. Check where connected links go.
          if (neighbors.length > 0) {
            const avgNeighborX =
              neighbors.reduce((sum, n) => sum + n.pos.x, 0) / neighbors.length;
            // If connected neighbors are primarily on the right, place on the left!
            chosenSide = avgNeighborX > pos.x ? "left" : "right";
          } else {
            // Default to right side if no neighbors
            chosenSide = "right";
          }
        }
      } else {
        // Both sides collide with connected neighbors!
        if (rightCollidesOther && !leftCollidesOther) {
          chosenSide = "left";
        } else if (leftCollidesOther && !rightCollidesOther) {
          chosenSide = "right";
        } else {
          // If crowded on both sides, fallback to top-right corner dock to avoid blocking canvas
          chosenSide = "corner";
        }
      }
    } else if (canFitRight) {
      if (rightCollidesNeighbor) {
        // Right side collides with connected device, and left side cannot fit.
        // Fallback to corner dock so the connected device is not hidden!
        chosenSide = "corner";
      } else {
        chosenSide = "right";
      }
    } else if (canFitLeft) {
      if (leftCollidesNeighbor) {
        chosenSide = "corner";
      } else {
        chosenSide = "left";
      }
    } else {
      chosenSide = "corner";
    }

    if (chosenSide === "right") {
      setPopoverPlacement("right");
      setPopoverCoords({ left: rightLeft, top });
      setArrowY(arrowPos);
    } else if (chosenSide === "left") {
      setPopoverPlacement("left");
      setPopoverCoords({ left: leftLeft, top });
      setArrowY(arrowPos);
    } else {
      // Corner dock: top-right corner of viewport with generous spacing
      setPopoverPlacement("corner");
      setPopoverCoords({ right: 16, top: 16 });
    }
  }, [isInspectorOpen, isDragged, isPinned, selectedElement]);

  const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.closest("button") ||
      target.closest("input") ||
      target.closest("select") ||
      target.closest("a") ||
      target.closest("textarea")
    ) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    const inspectorEl = inspectorRef.current;
    const viewportEl = viewportRef.current;
    if (!inspectorEl || !viewportEl) return;

    const viewportRect = viewportEl.getBoundingClientRect();
    const inspectorRect = inspectorEl.getBoundingClientRect();

    const initialLeft = inspectorRect.left - viewportRect.left;
    const initialTop = inspectorRect.top - viewportRect.top;

    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialLeft,
      initialTop,
    };
    setIsDragging(true);
    setIsDragged(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const onMouseMove = (e: MouseEvent) => {
      if (
        !dragStartRef.current ||
        !viewportRef.current ||
        !inspectorRef.current
      )
        return;
      const { startX, startY, initialLeft, initialTop } = dragStartRef.current;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const viewportEl = viewportRef.current;
      const inspectorEl = inspectorRef.current;
      const vw = viewportEl.clientWidth;
      const vh = viewportEl.clientHeight;
      const cardWidth = inspectorEl.offsetWidth;
      const cardHeight = inspectorEl.offsetHeight;

      const rawLeft = initialLeft + dx;
      const rawTop = initialTop + dy;

      const clampedLeft = Math.max(
        8,
        Math.min(rawLeft, Math.max(8, vw - cardWidth - 8)),
      );
      const clampedTop = Math.max(
        8,
        Math.min(rawTop, Math.max(8, vh - cardHeight - 8)),
      );

      setPopoverCoords({ left: clampedLeft, top: clampedTop });
    };

    const onMouseUp = () => {
      setIsDragging(false);
      dragStartRef.current = null;
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDragging]);

  useEffect(() => {
    if (isInspectorOpen && !isDragged) {
      const id = requestAnimationFrame(() => {
        updatePopoverAnchor();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [isInspectorOpen, isDragged, selectedElement, updatePopoverAnchor]);

  useEffect(() => {
    window.addEventListener("resize", updatePopoverAnchor);
    return () => window.removeEventListener("resize", updatePopoverAnchor);
  }, [updatePopoverAnchor]);

  const popoverStyle: React.CSSProperties = {
    ...(popoverCoords.left !== undefined
      ? { left: `${popoverCoords.left}px` }
      : {}),
    ...(popoverCoords.right !== undefined && popoverCoords.left === undefined
      ? { right: `${popoverCoords.right}px` }
      : {}),
    ...(popoverCoords.top !== undefined
      ? { top: `${popoverCoords.top}px` }
      : {}),
    ...(arrowY ? { ["--arrow-y" as any]: `${arrowY}px` } : {}),
  };
  return {
    setSelectedElement,
    setIsInspectorOpen,
    selectedElement,
    updatePopoverAnchor,
    isPinned,
    setIsPinned,
    setIsDragged,
    isInspectorOpen,
    viewportRef,
    inspectorRef,
    isDragged,
    popoverPlacement,
    isDragging,
    popoverStyle,
    handleHeaderMouseDown,
  };
}
