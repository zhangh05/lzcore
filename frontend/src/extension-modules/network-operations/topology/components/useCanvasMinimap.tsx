import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { toHostPoint } from "./canvasHitTesting";
import type { Cy, Props } from "./canvasRendererTypes";
import { drawingContrastUnderlay } from "./topologyDrawingAppearance";
import { topologyLinkColor } from "./topologyPalette";

export type useCanvasMinimapPorts = {
  cyRef: import("react").MutableRefObject<Cy | null>;
  hostRef: import("react").MutableRefObject<HTMLDivElement | null>;
  miniOpen: boolean;
  miniRef: import("react").MutableRefObject<HTMLCanvasElement | null>;
  props: Props;
  rendererReady: boolean;
  setViewport: import("react").Dispatch<
    import("react").SetStateAction<{ x: number; y: number; zoom: number }>
  >;
  theme: string;
  viewport: { x: number; y: number; zoom: number };
};

export function useCanvasMinimap({
  cyRef,
  hostRef,
  miniOpen,
  miniRef,
  props,
  rendererReady,
  setViewport,
  theme,
  viewport,
}: useCanvasMinimapPorts) {
  const miniTransformRef = useRef<{
    minX: number;
    minY: number;
    scale: number;
    offX: number;
    offY: number;
  } | null>(null);
  useEffect(() => {
    const canvas = miniRef.current;
    const cy = cyRef.current;
    const host = hostRef.current;
    if (!canvas || !cy || !host || !miniOpen) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = 178;
    const height = 118;
    const dpr =
      typeof window !== "undefined"
        ? Math.max(window.devicePixelRatio || 1, 2)
        : 2;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Canvas background
    const isDark = theme === "dark";
    ctx.fillStyle = isDark ? "#0f172a" : "#f8fafc";
    ctx.fillRect(0, 0, width, height);

    // Subtle grid dots in minimap
    ctx.fillStyle = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)";
    for (let gx = 8; gx < width; gx += 14) {
      for (let gy = 8; gy < height; gy += 14) {
        ctx.fillRect(gx, gy, 1, 1);
      }
    }

    const points: Array<{ x: number; y: number }> = [];
    props.topology.nodes.forEach((node) =>
      points.push(
        { x: node.x - 47, y: node.y - 38 },
        { x: node.x + 47, y: node.y + 38 },
      ),
    );
    (props.topology.canvas_items || []).forEach((item) =>
      points.push(
        { x: item.x - item.width / 2, y: item.y - item.height / 2 },
        { x: item.x + item.width / 2, y: item.y + item.height / 2 },
      ),
    );
    if (!points.length) return;
    const minX = Math.min(...points.map((p) => p.x)) - 40;
    const maxX = Math.max(...points.map((p) => p.x)) + 40;
    const minY = Math.min(...points.map((p) => p.y)) - 40;
    const maxY = Math.max(...points.map((p) => p.y)) + 40;
    const scale = Math.min(width / (maxX - minX), height / (maxY - minY));
    const offX = (width - (maxX - minX) * scale) / 2;
    const offY = (height - (maxY - minY) * scale) / 2;
    miniTransformRef.current = { minX, minY, scale, offX, offY };
    const tx = (x: number) => offX + (x - minX) * scale;
    const ty = (y: number) => offY + (y - minY) * scale;

    // Draw canvas items/zones faintly
    (props.topology.canvas_items || []).forEach((item) => {
      ctx.fillStyle = isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)";
      ctx.strokeStyle = isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.08)";
      ctx.lineWidth = 0.8;
      const x = tx(item.x - item.width / 2);
      const y = ty(item.y - item.height / 2);
      const w = item.width * scale;
      const h = item.height * scale;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    });

    // Draw links
    ctx.lineWidth = 1;
    const byId = new Map(
      props.topology.nodes.map((node) => [node.node_id, node]),
    );
    props.topology.links.forEach((link) => {
      const source = byId.get(link.source_node_id);
      const target = byId.get(link.target_node_id);
      if (!source || !target) return;
      const color = topologyLinkColor(link);
      const contrast = drawingContrastUnderlay(color, isDark);
      ctx.beginPath();
      ctx.moveTo(tx(source.x), ty(source.y));
      ctx.lineTo(tx(target.x), ty(target.y));
      if (contrast.opacity) {
        ctx.strokeStyle = contrast.color;
        ctx.lineWidth = 3;
        ctx.globalAlpha = contrast.opacity;
        ctx.stroke();
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 1;
      ctx.stroke();
    });

    // Draw nodes
    props.topology.nodes.forEach((node) => {
      const nx = tx(node.x);
      const ny = ty(node.y);
      ctx.fillStyle = isDark ? "#2dd4bf" : "#0f766e";
      ctx.beginPath();
      if ((ctx as any).roundRect) {
        (ctx as any).roundRect(nx - 4, ny - 3, 8, 6, 2);
      } else {
        ctx.rect(nx - 4, ny - 3, 8, 6);
      }
      ctx.fill();
    });

    // Draw active viewport rectangle
    const pan = cy.pan();
    const zoom = cy.zoom();
    const viewX = tx(-pan.x / zoom);
    const viewY = ty(-pan.y / zoom);
    const viewW = (host.clientWidth / zoom) * scale;
    const viewH = (host.clientHeight / zoom) * scale;

    ctx.fillStyle = isDark
      ? "rgba(45, 212, 191, 0.16)"
      : "rgba(15, 118, 110, 0.12)";
    ctx.beginPath();
    if ((ctx as any).roundRect) {
      (ctx as any).roundRect(viewX, viewY, viewW, viewH, 3);
    } else {
      ctx.rect(viewX, viewY, viewW, viewH);
    }
    ctx.fill();

    ctx.strokeStyle = isDark ? "#2dd4bf" : "#0f766e";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if ((ctx as any).roundRect) {
      (ctx as any).roundRect(viewX, viewY, viewW, viewH, 3);
    } else {
      ctx.rect(viewX, viewY, viewW, viewH);
    }
    ctx.stroke();
  }, [rendererReady, props.topology, viewport, miniOpen, theme]);

  const handleMinimapCanvasDown = (
    event: ReactMouseEvent<HTMLCanvasElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const canvas = miniRef.current;
    const cy = cyRef.current;
    const host = hostRef.current;
    const transform = miniTransformRef.current;
    if (!canvas || !cy || !host || !transform) return;

    const panToPoint = (clientX: number, clientY: number) => {
      const local = toHostPoint(canvas, clientX, clientY);
      const modelX =
        (local.x - transform.offX) / transform.scale + transform.minX;
      const modelY =
        (local.y - transform.offY) / transform.scale + transform.minY;
      const zoom = cy.zoom();
      cy.pan({
        x: host.clientWidth / 2 - modelX * zoom,
        y: host.clientHeight / 2 - modelY * zoom,
      });
      setViewport({ ...cy.pan(), zoom });
    };

    panToPoint(event.clientX, event.clientY);

    const onMove = (e: MouseEvent) => {
      panToPoint(e.clientX, e.clientY);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  return { handleMinimapCanvasDown };
}
