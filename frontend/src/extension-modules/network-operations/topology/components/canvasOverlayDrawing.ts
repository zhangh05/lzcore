/** canvasOverlayDrawing is a renderer port independent of React screen state. */
import type { AlignGuide } from "./canvasRendererTypes";
import type { Topology } from "./topologyDocument";
import { nodeStatusColors, type NodeRuntimeStatus } from "./topologyPalette";

export function renderWorldGrid(
  canvas: HTMLCanvasElement,
  viewport: { x: number; y: number; zoom: number },
  isDark: boolean,
  enabled: boolean,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w <= 0 || h <= 0) return;
  const targetW = Math.round(w * dpr);
  const targetH = Math.round(h * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!enabled) {
    ctx.restore();
    return;
  }

  const { x: panX, y: panY, zoom } = viewport;
  let step = 20;
  if (zoom < 0.42) step = 100;
  else if (zoom < 0.78) step = 40;
  else step = 20;

  const screenStep = step * zoom;
  if (screenStep < 7) {
    ctx.restore();
    return;
  }

  const startX = ((panX % screenStep) + screenStep) % screenStep;
  const startY = ((panY % screenStep) + screenStep) % screenStep;
  const lineColor = isDark
    ? "rgba(255, 255, 255, 0.055)"
    : "rgba(15, 23, 42, 0.055)";
  const majorColor = isDark
    ? "rgba(255, 255, 255, 0.13)"
    : "rgba(15, 23, 42, 0.12)";

  ctx.lineWidth = 1;
  // Vertical grid lines
  for (let x = startX; x <= w; x += screenStep) {
    const worldX = Math.round((x - panX) / zoom);
    const isMajor = Math.abs(worldX) % (step * 5) < 0.5;
    ctx.strokeStyle = isMajor ? majorColor : lineColor;
    ctx.beginPath();
    ctx.moveTo(Math.floor(x) + 0.5, 0);
    ctx.lineTo(Math.floor(x) + 0.5, h);
    ctx.stroke();
  }
  // Horizontal grid lines
  for (let y = startY; y <= h; y += screenStep) {
    const worldY = Math.round((y - panY) / zoom);
    const isMajor = Math.abs(worldY) % (step * 5) < 0.5;
    ctx.strokeStyle = isMajor ? majorColor : lineColor;
    ctx.beginPath();
    ctx.moveTo(0, Math.floor(y) + 0.5);
    ctx.lineTo(w, Math.floor(y) + 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

export function renderMotionOverlay(
  canvas: HTMLCanvasElement,
  viewport: { x: number; y: number; zoom: number },
  topology: Topology,
  alignGuides: AlignGuide[],
  observationStatus: Record<string, NodeRuntimeStatus | null>,
  dark: boolean,
  compact: boolean,
  dimmedIds: string[],
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w <= 0 || h <= 0) return;
  const targetW = Math.round(w * dpr);
  const targetH = Math.round(h * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const { x: panX, y: panY, zoom } = viewport;

  // Recent evidence is a separate corner marker, never the drawing border.
  const palette = nodeStatusColors(dark);
  const dimmed = new Set(dimmedIds);
  for (const node of topology.nodes) {
    const status = observationStatus[node.node_id];
    if (!status) continue;
    const cx = (node.x + (compact ? 26 : 38)) * zoom + panX;
    const cy = (node.y - (compact ? 26 : 30)) * zoom + panY;
    if (cx < -20 || cy < -20 || cx > w + 20 || cy > h + 20) continue;
    ctx.globalAlpha = dimmed.has(node.node_id) ? 0.16 : 1;
    const radius = Math.max(4, Math.min(8, 7 * zoom));
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = palette[status];
    ctx.fill();
    ctx.strokeStyle = dark ? "#181c1f" : "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = `600 ${radius * 1.5}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = dark ? "#111416" : "#ffffff";
    ctx.fillText(
      status === "ok" ? "✓" : status === "unknown" ? "?" : "!",
      cx,
      cy,
    );
  }

  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  // CAD alignment guides share the overlay without inheriting marker text alignment.
  if (alignGuides.length > 0) {
    ctx.save();
    for (const guide of alignGuides) {
      const gx1 = guide.x1 * zoom + panX;
      const gy1 = guide.y1 * zoom + panY;
      const gx2 = guide.x2 * zoom + panX;
      const gy2 = guide.y2 * zoom + panY;

      ctx.globalAlpha = guide.aligned === false ? 0.8 : 1;
      ctx.strokeStyle = dark ? "#e2ad4d" : "#925b08";
      ctx.lineWidth = 1.2;
      ctx.setLineDash(guide.aligned === false ? [6, 4] : []);
      ctx.beginPath();
      ctx.moveTo(gx1, gy1);
      ctx.lineTo(gx2, gy2);
      ctx.stroke();

      if (guide.aligned !== false) {
        ctx.setLineDash([]);
        ctx.lineWidth = 1.5;
        const crossSize = 4;
        ctx.beginPath();
        ctx.moveTo(gx1 - crossSize, gy1);
        ctx.lineTo(gx1 + crossSize, gy1);
        ctx.moveTo(gx1, gy1 - crossSize);
        ctx.lineTo(gx1, gy1 + crossSize);
        ctx.moveTo(gx2 - crossSize, gy2);
        ctx.lineTo(gx2 + crossSize, gy2);
        ctx.moveTo(gx2, gy2 - crossSize);
        ctx.lineTo(gx2, gy2 + crossSize);
        ctx.stroke();
      }

      const dist = Math.round(
        Math.hypot(guide.x2 - guide.x1, guide.y2 - guide.y1),
      );
      if (dist > 40) {
        const mx = (gx1 + gx2) / 2;
        const my = (gy1 + gy2) / 2;
        const tagText = guide.hint
          ? `${guide.hint} · ${guide.aligned === false ? "接近" : "已对齐"}`
          : `${dist}px`;
        ctx.font = "600 10px ui-monospace, SFMono-Regular, monospace";
        const tagW = ctx.measureText(tagText).width + 8;
        const tagH = 14;
        ctx.fillStyle = dark ? "#e2ad4d" : "#925b08";
        ctx.beginPath();
        if ((ctx as any).roundRect)
          (ctx as any).roundRect(mx - tagW / 2, my - tagH / 2, tagW, tagH, 3);
        else ctx.rect(mx - tagW / 2, my - tagH / 2, tagW, tagH);
        ctx.fill();
        ctx.fillStyle = dark ? "#1c1206" : "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(tagText, mx, my);
      }
    }
    ctx.restore();
  }

  ctx.restore();
}
