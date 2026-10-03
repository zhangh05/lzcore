import { test, expect } from './fixtures';
import fs from 'node:fs/promises';

const nodes = ['plain', 'success', 'failed', 'trust', 'uncertain', 'missing'].map((id, index) => ({
  node_id: id, display_name: id, device_type: 'switch', x: 120 + index % 3 * 280, y: 140 + Math.floor(index / 3) * 220,
}));
const drawing = { topology_id: 'drawing-semantics', name: '中性图纸与最近证据', version: 1, nodes, groups: [], canvas_items: [],
  links: [
    { link_id: 'default', status: 'unknown' },
    { link_id: 'black', status: 'down', style: { color: '#000000', width: 6, line_style: 'solid' } },
    { link_id: 'purple', status: 'up', style: { color: '#8b5cf6' } },
  ].map(link => ({ ...link, source_node_id: 'plain', target_node_id: 'success', source_interface: '', target_interface: '', kind: 'physical', source: 'manual' })) };
const overlays = nodes.filter(node => node.node_id !== 'plain').map(node => ({ node_id: node.node_id, device_id: node.node_id, device_state: node.node_id === 'missing' ? 'missing' : 'bound', device: { name: node.node_id }, observation: null,
  connection: { status: ({ success: 'connected', failed: 'failed', trust: 'trust_required', uncertain: 'unknown', missing: 'untested' } as Record<string, string>)[node.node_id], last_tested_at: '2026-10-03T01:00:00Z' } }));

test('31. drawing colours, inspector, contrast and observation markers remain independent', async ({ page }, testInfo) => {
  let persisted = structuredClone(drawing);
  const saves: any[] = [];
  await page.route('**/api/extensions/network.operations/topologies**', route => {
    const request = route.request(); const url = new URL(request.url());
    if (request.method() === 'PUT') { const body = JSON.parse(request.postData() || '{}'); saves.push(body); persisted = { ...persisted, ...body }; return route.fulfill({ json: { ok: true, topology: persisted } }); }
    return route.fulfill({ json: url.pathname.endsWith('/overlay') ? { overlays } : url.pathname.endsWith('/revisions') ? { revisions: [] }
      : url.pathname.endsWith('/drawing-semantics') ? { topology: persisted } : { topologies: [persisted] } });
  });
  await page.goto('/topology?topology=drawing-semantics');
  const host = page.locator('.netops-cytoscape').first();
  await expect.poll(() => host.evaluate((el: any) => el._cyreg?.cy?.edges().length)).toBe(3);
  const appearances = () => host.evaluate((el: any) => {
    const cy = el._cyreg.cy;
    return { border: cy.getElementById('plain').style('border-color'), states: ['plain', 'success', 'failed', 'trust', 'uncertain', 'missing'].map(id => cy.getElementById(id).data('observationStatus')),
      colours: ['default', 'black', 'purple'].map(id => cy.getElementById(id).style('line-color')), contrast: Number(cy.getElementById('black').style('underlay-opacity')) };
  });
  await expect.poll(async () => (await appearances()).states).toEqual([null, 'ok', 'error', 'warning', 'unknown', 'warning']);
  // Evidence marker has actual pixels, not only a data flag; toggling clears it.
  const markerAlpha = () => page.evaluate(() => {
    const host = document.querySelector('.netops-cytoscape') as any; const cy = host._cyreg.cy;
    const canvas = document.querySelector('.netops-motion-overlay') as HTMLCanvasElement;
    const position = cy.getElementById('success').renderedPosition(); const zoom = cy.zoom();
    const dpr = window.devicePixelRatio;
    return canvas.getContext('2d')!.getImageData(Math.round((position.x + 38 * zoom) * dpr), Math.round((position.y - 30 * zoom - 3) * dpr), 1, 1).data[3];
  });
  await expect.poll(markerAlpha).toBeGreaterThan(0);
  await page.getByRole('checkbox', { name: '最近观测', exact: true }).uncheck();
  await expect.poll(async () => (await appearances()).states).toEqual([null, null, null, null, null, null]);
  await expect.poll(markerAlpha).toBe(0);
  await page.getByRole('checkbox', { name: '最近观测', exact: true }).check();
  for (const theme of ['light', 'dark', 'light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: '切换主题', exact: true }).click();
    await expect.poll(async () => (await appearances()).colours).toEqual(['rgb(102,113,122)', 'rgb(0,0,0)', 'rgb(139,92,246)']);
    expect((await appearances()).border).toBe('rgb(138,148,158)');
    await expect.poll(async () => (await appearances()).contrast).toBe(theme === 'dark' ? 0.8 : 0);
    await page.waitForTimeout(200);
    if (theme === 'dark') {
      // Cytoscape underlay padding is HALF its full width; check real pixels
      // outside the black core, not merely the computed opacity property.
      const visibleOutline = await host.evaluate((el: any) => {
        const midpoint = el._cyreg.cy.getElementById('black').renderedMidpoint();
        return [...el.querySelectorAll('canvas')].some((canvas: any) => {
          const ctx = canvas.getContext('2d');
          if (!ctx) return false;
          const scale = canvas.width / el.clientWidth;
          for (let offset = 3; offset <= 5; offset++) {
            const rgb = ctx.getImageData(Math.round(midpoint.x * scale), Math.round((midpoint.y + offset) * scale), 1, 1).data;
            if (rgb[0] > 100 && rgb[1] > 100 && rgb[2] > 100 && rgb[3] > 100) return true;
          }
          return false;
        });
      });
      expect(visibleOutline).toBeTruthy();
    }
    await page.screenshot({ path: testInfo.outputPath(`drawing-${theme}.png`) });
  }
  expect(saves).toHaveLength(0);
  await host.evaluate((el: any) => { el._cyreg.cy.getElementById('default').emit('tap'); });
  const picker = page.getByLabel('自定义拾色器');
  await expect(picker).toHaveValue('#66717a');
  await expect(page.getByTestId('link-color-source')).toHaveText('默认 · #66717a');
  const hex = page.getByLabel('连线 Hex 颜色');
  await hex.fill('#0'); await hex.press('Tab');
  await expect(page.getByRole('alert')).toContainText('完整的 Hex');
  expect((await appearances()).colours[0]).toBe('rgb(102,113,122)');
  expect(saves).toHaveLength(0);
  await hex.fill('#1262aa'); await hex.press('Enter');
  await expect(picker).toHaveValue('#1262aa');
  await expect(page.getByTestId('link-color-source')).toHaveText('自定义 · #1262aa');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => saves.length).toBe(1);
  await page.reload();
  await expect.poll(() => host.evaluate((el: any) => el._cyreg?.cy?.edges().length)).toBe(3);
  await host.evaluate((el: any) => { el._cyreg.cy.getElementById('black').emit('tap'); });
  await expect(picker).toHaveValue('#000000');
  await page.getByRole('button', { name: '恢复默认颜色', exact: true }).click();
  await expect(picker).toHaveValue('#66717a');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves.at(-1).links.find((link: any) => link.link_id === 'black').style).toEqual({ width: 6, line_style: 'solid' });
  await page.getByRole('button', { name: '黑色', exact: true }).click();
  await expect(picker).toHaveValue('#000000');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => saves.length).toBe(3);
  await page.locator('.studio-more summary').click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 SVG', exact: true }).click();
  const svg = await fs.readFile((await (await download).path())!, 'utf8');
  expect(svg).toContain('stroke="#000000"'); expect(svg).toContain('stroke="#8a949e"');
  expect(svg).toContain('stroke="#1262aa"'); expect(svg).toContain('stroke="#8b5cf6"');
  expect(svg).not.toContain('最近连接'); expect(svg).not.toContain('underlay');
  for (const format of ['PNG', 'PDF']) {
    await page.locator('.studio-more summary').click();
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: `导出 ${format}`, exact: true }).click();
    const bytes = await fs.readFile((await (await pending).path())!);
    if (format === 'PDF') expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    else {
      expect(bytes.subarray(1, 4).toString()).toBe('PNG');
      const counts = await page.evaluate(async base64 => {
        const image = new Image(); image.src = 'data:image/png;base64,' + base64;
        await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const counts = [0, 0, 0];
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] === 0 && pixels[i + 1] === 0 && pixels[i + 2] === 0) counts[0]++;
          if (pixels[i] === 139 && pixels[i + 1] === 92 && pixels[i + 2] === 246) counts[1]++;
          if (pixels[i] === 138 && pixels[i + 1] === 148 && pixels[i + 2] === 158) counts[2]++;
        }
        return counts;
      }, bytes.toString('base64'));
      counts.forEach(count => expect(count).toBeGreaterThan(0));
    }
  }

});
