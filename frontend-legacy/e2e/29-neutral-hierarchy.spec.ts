import { test, expect } from './fixtures';

test('29. graphite surfaces keep selection and success distinct during an active conversation', async ({ page, api }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const created = await api.post('/api/sessions', { data: { workspace_id: 'default', title: '颜色与视觉层次验收' } });
  const id = (await created.json()).session.session_id;
  let complete: (() => void) | undefined;
  await page.route('**/api/agent/llm/status', route => route.fulfill({ json: { enabled: true, connected: true, model: '隔离视觉适配器', provider: 'test' } }));
  await page.routeWebSocket('**/ws/agent', socket => socket.onMessage(raw => {
    const frame = JSON.parse(String(raw));
    if (frame.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
    if (frame.type === 'message') {
      const context = { session_id: id, client_request_id: frame.metadata.client_request_id };
      socket.send(JSON.stringify({ ...context, type: 'token', seq: 1, content: '正在核对核心设备、区域成员与连接关系。' }));
      complete = () => socket.send(JSON.stringify({ ...context, type: 'done', seq: 2,
        final_response: '## 核对结果\n\n设备归属与图纸连线一致。\n\n- 核心区：两台交换机\n- 接入区：四台交换机\n\n此结果为隔离视觉验收数据。',
        turn_id: 'neutral-turn', trace_id: 'neutral-trace', metadata: { execution_outcome: 'complete' } }));
    }
  }));
  await page.goto('/workbench');
  await page.getByTestId(`sess-btn-${id}`).click();
  await page.getByTestId('chat-input').fill('核对核心区与接入区');
  await page.getByTestId('btn-send').click();
  await expect(page.getByTestId('btn-stop')).toBeVisible();
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: '切换主题', exact: true }).click();
    const palette = await page.evaluate(() => {
      const probe = document.createElement('div'); document.body.append(probe);
      const rgb = (token: string) => {
        probe.style.color = `var(${token})`;
        return getComputedStyle(probe).color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      };
      const hue = (c: number[]) => {
        const [r, g, b] = c, max = Math.max(...c), min = Math.min(...c), delta = max - min;
        const h = max === r ? ((g-b)/delta)%6 : max === g ? (b-r)/delta+2 : (r-g)/delta+4;
        return (h*60+360)%360;
      };
      const neutral = ['--bg', '--surface', '--surface-2', '--surface-3', '--line', '--line-2', '--text-3', '--text-4'].map(token => ({ token, c: rgb(token) }));
      const accent = rgb('--accent'), success = rgb('--ok');
      const delta = Math.abs(hue(accent)-hue(success));
      const user = rgb('--message-user'), selected = rgb('--surface-selected');
      probe.remove();
      return { neutral, accent, hueGap: Math.min(delta, 360-delta), user, selected };
    });
    expect(palette.accent).toEqual(theme === 'light' ? [15,119,115] : [124,201,188]);
    for (const { token, c } of palette.neutral) expect(Math.max(...c)-Math.min(...c), token).toBeLessThanOrEqual(24);
    expect(palette.hueGap).toBeGreaterThanOrEqual(35);
    expect(palette.user).not.toEqual(palette.selected);
    await expect(page.locator('.sidebar-new-session')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(page.locator('.wb-chat-list')).toHaveCSS('scrollbar-width', 'auto');
    expect(await page.locator('.wb-chat-list').evaluate(el => getComputedStyle(el, '::-webkit-scrollbar').width)).toBe('6px');
    await expect(page.locator('.chat-bubble.user')).toHaveCSS('background-color', `rgb(${palette.user.join(', ')})`);
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getTiming().iterations)).length)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`running-${theme}.png`) });
  }
  complete!();
  await expect(page.getByTestId('chat-assistant')).toContainText('隔离视觉验收数据');
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: '切换主题', exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getTiming().iterations)).length)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`result-${theme}.png`) });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.locator('.message-row').last().evaluate(el => parseFloat(getComputedStyle(el).animationDuration))).toBeLessThanOrEqual(0.001);
});
