import { useEffect, useRef } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const FIELD =
  "input:not([disabled]), select:not([disabled]), textarea:not([disabled])";

/**
 * Keyboard contract for the topology `<dialog open aria-modal>` sheets, matching
 * the shared PortalModal: focus moves in on open (first field, else first
 * control), Tab/Shift+Tab stay inside, Escape closes, and focus returns to
 * where it was. Presentation only; what "close" means stays with the caller.
 */
export function useTopologyDialogFocus<T extends HTMLElement>(
  onClose: () => void,
) {
  const ref = useRef<T>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    if (!dialog.contains(document.activeElement)) {
      (
        dialog.querySelector<HTMLElement>(FIELD) ||
        dialog.querySelector<HTMLElement>(FOCUSABLE) ||
        dialog
      ).focus({ preventScroll: true });
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !dialog.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previous && document.contains(previous))
        previous.focus({ preventScroll: true });
    };
  }, []);
  return ref;
}
