import { useEffect } from "react";
import { type CanvasApi, type CanvasContextTarget } from "./NetOpsCanvas";
import type { SelectedElement, Topology } from "./topologyDocument";

export type useTopologyKeyboardPorts = {
  activeTopologyRef: import("react").MutableRefObject<Topology | null>;
  canvasApiRef: import("react").MutableRefObject<CanvasApi | null>;
  canvasSelectedElementIds: string[];
  deleteSelection: () => void;
  executeSave: (topo: Topology) => Promise<void>;
  handleCloneNode: (nodeId: string) => void;
  handleRedo: () => void;
  handleSetWorkspaceMode: (mode: "view" | "edit") => void;
  handleUndo: () => void;
  nudgeSelected: (dx: number, dy: number) => void;
  removeSelectedObjects: () => Promise<void>;
  selectedElement: SelectedElement;
  setArmedNodeType: import("react").Dispatch<
    import("react").SetStateAction<string | null>
  >;
  setCanvasMode: import("react").Dispatch<
    import("react").SetStateAction<"select" | "connect">
  >;
  setContextMenu: import("react").Dispatch<
    import("react").SetStateAction<CanvasContextTarget | null>
  >;
  setFocusMode: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setGridSnapEnabled: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setIsInspectorOpen: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setSelectedElement: import("react").Dispatch<
    import("react").SetStateAction<SelectedElement>
  >;
  setShowEditbar: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setShowInterfaces: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  setShowShortcutHelp: import("react").Dispatch<
    import("react").SetStateAction<boolean>
  >;
  workspaceMode: "view" | "edit";
};

export function useTopologyKeyboard({
  activeTopologyRef,
  canvasApiRef,
  canvasSelectedElementIds,
  deleteSelection,
  executeSave,
  handleCloneNode,
  handleRedo,
  handleSetWorkspaceMode,
  handleUndo,
  nudgeSelected,
  removeSelectedObjects,
  selectedElement,
  setArmedNodeType,
  setCanvasMode,
  setContextMenu,
  setFocusMode,
  setGridSnapEnabled,
  setIsInspectorOpen,
  setSelectedElement,
  setShowEditbar,
  setShowInterfaces,
  setShowShortcutHelp,
  workspaceMode,
}: useTopologyKeyboardPorts) {
  useEffect(() => {
    const selector = ".topology-studio details[data-toolbar-menu][open]";

    const onPointerDown = (event: PointerEvent | MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const openMenus = document.querySelectorAll<HTMLDetailsElement>(selector);
      if (!openMenus.length) return;

      openMenus.forEach((menu) => {
        // If clicking inside this menu, don't close on pointerdown so clicks on buttons can fire
        if (menu.contains(target)) return;
        menu.removeAttribute("open");
      });
    };

    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const openMenus = document.querySelectorAll<HTMLDetailsElement>(selector);
      if (!openMenus.length) return;

      openMenus.forEach((menu) => {
        const content = menu.querySelector("div");
        if (content && content.contains(target)) {
          if (
            target.closest("button") &&
            !target.closest(".view-remove") &&
            !menu.hasAttribute("data-keep-open")
          ) {
            window.setTimeout(() => menu.removeAttribute("open"), 0);
          }
        }
      });
    };

    const positionMenu = (menu: HTMLDetailsElement) => {
      const content = menu.querySelector<HTMLElement>(":scope > div");
      const area = menu.closest(".topology-canvas-area");
      if (!content || !area) return;
      menu.style.setProperty("--menu-offset", "0px");
      const rect = content.getBoundingClientRect(),
        bounds = area.getBoundingClientRect();
      const left = Math.max(8, bounds.left + 8),
        right = Math.min(window.innerWidth - 8, bounds.right - 8);
      const scale = content.offsetWidth ? rect.width / content.offsetWidth : 1;
      const offset = Math.max(
        left - rect.left,
        Math.min(0, right - rect.right),
      );
      menu.style.setProperty("--menu-offset", `${offset / scale}px`);
    };
    const positionOpenMenus = () =>
      document
        .querySelectorAll<HTMLDetailsElement>(selector)
        .forEach(positionMenu);
    const onToggle = (event: Event) => {
      const target = event.target as HTMLDetailsElement;
      if (!target || target.tagName !== "DETAILS" || !target.open) return;
      if (!target.matches?.(selector)) return;
      positionMenu(target);

      const openMenus = document.querySelectorAll<HTMLDetailsElement>(selector);
      openMenus.forEach((other) => {
        if (
          other !== target &&
          !other.contains(target) &&
          !target.contains(other)
        )
          other.removeAttribute("open");
      });
    };

    const onMenuEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const menu = document.querySelector<HTMLDetailsElement>(selector);
      if (!menu) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      menu.removeAttribute("open");
      menu.querySelector<HTMLElement>("summary")?.focus();
    };
    document.addEventListener("keydown", onMenuEscape, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("toggle", onToggle, true);
    window.addEventListener("resize", positionOpenMenus);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("toggle", onToggle, true);
      window.removeEventListener("resize", positionOpenMenus);
      document.removeEventListener("keydown", onMenuEscape, true);
    };
  }, []);

  /**
   * Keyboard shortcuts. Every diagram tool people already know (draw.io,
   * Figma, Visio) is keyboard driven, and the canvas is where an operator
   * spends their time, so the common gestures get single keys.
   */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // A modal owns keyboard input, including when its focused control is a
      // button. Otherwise Delete can replace a confirmation and arrows can
      // change the drawing behind the dialog.
      if (
        document.querySelector(
          '[role="dialog"][aria-modal="true"], dialog[open]',
        )
      )
        return;
      if (
        e.target instanceof HTMLElement &&
        e.target.closest("input, textarea, select, [contenteditable=true]")
      )
        return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if (meta && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handleRedo();
        return;
      }
      if (meta && e.key.toLowerCase() === "a") {
        e.preventDefault();
        canvasApiRef.current?.selectAll();
        return;
      }
      if (meta && e.key.toLowerCase() === "d") {
        e.preventDefault();
        const selectedNodeId =
          selectedElement?.type === "node"
            ? selectedElement.nodeId
            : canvasSelectedElementIds[0];
        if (selectedNodeId) handleCloneNode(selectedNodeId);
        return;
      }
      if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (activeTopologyRef.current)
          void executeSave(activeTopologyRef.current);
        return;
      }
      if (meta) return;
      switch (e.key) {
        case "h":
        case "H":
          e.preventDefault();
          handleSetWorkspaceMode("view");
          return;
        case "e":
        case "E":
          e.preventDefault();
          handleSetWorkspaceMode("edit");
          return;
        case "Escape":
          setContextMenu(null);
          setShowShortcutHelp(false);
          setFocusMode(false);
          setIsInspectorOpen(false);
          setSelectedElement(null);
          canvasApiRef.current?.clearSelection();
          // Escape cancels palette placement and cancels connect mode
          setArmedNodeType(null);
          setCanvasMode("select");
          document
            .querySelectorAll<HTMLDetailsElement>(
              ".topology-studio details[data-toolbar-menu][open]",
            )
            .forEach((d) => d.removeAttribute("open"));
          return;
        case "Delete":
        case "Backspace": {
          if (workspaceMode === "view") return;
          // Delete removes what is selected, whether that is one object or
          // several. It used to act only on the single inspector selection, so
          // pressing it with a marquee or Ctrl+A selection did nothing at all
          // while the batch panel happily removed the same set.
          e.preventDefault();
          if (canvasSelectedElementIds.length > 0) void removeSelectedObjects();
          else deleteSelection();
          return;
        }
        case "ArrowLeft":
        case "ArrowRight":
        case "ArrowUp":
        case "ArrowDown": {
          if (workspaceMode === "view" || !canvasSelectedElementIds.length)
            return;
          e.preventDefault();
          const step = e.shiftKey ? 8 : 1;
          if (e.key === "ArrowLeft") nudgeSelected(-step, 0);
          else if (e.key === "ArrowRight") nudgeSelected(step, 0);
          else if (e.key === "ArrowUp") nudgeSelected(0, -step);
          else nudgeSelected(0, step);
          return;
        }
        case "?":
          e.preventDefault();
          setShowShortcutHelp((value) => !value);
          return;
        default:
          break;
      }
      switch (e.key.toLowerCase()) {
        case "v":
          if (workspaceMode === "view") handleSetWorkspaceMode("edit");
          setCanvasMode("select");
          break;
        case "c":
          if (workspaceMode === "view") handleSetWorkspaceMode("edit");
          setCanvasMode("connect");
          break;
        case "t":
          if (workspaceMode === "view") break;
          e.preventDefault();
          setShowEditbar((value) => !value);
          break;
        case "g":
        case "G":
          if (e.shiftKey) {
            e.preventDefault();
            setGridSnapEnabled((value) => !value);
          }
          break;
        case "i":
          setShowInterfaces((value) => !value);
          break;
        case "f":
          if (e.shiftKey)
            canvasApiRef.current?.focusIds(canvasSelectedElementIds, 1.2);
          else canvasApiRef.current?.fit();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    handleUndo,
    handleRedo,
    executeSave,
    deleteSelection,
    removeSelectedObjects,
    nudgeSelected,
    canvasSelectedElementIds,
    handleCloneNode,
    selectedElement,
  ]);
}
