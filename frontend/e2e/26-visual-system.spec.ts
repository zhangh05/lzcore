import { test, expect } from './fixtures';

const surfaces = [
  ['/workbench', '.wb-shell'], ['/runs', '.operations-page'], ['/data', '.data-center'],
  ['/knowledge', '.knowledge-library'], ['/memory', '.memory-page'], ['/diagnostics', '.diagnostics-page'],
  ['/settings', '.settings-page'], ['/users', '.user-management'],
  ['/extensions/network.operations/manage?tab=devices', '.network-admin'],
  ['/extensions/network.operations/manage?tab=skills', '.network-admin'], ['/topology', '.topology-route'],
] as const;

test('26d. YaHei is scoped to Windows desktop and preserves web, other hosts and code fonts', async ({ page }) => {
  await page.goto('/workbench');
  const base = await page.evaluate(() => ({
    sans: getComputedStyle(document.body).fontFamily,
    mono: getComputedStyle(document.documentElement).getPropertyValue('--font-mono'),
  }));
  await expect(page.locator('html')).not.toHaveAttribute('data-desktop-platform');
  await page.addInitScript(() => {
    const platform = new URL(location.href).searchParams.get('fontPlatform');
    if (platform) window.__LZCORE_DESKTOP__ = { platform, theme: 'light', ui: {} };
  });
  for (const platform of ['darwin', 'linux', 'win32']) {
    await page.goto(`/workbench?fontPlatform=${platform}`);
    const actual = await page.evaluate(() => ({
      platform: document.documentElement.dataset.desktopPlatform,
      sans: getComputedStyle(document.body).fontFamily,
      mono: getComputedStyle(document.documentElement).getPropertyValue('--font-mono'),
    }));
    expect(actual.mono).toBe(base.mono);
    if (platform === 'win32') {
      expect(actual.platform).toBe('win32');
      expect(actual.sans).toBe('"Microsoft YaHei UI", "Microsoft YaHei", sans-serif');
    } else {
      expect(actual.platform).toBeUndefined();
      expect(actual.sans).toBe(base.sans);
    }
  }
});

for (const width of [1440, 900, 390]) {
  test(`26. visual system remains readable and contained at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const theme of ['light', 'dark']) {
      for (const [route, selector] of surfaces) {
        await page.goto(route);
        await expect(page.locator(selector)).toBeVisible();
        if (await page.locator('html').getAttribute('data-theme') !== theme) {
          await page.getByRole('button', { name: '切换主题', exact: true }).click();
        }
        // Wait for lazy route content, not a timed screenshot of its fade-in.
        await expect(page.locator('.route-loading')).toHaveCount(0);
        const check = await page.evaluate(() => {
          const rgb = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
          const luminance = (color: string) => rgb(color).map(c => {
            c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
          const ratio = (a: string, b: string) => {
            const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
            return (values[0] + 0.05) / (values[1] + 0.05);
          };
          const probe = document.createElement('div');
          document.body.append(probe);
          const value = (token: string, property: 'color' | 'backgroundColor') => {
            probe.style[property] = `var(${token})`; return getComputedStyle(probe)[property];
          };
          const contrast = ['--text', '--text-2', '--text-3', '--text-4'].flatMap(text =>
            ['--bg', '--surface', '--surface-2', '--surface-3', '--message-user'].map(bg => ({
              text, bg, ratio: ratio(value(text, 'color'), value(bg, 'backgroundColor')),
            })));
          const semantic = ['accent', 'ok', 'warn', 'danger', 'info', 'unknown'].flatMap(name => [
            { text: `--${name}-text`, bg: `--${name}`, ratio: ratio(value(`--${name}-text`, 'color'), value(`--${name}`, 'backgroundColor')) },
            { text: `--${name}`, bg: `--${name}-soft`, ratio: ratio(value(`--${name}`, 'color'), value(`--${name}-soft`, 'backgroundColor')) },
          ]);
          const boundary = ratio(value('--field-border', 'color'), value('--field', 'backgroundColor'));
          probe.remove();
          return { contrast: [...contrast, ...semantic], boundary, overflow: document.documentElement.scrollWidth - innerWidth,
            zoom: getComputedStyle(document.body).zoom,
            unlayered: [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]).filter(rule => rule.constructor.name === 'CSSStyleRule').length };
        });
        for (const color of check.contrast) expect(color.ratio, `${route} ${theme} ${color.text} on ${color.bg}`).toBeGreaterThanOrEqual(4.5);
        expect(check.boundary, `${route} ${theme} field boundary`).toBeGreaterThanOrEqual(3);
        expect(check.overflow, route).toBeLessThanOrEqual(1);
        expect(['1', 'normal']).toContain(check.zoom);
        expect(check.unlayered, route).toBe(0);
        await page.screenshot({ path: testInfo.outputPath(`${route.replace(/[/?=]/g, '_')}-${theme}.png`) });
      }
      await page.goto('/workbench');
      await page.getByRole('button', { name: '功能描述', exact: true }).click();
      await expect(page.getByTestId('feature-description-drawer')).toBeVisible();
      await expect(page.locator('.cc-in-drawer')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`capabilities-drawer-${theme}.png`) });
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('feature-description-drawer')).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
}

test('26b. desktop modal keeps focus and actions within a short narrow window', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.__LZCORE_DESKTOP__ = { theme: 'dark', ui: {} };
    Object.assign(window, { pywebview: { api: {
      get_info: async () => ({ ok: true, admin: false, version: 'visual-test', commit: 'isolated', mode: 'portable',
        data_dir: 'C:\\联智中枢\\验收数据', signed: false, webview2: 'test adapter', active_jobs: 0, dirty: false,
        tray: true, restore: '', shutdown: { status: 'idle' }, settings: {}, update: { status: 'idle' } }),
      save_preferences: async () => ({ ok: true }), report_state: async () => ({ ok: true }),
    } } });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 600 });
    await page.goto('/workbench');
    const trigger = page.getByRole('button', { name: '桌面设置', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '桌面设置', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('验收数据');
    await expect(dialog.locator('.modal-header')).toHaveCSS('border-bottom-width', '0px');
    await expect(dialog.locator('.modal-footer')).toHaveCSS('border-top-width', '0px');
    await expect(dialog.locator('.modal-title')).toHaveCSS('font-weight', '600');
    expect(await dialog.locator('.desktop-dialog-body').evaluate(el => getComputedStyle(el, '::-webkit-scrollbar').width)).toBe('6px');
    expect(await dialog.locator('.desktop-dialog-body').evaluate(el => getComputedStyle(el, '::-webkit-scrollbar-button').display)).toBe('none');
    await page.getByRole('button', { name: '完成', exact: true }).scrollIntoViewIfNeeded();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(600);
    const action = page.getByRole('button', { name: '完成', exact: true });
    await action.focus();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: '关闭对话框' })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`desktop-modal-${width}.png`) });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
});

test('26c. populated conversation, device directory and drawing inspector share both themes', async ({ page, api }, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const created = await api.post('/api/sessions', { data: { workspace_id: 'default', title: '园区网络检查' } });
  expect(created.ok()).toBeTruthy();
  const id = (await created.json()).session.session_id;
  await page.route('**/api/agent/llm/status', route => route.fulfill({ json: { enabled: true, connected: true, model: '视觉验收适配器', provider: 'test' } }));
  await page.routeWebSocket('**/ws/agent', socket => {
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      if (frame.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
      if (frame.type === 'message') socket.send(JSON.stringify({
        type: 'done', session_id: id, client_request_id: frame.metadata.client_request_id, seq: 1,
        final_response: '## 区域与连线检查\n\n已核对图纸中的设备归属与连接关系。\n\n| 区域 | 设备 | 图纸状态 |\n| --- | --- | --- |\n| 核心区 | 核心交换机 | 已连接 |\n| 接入区 | 接入交换机 | 已连接 |\n\n这份结果来自隔离视觉验收数据。',
        turn_id: 'visual-turn', trace_id: 'visual-trace', metadata: { execution_outcome: 'complete' },
      }));
    });
  });
  const topology = { topology_id: 'visual-drawing', name: '园区网络 · 视觉验收', version: 1, description: '',
    nodes: [
      { node_id: 'core', display_name: '核心交换机', device_type: 'switch_core', x: 300, y: 250, region_id: 'region-core' },
      { node_id: 'access', display_name: '接入交换机', device_type: 'switch', x: 650, y: 250, region_id: 'region-access' },
    ], links: [{ link_id: 'uplink', source_node_id: 'core', target_node_id: 'access', source_interface: '10GE1/0/1', target_interface: '10GE1/0/48', kind: 'physical', status: 'unknown' }], groups: [],
    canvas_items: [
      { item_id: 'region-core', kind: 'rectangle', text: '核心区', x: 300, y: 250, width: 220, height: 180, auto_fit: false },
      { item_id: 'region-access', kind: 'rectangle', text: '接入区', x: 650, y: 250, width: 220, height: 180, auto_fit: false },
    ],
  };
  await page.route('**/api/extensions/network.operations/topologies**', route => {
    const url = new URL(route.request().url());
    return route.fulfill({ json: url.pathname.endsWith('/revisions') ? { revisions: [] } : url.pathname.endsWith('/visual-drawing') ? { topology } : { topologies: [topology] } });
  });
  await page.route('**/api/extensions/network.operations/devices**', route => route.fulfill({ json: { devices: [
    { device_id: 'visual-core', name: '核心交换机', host: '192.0.2.10', vendor: 'h3c', device_type: 'switch_core', region_id: '总部' },
    { device_id: 'visual-access', name: '接入交换机', host: '192.0.2.20', vendor: 'h3c', device_type: 'switch', region_id: '总部' },
  ] } }));
  await page.goto('/workbench');
  await page.getByTestId(`sess-btn-${id}`).click();
  await page.getByTestId('chat-input').fill('检查园区图纸的区域与连线');
  await page.getByTestId('btn-send').click();
  await expect(page.getByTestId('chat-assistant')).toContainText('隔离视觉验收数据');
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: '切换主题', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath(`conversation-${theme}.png`) });
  }
  for (const theme of ['light', 'dark']) {
    await page.goto('/extensions/network.operations/manage?tab=devices');
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: '切换主题', exact: true }).click();
    await expect(page.getByText('192.0.2.10 · H3C', { exact: false })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`devices-${theme}.png`) });
    await page.goto('/topology?topology=visual-drawing');
    await expect(page.locator('.netops-cytoscape')).toBeVisible();
    const host = page.locator('.netops-cytoscape');
    await expect.poll(() => host.evaluate((el: any) => el._cyreg?.cy?.getElementById('core').length)).toBe(1);
    await page.waitForTimeout(1200); // wait for initial canvas fit before reading the painted location
    const point = await host.evaluate((el: any) => el._cyreg.cy.getElementById('core').renderedPosition());
    await host.click({ position: point });
    await expect(page.locator('.topology-inspector')).toBeVisible();
    await expect(page.locator('.topology-inspector')).toContainText('核心交换机');
    await page.waitForTimeout(1200); // canvas centring animation is independent of CSS motion
    await page.screenshot({ path: testInfo.outputPath(`drawing-inspector-${theme}.png`) });
  }
});
