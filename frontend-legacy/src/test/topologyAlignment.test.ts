import { describe, it, expect } from 'vitest';
import { alignBodies } from '../../../extensions/network_operations/frontend/components/topologyAlignment';
import { nearbySnapTargets, resolveDragAxis } from '../../../extensions/network_operations/frontend/components/topologyDragSnap';
import { referenceTargets } from '../../../extensions/network_operations/frontend/components/TopologyReferenceLines';
const bodies = [ {id:'a',x:100,y:120,halfW:38,halfH:30}, {id:'b',x:700,y:150,halfW:60,halfH:45} ];
describe('drawing alignment',()=> {
  it('aligns all six body anchors for mixed device sizes without rounding or altering the other axis',()=> {
    for (const direction of ['left','center','right','top','middle','bottom'] as const) {
      const positions=alignBodies(bodies,direction);
      const horizontal=['left','center','right'].includes(direction);
      const side=['left','top'].includes(direction)?-1:['right','bottom'].includes(direction)?1:0;
      const anchors=positions.map((p,i)=>(horizontal?p.x:p.y)+side*(horizontal?bodies[i].halfW:bodies[i].halfH));
      expect(anchors[0]).toBe(anchors[1]);
      positions.forEach((p,i)=>expect(horizontal?p.y:p.x).toBe(horizontal?bodies[i].y:bodies[i].x));
    }
  });
  it('permits a long reference without enlarging the screen-space attraction radius',()=> {
    const a=bodies[0], b={...bodies[1],y:120};
    expect(nearbySnapTargets('y',a,[b],1)).toEqual([]);
    const targets=nearbySnapTargets('y',a,[b],1,true);
    expect(resolveDragAxis(126,1,targets,null,false).target).toBeNull();
    expect(resolveDragAxis(120.5,1,targets,null,false).position).toBe(120);
  });
  it('manual references capture actual edges or centres, including locked lines',()=> {
    const lines=[{id:'h',axis:'y' as const,position:300,locked:true}];
    const targets=referenceTargets(lines,'y',30);
    expect(referenceTargets(lines,'x',38)).toEqual([]);
    for(const position of [270,300,330]) expect(resolveDragAxis(position+.5,1,targets,null,false).position).toBe(position);
  });
});
