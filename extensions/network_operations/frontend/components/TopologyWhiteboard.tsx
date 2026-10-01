import { activeUsername } from "../../../../frontend/src/utils/userScope";
import { apiRequest } from "../../../../frontend/src/api/client";
import { desktopDirty } from "../../../../frontend/src/desktop/bridge";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  IconPencil,
  IconHighlighter,
  IconArrowUpRight,
  IconBox,
  IconNote,
  IconUndo,
  IconTrash,
  IconDownload,
  IconClose,
} from "../../../../frontend/src/components/Icon";
import { confirm } from "../../../../frontend/src/components/ConfirmDialog";
import { nativeSaveBlob } from "./topologyExport";

export type WhiteboardTool = "pen" | "highlighter" | "arrow" | "rect" | "note";

export interface StrokePoint {
  x: number;
  y: number;
}

export interface WhiteboardStroke {
  id: string;
  tool: "pen" | "highlighter" | "arrow" | "rect";
  color: string;
  size: number;
  points: StrokePoint[];
}

export interface WhiteboardNote {
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
}

export interface TopologyWhiteboardProps {
  active: boolean;
  onClose: () => void;
  onExportBackground?: () => string;
  topologyName?: string;
  topologyId?: string;
  workspaceId?: string;
}

const COLORS = [
  { id: "#ef4444", label: "红色", hint: "风险/故障/警示" },
  { id: "#f97316", label: "橙色", hint: "关注/优化" },
  { id: "#eab308", label: "黄色", hint: "高亮/待办" },
  { id: "#10b981", label: "绿色", hint: "基准/推荐/达标" },
  { id: "#3b82f6", label: "蓝色", hint: "重点/核心链路" },
];

const SIZES = [
  { id: 3, label: "细" },
  { id: 6, label: "中" },
  { id: 10, label: "粗" },
];

export function TopologyWhiteboard({
  active,
  onClose,
  onExportBackground,
  topologyName,
  topologyId,
  workspaceId,
}: TopologyWhiteboardProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [tool, setTool] = useState<WhiteboardTool>("pen");
  const [color, setColor] = useState<string>("#ef4444");
  const [size, setSize] = useState<number>(6);

  const [strokes, setStrokes] = useState<WhiteboardStroke[]>([]);
  const [notes, setNotes] = useState<WhiteboardNote[]>([]);
  const [currentStroke, setCurrentStroke] = useState<WhiteboardStroke | null>(null);

  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [draggingNoteId, setDraggingNoteId] = useState<string | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const [exportError, setExportError] = useState("");
  const [persistenceError, setPersistenceError] = useState("");
  const [loadedKey, setLoadedKey] = useState("");
  const ownerRef = useRef(activeUsername());
  const versionRef = useRef(0);
  const savedRef = useRef("");
  const pendingRef = useRef(0);
  const [retry, setRetry] = useState(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const key = workspaceId && topologyId ? `${workspaceId}:${topologyId}` : "";
  const storageKey = topologyId ? `lzcore_whiteboard_${topologyId}` : "";
  useEffect(() => {
    if (!active || loadedKey === key) return;
    let alive = true;
    setLoadedKey(""); setPersistenceError(""); setStrokes([]); setNotes([]);
    if (!workspaceId || !topologyId) return;
    const url = `/extensions/network.operations/topologies/${encodeURIComponent(topologyId)}/annotations`;
    void apiRequest<{annotations: {version: number; strokes: WhiteboardStroke[]; notes: WhiteboardNote[]}}>({url, params: {workspace_id: workspaceId}}).then(async res => {
      if (!res.annotations || !alive) throw new Error("批注加载失败，请重试");
      let value = res.annotations;
      // Legacy origin cache is migrated only into an empty, server-confirmed diagram.
      const legacy = localStorage.getItem(storageKey);
      if (legacy && value.version === 0) {
        const raw = JSON.parse(legacy);
        const migrated = await apiRequest<{annotations: typeof value}>({method: "PUT", url, data: {workspace_id: workspaceId, version: 0, strokes: raw.strokes || [], notes: raw.notes || []}});
        if (!migrated.annotations) throw new Error("旧批注迁移失败，原缓存仍保留");
        value = migrated.annotations;
        localStorage.removeItem(storageKey);
      }
      if (!alive) return;
      versionRef.current = value.version;
      savedRef.current = JSON.stringify({strokes: value.strokes, notes: value.notes});
      setStrokes(value.strokes); setNotes(value.notes); setLoadedKey(key);
    }).catch(e => { if (alive) setPersistenceError(String(e.message || "批注加载失败")); });
    return () => { alive = false; };
  }, [active, workspaceId, topologyId, key, storageKey]);
  useEffect(() => {
    if (!key || loadedKey !== key || !workspaceId || !topologyId) return;
    const content = JSON.stringify({strokes, notes});
    if (content === savedRef.current) return;
    desktopDirty(`annotations:${key}`, true);
    // Queue saves immediately: changing page must not cancel a pending save.
    const url = `/extensions/network.operations/topologies/${encodeURIComponent(topologyId)}/annotations`;
    pendingRef.current += 1;
    queueRef.current = queueRef.current.then(async () => {
      if (activeUsername() !== ownerRef.current) throw new Error("用户已切换，旧批注未继续提交");
      const response = await apiRequest<{annotations: {version: number}}>({method: "PUT", url, data: {workspace_id: workspaceId, version: versionRef.current, strokes, notes}});
      if (!response.annotations) throw new Error("批注保存失败或版本冲突，请保留页面并重试");
      versionRef.current = response.annotations.version;
      savedRef.current = content;
      pendingRef.current -= 1;
      if (!pendingRef.current) desktopDirty(`annotations:${key}`, false);
      setPersistenceError("");
    }).catch(e => { pendingRef.current -= 1; setPersistenceError(String(e.message)); });
  }, [strokes, notes, loadedKey, key, workspaceId, topologyId, retry]);

  // Draw arrow helper
  const drawArrow = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      fromX: number,
      fromY: number,
      toX: number,
      toY: number,
      strokeColor: string,
      strokeWidth: number
    ) => {
      const headlen = Math.max(12, strokeWidth * 2.5);
      const angle = Math.atan2(toY - fromY, toX - fromX);

      ctx.save();
      ctx.strokeStyle = strokeColor;
      ctx.fillStyle = strokeColor;
      ctx.lineWidth = strokeWidth;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // Line
      ctx.beginPath();
      ctx.moveTo(fromX, fromY);
      ctx.lineTo(toX, toY);
      ctx.stroke();

      // Arrowhead
      ctx.beginPath();
      ctx.moveTo(toX, toY);
      ctx.lineTo(
        toX - headlen * Math.cos(angle - Math.PI / 6),
        toY - headlen * Math.sin(angle - Math.PI / 6)
      );
      ctx.lineTo(
        toX - headlen * Math.cos(angle + Math.PI / 6),
        toY - headlen * Math.sin(angle + Math.PI / 6)
      );
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    },
    []
  );

  // Render all strokes onto the canvas
  const renderStrokes = useCallback(
    (ctx: CanvasRenderingContext2D, strokeList: WhiteboardStroke[]) => {
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

      for (const stroke of strokeList) {
        if (!stroke.points.length) continue;
        ctx.save();

        if (stroke.tool === "highlighter") {
          ctx.globalAlpha = 0.35;
          ctx.strokeStyle = stroke.color;
          ctx.lineWidth = stroke.size * 2.8;
          ctx.lineCap = "square";
          ctx.lineJoin = "miter";
        } else {
          ctx.globalAlpha = 1.0;
          ctx.strokeStyle = stroke.color;
          ctx.lineWidth = stroke.size;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
        }

        if (stroke.tool === "pen" || stroke.tool === "highlighter") {
          const pts = stroke.points;
          if (pts.length === 1) {
            ctx.beginPath();
            ctx.arc(pts[0].x, pts[0].y, Math.max(1.5, stroke.size / 2), 0, Math.PI * 2);
            ctx.fillStyle = stroke.color;
            ctx.fill();
          } else {
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) {
              ctx.lineTo(pts[i].x, pts[i].y);
            }
            ctx.stroke();
          }
        } else if (stroke.tool === "arrow" && stroke.points.length >= 2) {
          const start = stroke.points[0];
          const end = stroke.points[stroke.points.length - 1];
          drawArrow(ctx, start.x, start.y, end.x, end.y, stroke.color, stroke.size);
        } else if (stroke.tool === "rect" && stroke.points.length >= 2) {
          const start = stroke.points[0];
          const end = stroke.points[stroke.points.length - 1];
          const x = Math.min(start.x, end.x);
          const y = Math.min(start.y, end.y);
          const w = Math.abs(end.x - start.x);
          const h = Math.abs(end.y - start.y);

          ctx.strokeRect(x, y, w, h);
        }

        ctx.restore();
      }
    },
    [drawArrow]
  );

  // Synchronize canvas size with device pixel ratio
  const syncCanvasSize = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.scale(dpr, dpr);
      const listToRender = currentStroke ? [...strokes, currentStroke] : strokes;
      renderStrokes(ctx, listToRender);
    }
  }, [currentStroke, renderStrokes, strokes]);

  useEffect(() => {
    if (!active) return;
    syncCanvasSize();
    window.addEventListener("resize", syncCanvasSize);
    return () => window.removeEventListener("resize", syncCanvasSize);
  }, [active, syncCanvasSize]);

  // Redraw when strokes change
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    const listToRender = currentStroke ? [...strokes, currentStroke] : strokes;
    renderStrokes(ctx, listToRender);
    ctx.restore();
  }, [active, currentStroke, renderStrokes, strokes]);

  // Pointer drawing handlers
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!active || tool === "note") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const newStroke: WhiteboardStroke = {
      id: `stroke_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      tool: tool as "pen" | "highlighter" | "arrow" | "rect",
      color,
      size,
      points: [{ x, y }],
    };

    setCurrentStroke(newStroke);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!currentStroke) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (currentStroke.tool === "pen" || currentStroke.tool === "highlighter") {
      setCurrentStroke((prev) =>
        prev ? { ...prev, points: [...prev.points, { x, y }] } : null
      );
    } else {
      // arrow or rect: replace 2nd point
      setCurrentStroke((prev) =>
        prev
          ? {
              ...prev,
              points: [prev.points[0], { x, y }],
            }
          : null
      );
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!currentStroke) return;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    if (currentStroke.points.length > 0) {
      setStrokes((prev) => [...prev, currentStroke]);
    }
    setCurrentStroke(null);
  };

  // Add a sticky note
  const handleCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (tool !== "note") return;
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const newNote: WhiteboardNote = {
      id: `note_${Date.now()}`,
      x: Math.max(10, Math.min(rect.width - 180, x - 80)),
      y: Math.max(10, Math.min(rect.height - 100, y - 40)),
      text: "点击输入批注说明...",
      color,
    };

    setNotes((prev) => [...prev, newNote]);
    setEditingNoteId(newNote.id);
  };

  // Undo stroke or note
  const handleUndo = () => {
    if (strokes.length > 0) {
      setStrokes((prev) => prev.slice(0, -1));
    } else if (notes.length > 0) {
      setNotes((prev) => prev.slice(0, -1));
    }
  };

  // Clear all
  const handleClear = async () => {
    const ok = await confirm({
      title: "清空画板批注",
      body: "确认清空当前拓扑的所有白板批注与便签吗？此操作无法撤销。",
      confirmLabel: "清空",
      cancelLabel: "取消",
      destructive: true,
    });
    if (!ok) return;

    setStrokes([]);
    setNotes([]);
    setCurrentStroke(null);
    try {
      localStorage.removeItem(storageKey);
    } catch (e) {
      // ignore
    }
  };

  // Export composite image
  const handleExport = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const bgDataUrl = onExportBackground ? onExportBackground() : null;

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = canvas.width;
    exportCanvas.height = canvas.height;
    const ctx = exportCanvas.getContext("2d");
    if (!ctx) return;

    const download = () => {
      // Draw notes onto exportCanvas
      for (const note of notes) {
        ctx.save();
        ctx.fillStyle = note.color + "22";
        ctx.strokeStyle = note.color;
        ctx.lineWidth = 2;
        const dpr = window.devicePixelRatio || 1;
        const noteX = note.x * dpr;
        const noteY = note.y * dpr;
        const noteW = 180 * dpr;
        const noteH = 80 * dpr;

        ctx.beginPath();
        ctx.roundRect(noteX, noteY, noteW, noteH, 6 * dpr);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "#1e293b";
        ctx.font = `${13 * dpr}px sans-serif`;
        ctx.fillText(note.text, noteX + 10 * dpr, noteY + 24 * dpr, noteW - 20 * dpr);
        ctx.restore();
      }

      const name = (topologyName || "网络拓扑").replace(/[\\/:*?"<>|\s]+/g, "_");
      exportCanvas.toBlob((blob) => {
        if (blob) {
          setExportError("");
          void nativeSaveBlob(blob, `${name}_批注画板.png`, "image/png").catch(error => setExportError(error instanceof Error ? error.message : "导出失败，请重试"));
        }
      }, "image/png");
    };

    if (bgDataUrl) {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, exportCanvas.width, exportCanvas.height);
        ctx.drawImage(canvas, 0, 0);
        download();
      };
      img.onerror = () => {
        ctx.drawImage(canvas, 0, 0);
        download();
      };
      img.src = bgDataUrl;
    } else {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
      ctx.drawImage(canvas, 0, 0);
      download();
    }
  };

  if (!active) return null;

  return (
    <div
      ref={containerRef}
      className={`topology-whiteboard-overlay tool-${tool}`}
      onClick={loadedKey === key ? handleCanvasClick : undefined}
    >
      {exportError && <div className="whiteboard-persistence" role="alert">{exportError}</div>}
      {(persistenceError || loadedKey !== key) && <div className="whiteboard-persistence" role="status">{persistenceError || "正在加载批注…"}{persistenceError && loadedKey === key && <button onClick={e => { e.stopPropagation(); setRetry(v => v + 1); }}>重试保存</button>}</div>}
      <canvas
        ref={canvasRef}
        className="topology-whiteboard-canvas"
        onPointerDown={loadedKey === key ? handlePointerDown : undefined}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      />

      {/* Sticky Notes */}
      {notes.map((note) => (
        <div
          key={note.id}
          className={`whiteboard-sticky-note ${editingNoteId === note.id ? "is-editing" : ""}`}
          style={{
            left: `${note.x}px`,
            top: `${note.y}px`,
            borderColor: note.color,
          }}
          onMouseDown={(e) => {
            e.stopPropagation();
            setDraggingNoteId(note.id);
            dragOffsetRef.current = {
              x: e.clientX - note.x,
              y: e.clientY - note.y,
            };
          }}
          onMouseMove={(e) => {
            if (draggingNoteId === note.id) {
              const newX = Math.max(0, e.clientX - dragOffsetRef.current.x);
              const newY = Math.max(0, e.clientY - dragOffsetRef.current.y);
              setNotes((prev) =>
                prev.map((n) => (n.id === note.id ? { ...n, x: newX, y: newY } : n))
              );
            }
          }}
          onMouseUp={() => setDraggingNoteId(null)}
        >
          <div className="note-header">
            <span className="note-dot" style={{ background: note.color }} />
            <button
              type="button"
              className="note-remove-btn"
              title="删除便签"
              onClick={(e) => {
                e.stopPropagation();
                setNotes((prev) => prev.filter((n) => n.id !== note.id));
              }}
            >
              ✕
            </button>
          </div>
          {editingNoteId === note.id ? (
            <textarea
              autoFocus
              defaultValue={note.text === "点击输入批注说明..." ? "" : note.text}
              placeholder="输入批注内容..."
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                const text = e.target.value.trim() || "未命名批注";
                setNotes((prev) =>
                  prev.map((n) => (n.id === note.id ? { ...n, text } : n))
                );
                setEditingNoteId(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  (e.target as HTMLElement).blur();
                }
              }}
            />
          ) : (
            <div
              className="note-text"
              onClick={(e) => {
                e.stopPropagation();
                setEditingNoteId(note.id);
              }}
            >
              {note.text}
            </div>
          )}
        </div>
      ))}

      {/* Floating Whiteboard Control Dock */}
      <aside
        className="topology-whiteboard-toolbar"
        aria-label="画板工具栏"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="toolbar-section tools-group">
          <button
            type="button"
            className={`wb-tool-btn ${tool === "pen" ? "is-active" : ""}`}
            title="自由画笔：划线批注、圈出关键设备"
            onClick={() => setTool("pen")}
          >
            <IconPencil size={15} />
            <span>画笔</span>
          </button>
          <button
            type="button"
            className={`wb-tool-btn ${tool === "highlighter" ? "is-active" : ""}`}
            title="荧光高亮笔：半透明高亮路径与连线，不遮挡标签"
            onClick={() => setTool("highlighter")}
          >
            <IconHighlighter size={15} />
            <span>荧光笔</span>
          </button>
          <button
            type="button"
            className={`wb-tool-btn ${tool === "arrow" ? "is-active" : ""}`}
            title="指向箭头：拖拽绘制指示箭头"
            onClick={() => setTool("arrow")}
          >
            <IconArrowUpRight size={15} />
            <span>箭头</span>
          </button>
          <button
            type="button"
            className={`wb-tool-btn ${tool === "rect" ? "is-active" : ""}`}
            title="框选标注：拖拽画出矩形范围框"
            onClick={() => setTool("rect")}
          >
            <IconBox size={15} />
            <span>框选</span>
          </button>
          <button
            type="button"
            className={`wb-tool-btn ${tool === "note" ? "is-active" : ""}`}
            title="便签批注：点击画布放置文字便签"
            onClick={() => setTool("note")}
          >
            <IconNote size={15} />
            <span>便签</span>
          </button>
        </div>

        <div className="toolbar-divider" />

        {/* Colors */}
        <div className="toolbar-section colors-group">
          {COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`wb-color-btn ${color === c.id ? "is-active" : ""}`}
              style={{ backgroundColor: c.id }}
              title={`${c.label} (${c.hint})`}
              onClick={() => setColor(c.id)}
            />
          ))}
        </div>

        <div className="toolbar-divider" />

        {/* Sizes */}
        <div className="toolbar-section sizes-group">
          {SIZES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`wb-size-btn ${size === s.id ? "is-active" : ""}`}
              onClick={() => setSize(s.id)}
              title={`笔触粗细: ${s.label}`}
            >
              <span style={{ width: s.id + 2, height: s.id + 2 }} />
            </button>
          ))}
        </div>

        <div className="toolbar-divider" />

        {/* Actions */}
        <div className="toolbar-section actions-group">
          <button
            type="button"
            className="wb-action-btn"
            title="撤销上一笔 (Ctrl+Z)"
            disabled={strokes.length === 0 && notes.length === 0}
            onClick={handleUndo}
          >
            <IconUndo size={14} />
          </button>
          <button
            type="button"
            className="wb-action-btn"
            title="清空画板所有笔触与便签"
            disabled={strokes.length === 0 && notes.length === 0}
            onClick={handleClear}
          >
            <IconTrash size={14} />
          </button>
          <button
            type="button"
            className="wb-action-btn highlight"
            title="导出带批注的高清拓扑图 (PNG)"
            onClick={handleExport}
          >
            <IconDownload size={14} />
            <span>导出批注</span>
          </button>
          <button
            type="button"
            className="wb-action-btn close-btn"
            title="关闭画板批注"
            onClick={onClose}
          >
            <IconClose size={14} />
          </button>
        </div>
      </aside>
    </div>
  );
}
