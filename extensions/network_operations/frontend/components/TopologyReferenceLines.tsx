import { useRef } from 'react';
import './TopologyReferenceLines.css';
export type ReferenceLine = { id: string; axis: 'x' | 'y'; position: number; locked: boolean };
export function referenceTargets(lines: ReferenceLine[], axis: 'x' | 'y', half: number) {
  return lines.filter(line => line.axis === axis).flatMap(line => [-1,0,1].map(edge => ({
    key: `reference:${line.id}:${edge}`, source: null, line: line.position, offset: edge * half, priority: -1,
  })));
}
export function TopologyReferenceLines({ lines, viewport, editable, onChange }: {
  lines: ReferenceLine[]; viewport: { x: number; y: number; zoom: number }; editable: boolean;
  onChange?: (lines: ReferenceLine[]) => void;
}) {
  const drag = useRef<{ id: string; coordinate: number; position: number; scale: number } | null>(null);
  return <div className="topology-reference-lines" aria-label="画布参考线">
    {lines.map(line => <button key={line.id} type="button" className={`reference-line axis-${line.axis}`} data-locked={line.locked}
      aria-label={`${line.axis === 'x' ? '垂直' : '水平'}参考线 ${line.position}${line.locked ? ' 已锁定' : ''}`}
      aria-disabled={!editable || line.locked} title={line.locked ? '参考线已锁定' : '拖动坐标标签调整参考线；方向键微调'}
      style={line.axis === 'x' ? { left: line.position * viewport.zoom + viewport.x } : { top: line.position * viewport.zoom + viewport.y }}
      onPointerDown={event => {
        event.stopPropagation(); if (!editable || line.locked) return;
        const parent = event.currentTarget.parentElement!;
        const rect = parent.getBoundingClientRect();
        const scale = line.axis === 'x' ? rect.width/parent.clientWidth : rect.height/parent.clientHeight;
        drag.current = { id: line.id, coordinate: line.axis === 'x' ? event.clientX : event.clientY, position: line.position, scale: scale || 1 };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        if (drag.current?.id !== line.id) return;
        const coordinate = line.axis === 'x' ? event.clientX : event.clientY;
        const position = drag.current.position + (coordinate-drag.current.coordinate)/drag.current.scale/viewport.zoom;
        onChange?.(lines.map(item => item.id === line.id ? { ...item, position } : item));
      }}
      onPointerUp={event => { drag.current=null; if(event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { drag.current=null; }} onLostPointerCapture={() => { drag.current=null; }}
      onKeyDown={event => {
        if (!editable || line.locked) return;
        const keys = line.axis === 'x' ? ['ArrowLeft','ArrowRight'] : ['ArrowUp','ArrowDown'];
        if (!keys.includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        onChange?.(lines.map(item => item.id === line.id ? { ...item, position: item.position + (event.key === keys[0] ? -1 : 1)*(event.shiftKey ? 8 : 1) } : item));
      }}><span>{line.axis === 'x' ? 'X' : 'Y'} {Math.round(line.position)}</span></button>)}
  </div>;
}
