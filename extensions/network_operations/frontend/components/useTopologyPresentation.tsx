import { useCallback, useEffect, useRef, useState } from "react";
import { type CanvasApi } from "./NetOpsCanvas";

export type useTopologyPresentationPorts = {
  canvasApiRef: import("react").MutableRefObject<CanvasApi | null>;
};

export function useTopologyPresentation({
  canvasApiRef,
}: useTopologyPresentationPorts) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [whiteboardActive, setWhiteboardActive] = useState(false);
  const [compactMode, setCompactMode] = useState<boolean>(false);
  const studioContainerRef = useRef<HTMLDivElement | null>(null);

  const handleToggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      try {
        const elem = studioContainerRef.current || document.documentElement;
        if (elem.requestFullscreen) {
          void elem.requestFullscreen();
        }
      } catch {
        // fallback to CSS fullscreen
      }
      setIsFullscreen(true);
    } else {
      try {
        if (document.exitFullscreen) {
          void document.exitFullscreen();
        }
      } catch {
        // fallback
      }
      setIsFullscreen(false);
    }
    window.setTimeout(() => canvasApiRef.current?.fit(), 160);
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
      window.setTimeout(() => canvasApiRef.current?.fit(), 160);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        handleToggleFullscreen();
      } else if (
        e.key === "Escape" &&
        isFullscreen &&
        !document.fullscreenElement
      ) {
        setIsFullscreen(false);
        window.setTimeout(() => canvasApiRef.current?.fit(), 160);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [handleToggleFullscreen, isFullscreen]);

  const handleToggleWhiteboard = useCallback(() => {
    setWhiteboardActive((prev) => !prev);
  }, []);
  return {
    compactMode,
    studioContainerRef,
    isFullscreen,
    handleToggleFullscreen,
    handleToggleWhiteboard,
    setCompactMode,
    whiteboardActive,
    setWhiteboardActive,
  };
}
