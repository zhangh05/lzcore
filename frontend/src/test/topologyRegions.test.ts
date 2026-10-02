import { expect, test } from "vitest";
import { fitRegions, moveRegionElements, regionBounds, regionContains } from "../../../extensions/network_operations/frontend/components/topologyRegions";
import { layoutTopology } from "../../../extensions/network_operations/frontend/components/topologyLayout";
import type { Topology } from "../../../extensions/network_operations/frontend/components/TopologyWorkspace";

const drawing = (): Topology => ({topology_id:"t",name:"regions",description:"",version:1,created_at:"",updated_at:"",groups:[],links:[],
  nodes:[{node_id:"a",x:100,y:100,region_id:"A"},{node_id:"b",x:110,y:100,region_id:"B"}],
  canvas_items:[{item_id:"A",kind:"rectangle",text:"same",x:100,y:100,width:240,height:180,auto_fit:true},
    {item_id:"B",kind:"rectangle",text:"same",x:110,y:100,width:240,height:180,auto_fit:true}]});

test("geometry reference vector matches backend and contains ellipse footprints", () => {
  const nodes = [{node_id:"a",x:100,y:200},{node_id:"b",x:300,y:400}];
  expect(regionBounds(nodes)).toEqual({x:200,y:288,width:380,height:384});
  const ellipse = {item_id:"e",text:"ellipse",kind:"ellipse" as const,...regionBounds(nodes,"ellipse")};
  expect(nodes.every(n => regionContains(ellipse,n))).toBe(true);
});

test("same labels and nearby foreign nodes never change member identity", () => {
  const result = fitRegions(drawing());
  expect(result.canvas_items?.map(i => i.x)).toEqual([100,110]);
  expect(result.nodes.map(n => n.region_id)).toEqual(["A","B"]);
  expect(result.canvas_items).toHaveLength(2);
});

test("whole region movement follows members and rigid peers once, with explicit positions winning", () => {
  const t = drawing(); t.nodes[0].lock_group="lock"; t.nodes[1].lock_group="lock";
  const result = moveRegionElements(t,[{element_id:"canvas-A",x:200,y:180}],true);
  expect(result.nodes.map(n=>[n.x,n.y])).toEqual([[200,180],[210,180]]);
  expect(result.canvas_items?.every(i=>i.auto_fit===true)).toBe(true);
  const explicit = moveRegionElements(t,[{element_id:"canvas-A",x:200,y:180},{element_id:"a",x:250,y:190}],true);
  expect(explicit.nodes[0]).toMatchObject({x:250,y:190});
});

test("frame-only move keeps member positions and geometry stays fixed on later node edits", () => {
  const t = drawing();
  const moved = moveRegionElements(t,[{element_id:"canvas-A",x:900,y:800}],false);
  expect(moved.nodes).toEqual(t.nodes);
  expect(moved.canvas_items?.[0]).toMatchObject({x:900,y:800,auto_fit:false});
  moved.nodes[0].x=1200;
  expect(fitRegions(moved).canvas_items?.[0]).toEqual(moved.canvas_items?.[0]);
});

test.each(["grid","hierarchy-v","radial"] as const)("%s packs region members together and keeps unrelated objects", async algorithm => {
  const t = drawing(); t.nodes=Array.from({length:12},(_,i)=>({node_id:String(i),x:i,y:0,region_id:i%2?"A":"B"}));
  const result=await layoutTopology(t,algorithm);
  for (const item of result.canvas_items!) expect(result.nodes.filter(n=>n.region_id===item.item_id).every(n=>regionContains(item,n))).toBe(true);
  const [a,b]=result.canvas_items!;
  expect(Math.abs(a.x-b.x) >= (a.width+b.width)/2+80 || Math.abs(a.y-b.y) >= (a.height+b.height)/2+80).toBe(true);
  expect(result.links).toEqual(t.links); expect(result.nodes.map(n=>n.node_id)).toEqual(t.nodes.map(n=>n.node_id));
});

test("fixed frame with insufficient room retains authored positions and reports why", async () => {
  const t=drawing(); t.canvas_items![0].auto_fit=false; t.canvas_items![0].width=40; t.canvas_items![0].height=24;
  const result=await layoutTopology(t,"grid");
  expect(result.nodes[0]).toEqual(t.nodes[0]); expect(result.canvas_items![0]).toEqual(t.canvas_items![0]);
  expect(result.layout_issues?.[0]).toContain("空间不足");
});


test("empty fixed regions remain obstacles for unassigned layout", async () => {
  const t=drawing(); t.nodes=[{node_id:"a",x:500,y:500}];
  t.canvas_items=[{item_id:"empty",kind:"rectangle",text:"empty",x:200,y:200,width:400,height:400,auto_fit:false}];
  const result=await layoutTopology(t,"grid");
  expect(result.canvas_items).toEqual(t.canvas_items);
  expect(result.nodes[0].x-70).toBeGreaterThanOrEqual(400);
});

test("300 nodes in ten regions retain IDs, fit members and avoid region collisions", async () => {
  const t=drawing(); t.nodes=Array.from({length:300},(_,i)=>({node_id:`n${i}`,x:0,y:0,region_id:`r${i%10}`}));
  t.canvas_items=Array.from({length:10},(_,i)=>({item_id:`r${i}`,kind:"rectangle",text:"same",x:0,y:0,width:240,height:180,auto_fit:true}));
  const result=await layoutTopology(t,"grid");
  expect(result.nodes.map(n=>n.node_id)).toEqual(t.nodes.map(n=>n.node_id));
  for (const item of result.canvas_items!) expect(result.nodes.filter(n=>n.region_id===item.item_id).every(n=>regionContains(item,n))).toBe(true);
  const items=result.canvas_items!;
  for (let i=0;i<items.length;i++) for (let j=i+1;j<items.length;j++) {
    const a=items[i],b=items[j];
    expect(Math.abs(a.x-b.x)>=(a.width+b.width)/2+80 || Math.abs(a.y-b.y)>=(a.height+b.height)/2+80).toBe(true);
  }
});
