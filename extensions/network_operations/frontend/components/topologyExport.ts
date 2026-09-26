import type { Topology, TopologyNode } from "./TopologyWorkspace";

export interface WhiteboardStrokeExport {
  id: string;
  tool: "pen" | "highlighter" | "arrow" | "rect";
  color: string;
  size: number;
  points: Array<{ x: number; y: number }>;
}

export interface WhiteboardNoteExport {
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
}

export interface ExportWhiteboardData {
  strokes: WhiteboardStrokeExport[];
  notes: WhiteboardNoteExport[];
}

export function dataUriToBlob(dataUri: string): Blob {
  const parts = dataUri.split(",");
  const mime = parts[0].match(/:(.*?);/)?.[1] || "image/png";
  const binary = atob(parts[1]);
  const array = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    array[i] = binary.charCodeAt(i);
  }
  return new Blob([array], { type: mime });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after 60s so browser download manager has completed writing to disk
  window.setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }, 60_000);
}

/**
 * 桌面环境（pywebview）下弹出原生"另存为"对话框保存文件；
 * 浏览器环境降级为 downloadBlob 触发浏览器下载。
 *
 * @returns 保存成功时返回保存路径字符串；用户取消或浏览器下载时返回 null
 */
export async function nativeSaveBlob(
  blob: Blob,
  filename: string,
  mime: string
): Promise<string | null> {
  // 检测是否运行在 pywebview 桌面容器内
  const api = (window as unknown as Record<string, unknown>)["pywebview"] as
    | { api?: { save_file?: (f: string, d: string, m: string) => Promise<{ ok: boolean; path?: string; error?: string }> } }
    | undefined;

  if (api?.api?.save_file) {
    // 桌面模式：将 Blob 转为 base64，调用 Python 原生保存对话框
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
      reader.onerror = () => reject(new Error("blob_read_error"));
      reader.readAsDataURL(blob);
    });
    const result = await api.api.save_file(filename, base64, mime);
    if (result.ok && result.path) {
      return result.path;
    }
    // 用户取消或失败，不触发浏览器下载
    return null;
  }

  // 浏览器模式降级：普通 <a> 下载
  downloadBlob(blob, filename);
  return null;
}

function escapeXml(unsafe: string): string {
  return (unsafe || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function sanitizeColor(color?: string | null, fallback = "#3b82f6"): string {
  const val = (color || "").trim();
  if (!val) return fallback;
  if (/^#(?:[0-9a-fA-F]{3,8})$/.test(val)) return val;
  if (/^rgba?\([0-9\s,\.%]+\)$/.test(val)) return val;
  if (/^[a-zA-Z]{1,24}$/.test(val)) return val;
  return fallback;
}

export async function svgToPngDataUrl(svgString: string, scale = 2): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(svgString, "image/svg+xml");
      const svgEl = doc.querySelector("svg");
      if (!svgEl) {
        return reject(new Error("invalid_svg_document"));
      }

      const viewBox = svgEl.getAttribute("viewBox");
      let width = 1200;
      let height = 800;

      if (viewBox) {
        const parts = viewBox.trim().split(/\s+/).map(Number);
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
          width = parts[2];
          height = parts[3];
        }
      } else {
        const wAttr = parseFloat(svgEl.getAttribute("width") || "1200");
        const hAttr = parseFloat(svgEl.getAttribute("height") || "800");
        if (wAttr > 0) width = wAttr;
        if (hAttr > 0) height = hAttr;
      }

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return reject(new Error("canvas_context_failed"));
      }

      const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
          const dataUrl = canvas.toDataURL("image/png");
          resolve(dataUrl);
        } catch (err) {
          URL.revokeObjectURL(url);
          reject(err);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("svg_rasterize_failed"));
      };
      img.src = url;
    } catch (err) {
      reject(err);
    }
  });
}

export async function svgToPngBlob(svgString: string, scale = 2): Promise<Blob> {
  const dataUrl = await svgToPngDataUrl(svgString, scale);
  return dataUriToBlob(dataUrl);
}

export function exportTopologyToSvg(
  topology: Topology,
  options: {
    whiteboardData?: ExportWhiteboardData | null;
    showInterfaces?: boolean;
    compactMode?: boolean;
  } = {}
): string {
  const nodes = topology.nodes || [];
  const links = topology.links || [];
  const canvasItems = topology.canvas_items || [];
  const groups = topology.groups || [];
  const showInterfaces = options.showInterfaces !== false;
  const compact = Boolean(options.compactMode);

  const nodeW = compact ? 56 : 76;
  const nodeH = compact ? 44 : 60;

  // Calculate bounding box across all visual objects
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };

  nodes.forEach((n) => {
    bounds.minX = Math.min(bounds.minX, n.x - nodeW / 2 - 40);
    bounds.maxX = Math.max(bounds.maxX, n.x + nodeW / 2 + 40);
    bounds.minY = Math.min(bounds.minY, n.y - nodeH / 2 - 20);
    bounds.maxY = Math.max(bounds.maxY, n.y + nodeH / 2 + 50); // room for label + IP
  });

  canvasItems.forEach((item) => {
    const halfW = (item.width || 200) / 2;
    const halfH = (item.height || 100) / 2;
    bounds.minX = Math.min(bounds.minX, item.x - halfW);
    bounds.maxX = Math.max(bounds.maxX, item.x + halfW);
    bounds.minY = Math.min(bounds.minY, item.y - halfH);
    bounds.maxY = Math.max(bounds.maxY, item.y + halfH);
  });

  groups.forEach((g) => {
    bounds.minX = Math.min(bounds.minX, g.x);
    bounds.maxX = Math.max(bounds.maxX, g.x + g.width);
    bounds.minY = Math.min(bounds.minY, g.y);
    bounds.maxY = Math.max(bounds.maxY, g.y + g.height);
  });

  if (!Number.isFinite(bounds.minX)) {
    bounds.minX = 0;
    bounds.minY = 0;
    bounds.maxX = 1200;
    bounds.maxY = 800;
  }

  const padding = 60;
  const vx = Math.floor(bounds.minX - padding);
  const vy = Math.floor(bounds.minY - padding);
  const vw = Math.ceil(bounds.maxX - bounds.minX + padding * 2);
  const vh = Math.ceil(bounds.maxY - bounds.minY + padding * 2);

  const nodeMap = new Map<string, TopologyNode>(nodes.map((n) => [n.node_id, n]));

  const svgParts: string[] = [];
  svgParts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  svgParts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" width="${vw}" height="${vh}" style="background-color: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">`
  );

  // Defs for arrowheads and markers
  svgParts.push(`  <defs>
    <marker id="arrow-start" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <rect x="2" y="2" width="6" height="6" fill="#147a55"/>
    </marker>
    <marker id="arrow-end" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <rect x="2" y="2" width="6" height="6" fill="#147a55"/>
    </marker>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.08"/>
    </filter>
  </defs>`);

  // Background
  svgParts.push(`  <rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="#ffffff"/>`);

  // 1. Groups & Canvas Items (Zones) in background layer
  canvasItems.forEach((item) => {
    const isText = item.kind === "text";
    const x = item.x - item.width / 2;
    const y = item.y - item.height / 2;
    const w = item.width;
    const h = item.height;
    const style = item.style || {};
    const fill = isText ? "none" : sanitizeColor(style.fill, "#dff5f0");
    const border = isText ? "#94a3b8" : sanitizeColor(style.border, "#58a99b");
    const strokeDash = isText ? "stroke-dasharray=\"4,3\"" : "";
    const borderWidth = isText ? 1.5 : Math.max(1, Math.min(20, Number((style as any).borderWidth) || 2));
    const textColor = isText ? "#0f172a" : sanitizeColor(style.color, "#0f5149");

    if (item.kind === "ellipse") {
      svgParts.push(
        `  <ellipse cx="${item.x}" cy="${item.y}" rx="${w / 2}" ry="${h / 2}" fill="${fill}" fill-opacity="0.35" stroke="${border}" stroke-width="${borderWidth}"/>`
      );
    } else {
      svgParts.push(
        `  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}" fill-opacity="${isText ? 0 : 0.35}" stroke="${border}" stroke-width="${borderWidth}" ${strokeDash}/>`
      );
    }

    if (item.text) {
      const fontSize = isText ? 13 : 13;
      const textY = isText ? item.y + 4 : y + 22;
      svgParts.push(
        `  <text x="${isText ? x + 12 : item.x}" y="${textY}" fill="${textColor}" font-size="${fontSize}" font-weight="600" text-anchor="${isText ? "start" : "middle"}">${escapeXml(item.text)}</text>`
      );
    }
  });

  // 2. Links
  links.forEach((link) => {
    const s = nodeMap.get(link.source_node_id);
    const t = nodeMap.get(link.target_node_id);
    if (!s || !t) return;

    const strokeColor = link.status === "down" ? "#bd3040" : link.status === "up" ? "#147a55" : "#6c7c7e";
    const strokeWidth = link.style?.width || (link.status === "down" ? 3 : 2.5);
    const strokeDash = link.status === "down" ? "stroke-dasharray=\"2,4\"" : link.kind === "logical" ? "stroke-dasharray=\"6,4\"" : "";

    svgParts.push(
      `  <line x1="${s.x}" y1="${s.y}" x2="${t.x}" y2="${t.y}" stroke="${strokeColor}" stroke-width="${strokeWidth}" stroke-linecap="round" ${strokeDash}/>`
    );

    // Link label in middle
    const midX = (s.x + t.x) / 2;
    const midY = (s.y + t.y) / 2;
    const label = link.label || link.metadata?.speed || link.metadata?.vlan;
    if (label) {
      const labelW = Math.max(48, label.length * 8 + 14);
      svgParts.push(
        `  <rect x="${midX - labelW / 2}" y="${midY - 11}" width="${labelW}" height="18" rx="4" fill="#ffffff" stroke="#cbd5e1" stroke-width="1" fill-opacity="0.95"/>`
      );
      svgParts.push(
        `  <text x="${midX}" y="${midY + 2}" font-size="10" font-family="ui-monospace, monospace" font-weight="600" fill="#0f172a" text-anchor="middle">${escapeXml(label)}</text>`
      );
    }

    // Port labels near endpoints
    if (showInterfaces) {
      if (link.source_interface) {
        const pX = s.x + (t.x - s.x) * 0.22;
        const pY = s.y + (t.y - s.y) * 0.22;
        const pW = link.source_interface.length * 6.5 + 8;
        svgParts.push(
          `  <rect x="${pX - pW / 2}" y="${pY - 9}" width="${pW}" height="16" rx="3" fill="#ffffff" fill-opacity="0.92" stroke="#e2e8f0" stroke-width="0.8"/>`
        );
        svgParts.push(
          `  <text x="${pX}" y="${pY + 2.5}" font-size="9" font-family="ui-monospace, monospace" font-weight="600" fill="#334155" text-anchor="middle">${escapeXml(link.source_interface)}</text>`
        );
      }
      if (link.target_interface) {
        const pX = s.x + (t.x - s.x) * 0.78;
        const pY = s.y + (t.y - s.y) * 0.78;
        const pW = link.target_interface.length * 6.5 + 8;
        svgParts.push(
          `  <rect x="${pX - pW / 2}" y="${pY - 9}" width="${pW}" height="16" rx="3" fill="#ffffff" fill-opacity="0.92" stroke="#e2e8f0" stroke-width="0.8"/>`
        );
        svgParts.push(
          `  <text x="${pX}" y="${pY + 2.5}" font-size="9" font-family="ui-monospace, monospace" font-weight="600" fill="#334155" text-anchor="middle">${escapeXml(link.target_interface)}</text>`
        );
      }
    }
  });

  // 3. Nodes
  nodes.forEach((node) => {
    const x = node.x - nodeW / 2;
    const y = node.y - nodeH / 2;
    const name = node.display_name || node.node_id;

    // Node body
    svgParts.push(
      `  <rect x="${x}" y="${y}" width="${nodeW}" height="${nodeH}" rx="8" fill="#f8fafc" stroke="#cbd5e1" stroke-width="2" filter="url(#shadow)"/>`
    );

    // Inner icon badge
    const iconW = Math.round(nodeW * 0.58);
    const iconH = Math.round(nodeH * 0.58);
    const iconX = node.x - iconW / 2;
    const iconY = node.y - iconH / 2;
    svgParts.push(
      `  <rect x="${iconX}" y="${iconY}" width="${iconW}" height="${iconH}" rx="5" fill="#1262aa"/>`
    );
    // Device symbol label inside badge
    const badgeText = (node.device_type || "SW").slice(0, 3).toUpperCase();
    svgParts.push(
      `  <text x="${node.x}" y="${node.y + 4}" fill="#ffffff" font-size="10" font-weight="700" text-anchor="middle">${escapeXml(badgeText)}</text>`
    );

    // Node name label below node
    svgParts.push(
      `  <text x="${node.x}" y="${y + nodeH + 16}" fill="#0f172a" font-size="${compact ? 11 : 12}" font-weight="600" text-anchor="middle">${escapeXml(name)}</text>`
    );

    // Structured Network IP Address below node name!
    if (node.ip) {
      svgParts.push(
        `  <text x="${node.x}" y="${y + nodeH + 29}" fill="#64748b" font-size="10" font-family="ui-monospace, monospace" text-anchor="middle">${escapeXml(node.ip)}</text>`
      );
    }
  });

  // 4. Whiteboard Annotations (if present)
  if (options.whiteboardData) {
    const { strokes, notes } = options.whiteboardData;
    strokes.forEach((stroke) => {
      if (!stroke.points || stroke.points.length < 1) return;
      const pts = stroke.points;
      const opacity = stroke.tool === "highlighter" ? 0.35 : 1.0;
      const strokeWidth = stroke.tool === "highlighter" ? stroke.size * 2.8 : stroke.size;

      const safeStrokeColor = sanitizeColor(stroke.color, "#3b82f6");
      if (stroke.tool === "pen" || stroke.tool === "highlighter") {
        if (pts.length === 1) {
          svgParts.push(
            `  <circle cx="${pts[0].x}" cy="${pts[0].y}" r="${strokeWidth / 2}" fill="${safeStrokeColor}" opacity="${opacity}"/>`
          );
        } else {
          const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
          svgParts.push(
            `  <path d="${d}" fill="none" stroke="${safeStrokeColor}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"/>`
          );
        }
      } else if (stroke.tool === "rect" && pts.length >= 2) {
        const start = pts[0];
        const end = pts[pts.length - 1];
        const rx = Math.min(start.x, end.x);
        const ry = Math.min(start.y, end.y);
        const rw = Math.abs(end.x - start.x);
        const rh = Math.abs(end.y - start.y);
        svgParts.push(
          `  <rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="none" stroke="${safeStrokeColor}" stroke-width="${strokeWidth}"/>`
        );
      } else if (stroke.tool === "arrow" && pts.length >= 2) {
        const start = pts[0];
        const end = pts[pts.length - 1];
        svgParts.push(
          `  <line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" stroke="${safeStrokeColor}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`
        );
      }
    });

    notes.forEach((note) => {
      const safeNoteColor = sanitizeColor(note.color, "#fef08a");
      svgParts.push(
        `  <g transform="translate(${note.x}, ${note.y})">
          <rect width="180" height="74" rx="6" fill="${safeNoteColor}" fill-opacity="0.16" stroke="${safeNoteColor}" stroke-width="2"/>
          <text x="10" y="24" font-size="12" fill="#1e293b" font-weight="500">${escapeXml(note.text)}</text>
        </g>`
      );
    });
  }

  svgParts.push(`</svg>`);
  return svgParts.join("\n");
}
