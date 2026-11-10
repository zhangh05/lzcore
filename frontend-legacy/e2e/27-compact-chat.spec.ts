import { test, expect } from './fixtures';

test('27. compact composer and markdown keep text dense without losing controls or code whitespace', async ({ page, api }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const created = await api.post('/api/sessions', { data: { workspace_id: 'default', title: '紧凑输入与正文验收' } });
  const id = (await created.json()).session.session_id;
  await page.route('**/api/workbench/skills**', route => route.fulfill({ json: { skills: [] } }));
  await page.routeWebSocket('**/ws/agent', socket => socket.onMessage(raw => {
    const frame = JSON.parse(String(raw));
    if (frame.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
    if (frame.type === 'message') socket.send(JSON.stringify({ type: 'done', session_id: id,
      client_request_id: frame.metadata.client_request_id, seq: 1, turn_id: 'compact-turn', trace_id: 'compact-trace',
      final_response: '| 层级 | 节点 |\n| --- | --- |\n| Spine | 四个节点 |\n\n### 布局关键变化\n\n- `zone_core` 移到 (600, 300)，与汇聚区上下分离\n\n- `zone_agg` 六台汇聚交换机一行排开\n\n- `zone_acc` 办公与研发接入分三排\n\n```text\ninterface GigabitEthernet1/0/1\n  description 保留缩进\n```',
      metadata: { execution_outcome: 'complete' } }));
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/workbench');
  await page.getByTestId(`sess-btn-${id}`).click();
  const input = page.getByTestId('chat-input');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await input.fill('短输入');
    await input.scrollIntoViewIfNeeded();
    const row = await page.locator('.wb-input-row').boundingBox();
    const text = await input.boundingBox();
    const attach = await page.getByRole('button', { name: '添加文件', exact: true }).boundingBox();
    const send = await page.getByTestId('btn-send').boundingBox();
    expect(row!.height).toBeLessThanOrEqual(70);
    expect(text!.x + text!.width).toBeLessThanOrEqual(attach!.x);
    expect(Math.abs(attach!.y - send!.y)).toBeLessThanOrEqual(1);
    expect(send!.y + send!.height).toBeLessThanOrEqual(row!.y + row!.height);
    expect(row!.y).toBeGreaterThanOrEqual(0);
    expect(row!.y + row!.height).toBeLessThanOrEqual(900);
    await expect(page.getByTestId('btn-send')).toBeInViewport();
    await input.fill(Array(8).fill('多行文本输入继续增长').join('\n'));
    expect((await input.boundingBox())!.height).toBeGreaterThan(text!.height);
    expect((await input.boundingBox())!.height).toBeLessThanOrEqual(141);
    await input.fill('检查布局关键变化');
    await input.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`composer-${width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId('btn-send').click();
  const body = page.getByTestId('chat-assistant').locator('.markdown-body');
  await expect(body.locator('li')).toHaveCount(3);
  await expect(body).toHaveCSS('white-space', 'normal');
  const gaps = await body.locator('li').evaluateAll(items => items.slice(1).map((item, index) =>
    item.getBoundingClientRect().top - items[index].getBoundingClientRect().bottom));
  for (const gap of gaps) expect(gap).toBeLessThanOrEqual(8);
  const heading = await body.locator('h3').boundingBox();
  const list = await body.locator('ul').first().boundingBox();
  expect(list!.y - heading!.y - heading!.height).toBeLessThanOrEqual(20);
  await expect(body.locator('pre')).toHaveCSS('white-space', 'pre-wrap');
  await expect(body.locator('pre')).toContainText('  description 保留缩进');
  await expect(page.getByTestId('chat-input')).toHaveValue('');
  await page.screenshot({ path: testInfo.outputPath('compact-conversation.png') });
});

test('27b. drawing composer keeps the instruction and send control on one row', async ({ page, api }, testInfo) => {
  const created = await api.post('/api/extensions/network.operations/topologies?workspace_id=default', { data: {
    name: '紧凑绘图输入验收', nodes: [], links: [], canvas_items: [], groups: [],
  } });
  expect(created.ok()).toBeTruthy();
  const id = (await created.json()).topology.topology_id;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/topology?topology=${id}`);
  await page.getByRole('button', { name: '绘图对话', exact: true }).click();
  const input = page.getByRole('textbox', { name: '拓扑协作指令', exact: true });
  await input.fill('移动核心区');
  const row = await page.locator('.topology-agent-input-row').boundingBox();
  const text = await input.boundingBox();
  const send = await page.locator('.topology-agent-send-btn').boundingBox();
  expect(row!.height).toBeLessThanOrEqual(44);
  expect(text!.x + text!.width).toBeLessThanOrEqual(send!.x);
  expect(Math.abs(text!.y - send!.y)).toBeLessThanOrEqual(1);
  await expect(page.getByLabel('允许修改拓扑', { exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('compact-drawing-composer.png') });
});
