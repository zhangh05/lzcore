import type { SnapBody } from './topologyDragSnap';
export type AlignDirection = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
/** Align actual icon bodies, excluding labels and runtime decorations. */
export function alignBodies(bodies: SnapBody[], direction: AlignDirection) {
  if (bodies.length < 2) return [];
  const horizontal = ['left', 'center', 'right'].includes(direction);
  const axis = horizontal ? 'x' : 'y';
  const half = horizontal ? 'halfW' : 'halfH';
  const side = ['left', 'top'].includes(direction) ? -1 : ['right', 'bottom'].includes(direction) ? 1 : 0;
  const anchors = bodies.map(body => body[axis] + side * body[half]);
  const line = side < 0 ? Math.min(...anchors) : side > 0 ? Math.max(...anchors) : anchors.reduce((a,b)=>a+b,0)/anchors.length;
  return bodies.map(body => ({ element_id: body.id, x: body.x, y: body.y, [axis]: line - side * body[half] }));
}
