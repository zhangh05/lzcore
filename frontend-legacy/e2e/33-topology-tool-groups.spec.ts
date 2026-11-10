import { test, expect } from './fixtures';
import fs from 'node:fs/promises';

async function drawingPage(page: any) {
  let drawing:any={topology_id:'tool-groups',name:'工具归组与长参考线',version:1,groups:[],links:[],canvas_items:[],nodes:[
    {node_id:'a',display_name:'核心交换机1',device_type:'switch',x:130,y:180},
    {node_id:'b',display_name:'核心交换机2',device_type:'switch',x:700,y:200},
  ]};
  await page.route('**/api/extensions/network.operations/topologies**',(route:any)=>{
    const req=route.request(),url=new URL(req.url());
    if(req.method()==='PUT') { drawing={...drawing,...JSON.parse(req.postData()||'{}')}; return route.fulfill({json:{ok:true,topology:drawing}}); }
    return route.fulfill({json:url.pathname.endsWith('/overlay')?{overlays:[]}:url.pathname.endsWith('/revisions')?{revisions:[]}:url.pathname.endsWith('/tool-groups')?{topology:drawing}:{topologies:[drawing]}});
  });
  await page.goto('/topology?topology=tool-groups');
  const host=page.locator('.netops-cytoscape').first();
  await expect.poll(()=>host.evaluate((el:any)=>el._cyreg?.cy?.nodes().length)).toBe(2);
  return host;
}

test('33a. grouped menus retain controls, empty observation feedback, keyboard focus and narrow layout',async({page})=>{
  await drawingPage(page);
  await expect(page.getByRole('button',{name:'选择',exact:true})).toHaveCount(1);
  await expect(page.getByRole('button',{name:'连线',exact:true})).toHaveCount(1);
  await expect(page.locator('.studio-canvas-caption input')).toHaveCount(0);
  await page.locator('.studio-display-menu summary').click();
  await expect(page.getByText('暂无可显示的检测记录',{exact:true})).toBeVisible();
  await page.getByRole('checkbox',{name:'接口标签',exact:true}).uncheck();
  await expect(page.locator('.studio-display-menu')).toHaveAttribute('open','');
  await page.keyboard.press('Escape');
  await expect(page.locator('.studio-display-menu')).not.toHaveAttribute('open','');
  await expect(page.locator('.studio-display-menu summary')).toBeFocused();
  await page.locator('.studio-guides-menu summary').click();
  await page.locator('.studio-file-menu summary').click();
  await expect(page.locator('.studio-guides-menu')).not.toHaveAttribute('open','');
  await expect(page.getByRole('button',{name:'导出 SVG',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  for(const width of [1878,1440,1280,920,640,628]) {
    await page.setViewportSize({width,height:900});
    if (width < 1000 && await page.getByRole('button',{name:'收起侧栏',exact:true}).isVisible()) await page.getByRole('button',{name:'收起侧栏',exact:true}).click();
    if(width <= 900) await expect.poll(()=>page.locator('.app-sidebar').evaluate(el=>el.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    const geometry=await page.locator('.topology-canvas-area').evaluate(el=>{
      const area=el.getBoundingClientRect();
      return {left:area.left,right:area.right, controls:[...el.querySelectorAll('.topology-canvas-toolbar > div, .topology-editbar > div')].map(control=>{const r=control.getBoundingClientRect();return {left:r.left,right:r.right};})};
    });
    for(const control of geometry.controls) { expect(control.left).toBeGreaterThanOrEqual(geometry.left);expect(control.right).toBeLessThanOrEqual(geometry.right+1); }
    await page.locator('.studio-guides-menu summary').click();
    await expect.poll(async()=>{const r=await page.locator('.studio-guides-menu > div').boundingBox();return r!.x+r!.width;}).toBeLessThanOrEqual(width+1);
    const box=await page.locator('.studio-guides-menu > div').boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(width+1);
    await page.keyboard.press('Escape');
    const mode=await page.locator('.studio-workspace-mode-switch').boundingBox();
    const chat=await page.locator('.topology-chat-actions').boundingBox();
    expect(Math.abs((mode!.y+mode!.height/2)-(chat!.y+chat!.height/2))).toBeLessThan(2);
    const groups=await page.locator('.topology-editbar > div').all();
    const first=(await groups[0].boundingBox())!, second=(await groups[1].boundingBox())!;
    const padding=width<=760?8:16;
    expect(second.x+second.width).toBeCloseTo(geometry.right-padding,0);
    const documentActions=(await page.locator('.topology-canvas-toolbar > .toolbar-right').boundingBox())!;
    expect(documentActions.x+documentActions.width).toBeCloseTo(geometry.right-padding,0);
    await expect(page.locator('.topology-editbar > .toolbar-right .annotation-action')).toHaveCount(1);
    await expect(page.locator('.studio-edit-tools .annotation-action')).toHaveCount(0);
    // Left-anchored popover when space permits, clamped inside the canvas otherwise.
    if(width >= 1280) {
      await page.locator('.studio-file-menu summary').click();
      const trigger=(await page.locator('.studio-file-menu summary').boundingBox())!;
      const panel=(await page.locator('.studio-file-menu > div').boundingBox())!;
      expect(panel.x).toBeLessThanOrEqual(trigger.x+1);
      expect(panel.x+panel.width).toBeLessThanOrEqual(geometry.right);
      await page.keyboard.press('Escape');
    }
  }
  await page.screenshot({path:'../output/playwright/v3.3.11/toolbar-narrow.png',clip:{x:0,y:0,width:628,height:190}});
  await page.setViewportSize({width:1440,height:900});
  await page.screenshot({path:'../output/playwright/v3.3.11/grouped-tools.png',fullPage:true});
  await page.screenshot({path:'../output/playwright/v3.3.11/toolbar-desktop.png',clip:{x:0,y:0,width:1440,height:220}});
  await expect(page.locator('.studio-search-menu')).toHaveCount(0);
  await expect(page.getByRole('textbox',{name:'在画布中搜索设备'})).toHaveCount(0);
  // File/export/history belong to the document header, not the drawing row.
  await expect(page.locator('.topology-canvas-toolbar .studio-file-menu')).toHaveCount(1);
  await expect(page.locator('.topology-editbar .studio-file-menu')).toHaveCount(0);
});

for(const zoom of [.6,1.3]) test(`33b. long real-edge alignment and release at zoom ${zoom}`,async({page})=>{
  const host=await drawingPage(page);
  await host.evaluate((el:any)=>{el._cyreg.cy.getElementById('b').select();});
  await expect(page.getByRole('button',{name:'收起详情',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'收起详情',exact:true}).click();
  await host.evaluate((el:any,zoom:number)=>{const cy=el._cyreg.cy;cy.stop();cy.zoom(zoom);cy.pan({x:20,y:20});},zoom);
  const box=(await host.boundingBox())!;
  const move=(x:number,y:number)=>page.mouse.move(box.x+20+x*zoom,box.y+20+y*zoom);
  await move(700,200);await page.mouse.down();await move(700,182);await move(700,180);
  const line=page.locator('.netops-align-guides line[data-aligned=true]');
  await expect(line).not.toHaveCount(0);
  const span=await line.evaluateAll(lines=>Math.max(...lines.map(line=>Math.abs(Number(line.getAttribute('x2'))-Number(line.getAttribute('x1'))))));
  expect(span).toBeGreaterThan(400);
  const preview=await host.evaluate((el:any)=>({...el._cyreg.cy.getElementById('b').position()}));
  expect(preview.y).toBeCloseTo(180,1);
  await page.mouse.up();
  await expect.poll(()=>host.evaluate((el:any)=>({...el._cyreg.cy.getElementById('b').position()}))).toEqual(preview);
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await expect(page.getByRole('button',{name:'已保存',exact:true})).toBeVisible();
  await page.reload();
  await expect.poll(()=>host.evaluate((el:any)=>el._cyreg?.cy?.getElementById('b').position()?.y)).toBeCloseTo(180,1);
});

test('33c. manual guides edit, drag, lock, persist and stay outside SVG export',async({page})=>{
  const host=await drawingPage(page);
  await host.evaluate((el:any)=>{const cy=el._cyreg.cy;cy.stop();cy.zoom(1);cy.pan({x:20,y:20});});
  await page.locator('.studio-guides-menu summary').click();
  await page.getByRole('button',{name:'添加水平参考线',exact:true}).click();
  await page.getByRole('spinbutton',{name:'参考线 1 坐标'}).fill('300');
  await page.keyboard.press('Escape');
  const guide=page.locator('.reference-line.axis-y');
  await expect(guide).toHaveCount(1);
  const box=(await host.boundingBox())!;
  const handle=(await guide.locator('span').boundingBox())!;
  await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2+20);await page.mouse.up();
  await expect(guide).toHaveAccessibleName('水平参考线 320');
  await page.locator('.studio-guides-menu summary').click();
  await page.getByRole('checkbox',{name:'锁定参考线 1'}).check();
  await expect(page.getByRole('spinbutton',{name:'参考线 1 坐标'})).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.reload();await expect(guide).toHaveAccessibleName('水平参考线 320 已锁定');
  await page.locator('.studio-file-menu summary').click();
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'导出 SVG',exact:true}).click();
  const svg=await fs.readFile((await(await pending).path())!,'utf8');
  expect(svg).not.toContain('reference-line');expect(svg).not.toContain('水平参考线');
  await page.locator('.studio-guides-menu summary').click();await page.getByRole('button',{name:'删除参考线 1'}).click();
  await expect(guide).toHaveCount(0);
});

test('33d. locked manual reference attracts device bodies while its long stroke lets the device be grabbed',async({page})=>{
  const host=await drawingPage(page);
  await host.evaluate((el:any)=>{el._cyreg.cy.getElementById('b').select();});
  await page.getByRole('button',{name:'收起详情',exact:true}).click();
  await host.evaluate((el:any)=>{const cy=el._cyreg.cy;cy.stop();cy.zoom(1);cy.pan({x:20,y:20});});
  await page.locator('.studio-guides-menu summary').click();
  await page.getByRole('checkbox',{name:'智能参考线',exact:true}).uncheck();
  await page.getByRole('button',{name:'添加水平参考线',exact:true}).click();
  await page.getByRole('spinbutton',{name:'参考线 1 坐标'}).fill('300');
  await page.getByRole('checkbox',{name:'锁定参考线 1'}).check();await page.keyboard.press('Escape');
  let box=(await host.boundingBox())!;
  await page.mouse.move(box.x+720,box.y+220);await page.mouse.down();
  await page.mouse.move(box.x+720,box.y+290,{steps:20});
  await expect.poll(()=>host.evaluate((el:any)=>el._cyreg.cy.getElementById('b').position().y)).toBeCloseTo(270,1);
  await page.mouse.up();
  // Place the centre on the manual line; the full-width stroke must not eat a grab.
  await host.evaluate((el:any)=>{const cy=el._cyreg.cy;cy.getElementById('b').position({x:700,y:300});});
  box=(await host.boundingBox())!;
  await page.mouse.move(box.x+720,box.y+320);await page.mouse.down();
  await page.mouse.move(box.x+740,box.y+340,{steps:8});await page.mouse.up();
  await expect.poll(()=>host.evaluate((el:any)=>el._cyreg.cy.getElementById('b').position().x)).toBeGreaterThan(710);
  await page.screenshot({path:'../output/playwright/v3.3.11/manual-reference.png',fullPage:true});
});

for(const zoom of [.6,1.3]) test(`33e. smart-guide switch changes real pointer feedback and attraction at zoom ${zoom}`,async({page})=>{
  const host=await drawingPage(page);
  await host.evaluate((el:any)=>{el._cyreg.cy.getElementById('b').select();});
  await page.getByRole('button',{name:'收起详情',exact:true}).click();
  for(const enabled of [false,true]) {
    await page.locator('.studio-guides-menu summary').click();
    await page.getByRole('checkbox',{name:'智能参考线',exact:true}).setChecked(enabled);
    await page.getByRole('checkbox',{name:'网格吸附',exact:true}).uncheck();
    await page.keyboard.press('Escape');
    await host.evaluate((el:any,z:number)=>{const cy=el._cyreg.cy;cy.stop();cy.zoom(z);cy.pan({x:20,y:20});},zoom);
    const box=(await host.boundingBox())!;
    const from=await host.evaluate((el:any)=>el._cyreg.cy.getElementById('b').renderedPosition());
    await page.mouse.move(box.x+from.x,box.y+from.y);await page.mouse.down();
    const move=(screenOffset:number)=>page.mouse.move(box.x+20+700*zoom,box.y+20+180*zoom+screenOffset);
    const lines=page.locator('.netops-align-guides line[data-source=device]');
    await move(8);
    if(enabled) await expect(lines).not.toHaveCount(0);else await expect(lines).toHaveCount(0);
    let y=await host.evaluate((el:any)=>el._cyreg.cy.getElementById('b').position().y);
    expect(Math.abs((y-180)*zoom-8)).toBeLessThan(.8);
    await move(2);
    const distance=async()=>Math.abs((await host.evaluate((el:any)=>el._cyreg.cy.getElementById('b').position().y)-180)*zoom);
    if(enabled) await expect.poll(distance).toBeLessThan(1);
    else await expect.poll(async()=>Math.abs(await distance()-2)).toBeLessThan(.8);
    await move(0);
    if(enabled) await expect(page.locator('.netops-align-guides line[data-source=device][data-aligned=true]')).not.toHaveCount(0);
    else await expect(lines).toHaveCount(0);
    if(zoom===1.3) await page.screenshot({path:`../output/playwright/v3.3.11/smart-guides-${enabled?'on':'off'}.png`,fullPage:true});
    const preview=await host.evaluate((el:any)=>({...el._cyreg.cy.getElementById('b').position()}));
    await page.mouse.up();
    await expect.poll(()=>host.evaluate((el:any)=>({...el._cyreg.cy.getElementById('b').position()}))).toEqual(preview);
    await expect(page.locator('.netops-align-guides')).toHaveCount(0);
  }
});

test('33f. click jitter does not start a drag and a subsequent drag stays responsive near its start',async({page})=>{
  const host=await drawingPage(page);
  await host.evaluate((el:any)=>{
    const cy=el._cyreg.cy; cy.stop(); cy.zoom(1); cy.pan({x:20,y:20});
    el.__dragCount=0; cy.on('drag','node',()=>el.__dragCount++);
  });
  const box=(await host.boundingBox())!;
  const start=await host.evaluate((el:any)=>el._cyreg.cy.getElementById('b').renderedPosition());
  await page.mouse.move(box.x+start.x,box.y+start.y);
  await page.mouse.down();
  await page.mouse.move(box.x+start.x+2,box.y+start.y+1);
  await page.mouse.up();
  expect(await host.evaluate((el:any)=>el.__dragCount)).toBe(0);
  expect(await host.evaluate((el:any)=>({...el._cyreg.cy.getElementById('b').position()}))).toEqual({x:700,y:200});
  await page.mouse.move(box.x+start.x,box.y+start.y);
  await page.mouse.down();
  await page.mouse.move(box.x+start.x+16,box.y+start.y);
  await expect.poll(()=>host.evaluate((el:any)=>el.__dragCount)).toBeGreaterThan(0);
  await page.mouse.move(box.x+start.x+2,box.y+start.y);
  await expect.poll(()=>host.evaluate((el:any)=>el._cyreg.cy.getElementById('b').position().x)).toBeCloseTo(702,0);
  await page.mouse.up();
});

test('33g. saving a selected-node drag does not replay incoming-link focus or change the next drag viewport',async({page})=>{
  const host=await drawingPage(page);
  await host.evaluate((el:any)=>{el._cyreg.cy.getElementById('b').select();});
  await page.getByRole('button',{name:'收起详情',exact:true}).click();
  await host.evaluate((el:any)=>{const cy=el._cyreg.cy;cy.stop();cy.zoom(.6);cy.pan({x:20,y:20});});
  const box=(await host.boundingBox())!;
  let point=await host.evaluate((el:any)=>el._cyreg.cy.getElementById('b').renderedPosition());
  await page.mouse.move(box.x+point.x,box.y+point.y);await page.mouse.down();
  await page.mouse.move(box.x+point.x+20,box.y+point.y+24);await page.mouse.up();
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await expect(page.getByRole('button',{name:'已保存',exact:true})).toBeVisible();
  const before=await host.evaluate((el:any)=>({zoom:el._cyreg.cy.zoom(),...el._cyreg.cy.pan()}));
  expect(before.zoom).toBe(.6);
  point=await host.evaluate((el:any)=>el._cyreg.cy.getElementById('b').renderedPosition());
  await page.mouse.move(box.x+point.x,box.y+point.y);await page.mouse.down();
  await page.mouse.move(box.x+point.x+8,box.y+point.y+8);
  // The erroneous incoming-link callback fired 400ms after the preceding
  // model update and completed its centring/zoom another 230ms later.
  await page.waitForTimeout(800);
  expect(await host.evaluate((el:any)=>({zoom:el._cyreg.cy.zoom(),...el._cyreg.cy.pan()}))).toEqual(before);
  await page.mouse.up();
});

test('33h. at 390px the library is a closable drawer over the canvas and the agent panel a full-width sheet',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await drawingPage(page);
  const library=page.getByRole('button',{name:'设备库与拓扑列表'});
  await library.click();
  await expect(page.locator('.topology-sidebar')).toBeVisible();
  await expect(page.getByRole('button',{name:'关闭设备库'})).toBeFocused();
  const layout=await page.evaluate(()=>{
    const canvas=document.querySelector('.topology-canvas-area')!.getBoundingClientRect();
    const sheet=document.querySelector('.topology-sidebar')!.getBoundingClientRect();
    return {canvasLeft:canvas.left,canvasWidth:canvas.width,sheetWidth:sheet.width,controls:[...document.querySelectorAll('.netops-viewport-controls button')].map(b=>b.getBoundingClientRect().height)};
  });
  expect(layout.canvasLeft).toBeLessThan(1);
  expect(layout.canvasWidth).toBeGreaterThanOrEqual(389);
  expect(layout.sheetWidth).toBeLessThanOrEqual(350);
  for(const height of layout.controls) expect(height).toBeLessThanOrEqual(34);
  await page.keyboard.press('Escape');
  await expect(page.locator('.topology-sidebar')).toBeHidden();
  await expect(library).toBeFocused();
  await library.click();
  await page.getByRole('button',{name:'关闭设备库'}).click();
  await expect(page.locator('.topology-sidebar')).toBeHidden();
  await expect(library).toBeFocused();

  const agent=page.getByRole('button',{name:'绘图对话',exact:true});
  await agent.click();
  await expect(page.getByRole('button',{name:'关闭绘图对话'})).toBeFocused();
  const dock=(await page.locator('.studio-agent-dock').boundingBox())!;
  expect(dock.width).toBeGreaterThanOrEqual(390-32);
  const input=(await page.locator('.topology-agent-composer textarea').boundingBox())!;
  expect(input.width).toBeGreaterThanOrEqual(280);
  await page.keyboard.press('Escape');
  await expect(agent).toHaveAttribute('aria-pressed','false');
  await expect(agent).toBeFocused();
  await agent.click();
  await page.getByRole('button',{name:'关闭绘图对话'}).click();
  await expect(agent).toHaveAttribute('aria-pressed','false');
  await expect(agent).toBeFocused();
});
