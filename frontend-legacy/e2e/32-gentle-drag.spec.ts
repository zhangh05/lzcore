import { test, expect } from './fixtures';

for (const zoom of [.15, .6, 1.3]) for (const grid of [false, true]) {
  test(`32. slow drag remains bounded and stable at zoom ${zoom}, grid attraction ${grid}`, async ({ page }) => {
    let drawing: any = { topology_id: 'gentle-drag', name: '连续拖动与渐进吸附', version: 1, groups: [], links: [], canvas_items: [], nodes: [
      { node_id: 'moving', display_name: '移动设备', device_type: 'router', x: 110, y: 100 },
      { node_id: 'peer', display_name: '同步设备', device_type: 'switch', x: 110, y: 50 },
      { node_id: 'near', display_name: '附近参考', device_type: 'switch', x: 260, y: 220 },
      { node_id: 'far', display_name: '远处设备', device_type: 'router', x: 20000, y: 103 },
    ] };
    const saves: any[] = [];
    await page.route('**/api/extensions/network.operations/topologies**', route => {
      const request = route.request(); const url = new URL(request.url());
      if (request.method() === 'PUT') { drawing = { ...drawing, ...JSON.parse(request.postData() || '{}') }; saves.push(drawing); return route.fulfill({ json: { ok: true, topology: drawing } }); }
      return route.fulfill({ json: url.pathname.endsWith('/overlay') ? { overlays: [] } : url.pathname.endsWith('/revisions') ? { revisions: [] }
        : url.pathname.endsWith('/gentle-drag') ? { topology: drawing } : { topologies: [drawing] } });
    });
    await page.goto('/topology?topology=gentle-drag');
    const host = page.locator('.netops-cytoscape').first();
    await expect.poll(() => host.evaluate((el: any) => el._cyreg?.cy?.nodes().length)).toBe(4);
    await page.locator('.studio-display-menu summary').click();
    await expect(page.getByRole('checkbox', { name: '网格', exact: true })).toBeChecked();
    await page.locator('.studio-guides-menu summary').click();
    const attraction = page.getByRole('checkbox', { name: '网格吸附', exact: true });
    await expect(attraction).not.toBeChecked();
    // Shift+G changes attraction, independently of visible grid lines.
    if (grid) { await page.keyboard.press('Shift+G'); await expect(attraction).toBeChecked(); }
    await page.locator('.studio-display-menu summary').click();
    await expect(page.getByRole('checkbox', { name: '网格', exact: true })).toBeChecked();
    await host.evaluate((el: any, selected) => { const cy=el._cyreg.cy; cy.getElementById('moving').select(); if(selected) cy.getElementById('peer').select(); }, grid);
    await expect(page.locator('.topology-inspector')).toBeVisible();
    await host.evaluate((el: any, zoom) => { const cy=el._cyreg.cy; cy.stop(); cy.zoom(zoom); cy.pan({x:30,y:30}); }, zoom);
    const box=(await host.boundingBox())!;
    const move = (x: number, y: number) => page.mouse.move(box.x+30+x*zoom, box.y+30+y*zoom);
    const state = () => host.evaluate((el: any) => { const cy=el._cyreg?.cy; if(!cy) return []; return ['moving','peer'].map(id=>({...cy.getElementById(id).position()})); });
    await page.evaluate(() => document.addEventListener('mousemove', e => { (window as any).__dragPointer = {x:e.clientX,y:e.clientY}; }));
    await move(110,100);
    const start = await page.evaluate(() => (window as any).__dragPointer);
    const pointerRaw = () => page.evaluate(({start,zoom}) => { const p=(window as any).__dragPointer; return {x:110+(p.x-start.x)/zoom,y:100+(p.y-start.y)/zoom}; },{start,zoom});
    await page.mouse.down();
    let last: any = null;
    // One-screen-pixel steps across several old 32-unit grid boundaries.
    for(let step=6;step<=40;step++) {
      const rawX=110+step/zoom;
      await move(rawX,100);
      const [shown, peer]=await state();
      const raw=await pointerRaw();
      expect(Math.abs(shown.x-raw.x)*zoom).toBeLessThan(2.5);
      expect(Math.abs(shown.y-raw.y)*zoom).toBeLessThan(2.5);
      if(last) expect(Math.abs(shown.x-last.x)*zoom).toBeLessThan(3);
      if(grid) { expect(peer.x-shown.x).toBeCloseTo(0,4); expect(peer.y-shown.y).toBeCloseTo(-50,4); }
      last=shown;
    }
    // The off-screen, unrelated device must not produce any alignment guide.
    if (!grid) await expect(page.locator('.netops-align-guides line[data-reference="far"]')).toHaveCount(0);
    last=null;
    for(let step=-28;step<=28;step++) {
      const distance=step/4, rawY=220+distance/zoom;
      await move(200,rawY);
      const [shown]=await state();
      const raw=await pointerRaw();
      const actualDistance=(raw.y-220)*zoom;
      expect(Math.abs(shown.y-raw.y)*zoom).toBeLessThan(2.5);
      if(last) expect(Math.abs(shown.y-last.y)*zoom).toBeLessThan(3);
      if(Math.abs(actualDistance)<.99) expect(shown.y).toBeCloseTo(220,4);
      if(Math.abs(actualDistance)>1.1 && Math.abs(actualDistance)<4.5) {
        await expect(page.locator('.netops-align-guides line[data-aligned="false"]')).not.toHaveCount(0);
        await expect(page.locator('.netops-align-guides line[data-aligned="true"]')).toHaveCount(0);
      }
      last=shown;
    }
    await move(200,220);
    const preview=await state();
    expect(preview[0].y).toBeCloseTo(220,4);
    await expect(page.locator('.netops-align-guides line[data-aligned="true"]')).not.toHaveCount(0);
    await page.mouse.up();
    await expect.poll(state).toEqual(preview);
    await page.getByRole('button',{name:'保存',exact:true}).click();
    await expect.poll(()=>saves.length).toBe(1);
    await page.reload();
    await expect.poll(state).toEqual(preview);
    if (!grid && zoom === 1.3) {
      await host.evaluate((el:any)=>{el._cyreg.cy.getElementById('moving').select();});
      await expect(page.locator('.canvas-selection-count')).toContainText('已选');
      await page.keyboard.press('ArrowRight');
      await expect.poll(async()=> (await state())[0].x).toBeCloseTo(preview[0].x+1,4);
      await page.keyboard.press('Shift+ArrowRight');
      await expect.poll(async()=> (await state())[0].x).toBeCloseTo(preview[0].x+9,4);
    }
  });
}

test('32b. nearby competing guides do not steal the acquired target', async ({ page }) => {
  const drawing = { topology_id: 'competing-guides', name: '相近参考目标', version: 1, groups: [], canvas_items: [], links: [], nodes: [
    { node_id: 'moving', display_name: '移动', device_type: 'router', x: 110, y: 100 },
    { node_id: 'first', display_name: '第一参考', device_type: 'switch', x: 260, y: 220 },
    { node_id: 'second', display_name: '第二参考', device_type: 'switch', x: 350, y: 222 },
  ] };
  await page.route('**/api/extensions/network.operations/topologies**', route => {
    const url=new URL(route.request().url());
    return route.fulfill({json:url.pathname.endsWith('/overlay')?{overlays:[]}:url.pathname.endsWith('/revisions')?{revisions:[]}
      :url.pathname.endsWith('/competing-guides')?{topology:drawing}:{topologies:[drawing]}});
  });
  await page.goto('/topology?topology=competing-guides');
  const host=page.locator('.netops-cytoscape').first();
  await expect.poll(()=>host.evaluate((el:any)=>el._cyreg?.cy?.nodes().length)).toBe(3);
  await host.evaluate((el:any)=>{el._cyreg.cy.getElementById('moving').select();});
  await expect(page.locator('.topology-inspector')).toBeVisible();
  await host.evaluate((el:any)=>{const cy=el._cyreg.cy;cy.stop();cy.zoom(1);cy.pan({x:30,y:30});});
  const box=(await host.boundingBox())!;
  const move=(x:number,y:number)=>page.mouse.move(box.x+30+x,box.y+30+y);
  await move(110,100);await page.mouse.down();
  await move(200,214);await move(200,216);await move(200,220);
  expect(await host.evaluate((el:any)=>el._cyreg.cy.getElementById('moving').position().y)).toBeCloseTo(220,4);
  await move(200,222);
  const y=await host.evaluate((el:any)=>el._cyreg.cy.getElementById('moving').position().y);
  expect(y).toBeGreaterThan(220);expect(y).toBeLessThan(221);
  const horizontal=await page.locator('.netops-align-guides line').evaluateAll(lines=>lines.filter(line=>line.getAttribute('y1')===line.getAttribute('y2')).map(line=>(Number(line.getAttribute('y1'))-30)));
  expect(horizontal).toHaveLength(1);
  expect([190,220,250]).toContain(horizontal[0]);
  await page.mouse.up();
});
