import { useEffect, useRef } from "react";

/** Narrow layouts (≤760px) show the topology library and agent panel as sheets over the canvas. */
export const TOPOLOGY_NARROW_QUERY = "(max-width: 760px)";

/**
 * While a sheet is open at narrow widths: focus moves into it (its close button
 * when present), Escape inside it closes it, and focus returns to whatever had
 * it before (the toolbar trigger) when it closes. Wider layouts keep their
 * existing docked behaviour untouched. Presentation only.
 */
export function useTopologyNarrowSheet(
  open: boolean,
  getSheet: () => HTMLElement | null | undefined,
  onClose: () => void,
) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const getRef = useRef(getSheet);
  getRef.current = getSheet;
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    if (!window.matchMedia?.(TOPOLOGY_NARROW_QUERY).matches) return;
    const sheet = getRef.current();
    if (!sheet) return;
    const previous = document.activeElement as HTMLElement | null;
    (sheet.querySelector<HTMLElement>("[data-sheet-close]") || sheet).focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeRef.current();
    };
    sheet.addEventListener("keydown", onKey);
    return () => {
      sheet.removeEventListener("keydown", onKey);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [open]);
}
