import { test, expect } from './fixtures';

const drawing = {
  topology_id: 'theme-colors', name: '连线颜色验收', version: 1, description: '',
  nodes: [
    { node_id: 'a', display_name: 'A', device_type: 'switch', x: 100, y: 100 },
    { node_id: 'b', display_name: 'B', device_type: 'router', x: 450, y: 100 },
  ],
  links: [
    { link_id: 'up', status: 'up' },
    { link_id: 'down', status: 'down' },
    { link_id: 'unknown', status: 'unknown' },
    { link_id: 'custom', status: 'up', style: { color: '#2563eb', width: 5 } },
  ].map(link => ({ ...link, source_node_id: 'a', target_node_id: 'b', source_interface: '', target_interface: '', kind: 'physical' })),
  groups: [], canvas_items: [],
};
const expected = ['rgb(102,113,122)', 'rgb(102,113,122)', 'rgb(102,113,122)', 'rgb(37,99,235)'];

for (const initial of ['light', 'dark']) {
  test(`30. topology link colours survive theme switches and selection from ${initial}`, async ({ page }, testInfo) => {
    const saves: Array<{ links: unknown[] }> = [];
    await page.route('**/api/extensions/network.operations/topologies**', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'PUT') {
        const body = JSON.parse(request.postData() || '{}');
        saves.push(body);
        return route.fulfill({ json: { ok: true, topology: { ...drawing, ...body, version: 2 } } });
      }
      return route.fulfill({ json: url.pathname.endsWith('/revisions') ? { revisions: [] }
        : url.pathname.endsWith('/theme-colors') ? { topology: drawing } : { topologies: [drawing] } });
    });
    await page.goto('/topology?topology=theme-colors');
    const host = page.locator('.netops-cytoscape').first();
    await expect.poll(() => host.evaluate((el: any) => el._cyreg?.cy?.edges().length)).toBe(4);
    if (await page.locator('html').getAttribute('data-theme') !== initial) {
      await page.getByRole('button', { name: '切换主题', exact: true }).click();
    }
    const colours = () => host.evaluate((el: any) => ['up', 'down', 'unknown', 'custom'].map(id => {
      const edge = el._cyreg.cy.getElementById(id);
      return ['line-color', 'source-arrow-color', 'target-arrow-color'].map(property => edge.style(property));
    }));
    for (let pass = 0; pass < 4; pass++) {
      await expect.poll(colours).toEqual(expected.map(colour => [colour, colour, colour]));
      await host.evaluate((el: any) => { el._cyreg.cy.edges().select(); });
      await expect.poll(colours).toEqual(expected.map(colour => [colour, colour, colour]));
      expect(await host.evaluate((el: any) => parseFloat(el._cyreg.cy.getElementById('custom').style('width')))).toBe(6.5);
      await host.evaluate((el: any) => { el._cyreg.cy.elements().unselect(); });
      await page.screenshot({ path: testInfo.outputPath(`${initial}-pass-${pass}.png`) });
      await page.getByRole('button', { name: '切换主题', exact: true }).click();
    }
    await expect.poll(colours).toEqual(expected.map(colour => [colour, colour, colour]));
    expect(saves).toHaveLength(0);
    // A real edit enables Save; changing the theme alone must leave the drawing clean.
    const position = await host.evaluate((el: any) => el._cyreg.cy.getElementById('a').renderedPosition());
    const box = (await host.boundingBox())!;
    await page.mouse.move(box.x + position.x, box.y + position.y);
    await page.mouse.down();
    await page.mouse.move(box.x + position.x + 45, box.y + position.y + 30, { steps: 10 });
    await page.mouse.up();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(() => saves.length).toBeGreaterThan(0);
    expect(saves.at(-1)!.links).toEqual(drawing.links);
  });
}
