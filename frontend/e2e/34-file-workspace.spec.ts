import { test, expect } from './fixtures';

test('34. knowledge ingestion from the file library reuses its actual original', async ({ page, api }) => {
  const name = `知识原件-${Date.now()}.md`;
  const payload = Buffer.from('# 原始资料\n真实内容\n');
  const upload = await api.post('/api/workspaces/default/artifacts/upload', { multipart: { file: { name, mimeType: 'text/markdown', buffer: payload } } });
  const fid = (await upload.json()).file.file_id;
  await page.goto('/data');
  await page.getByRole('tab', { name: /^文件/ }).click();
  await page.getByPlaceholder('搜索名称、路径或来源').fill(name);
  await page.getByRole('button', { name: new RegExp(name) }).click();
  const ingestion = page.waitForResponse(response => response.url().endsWith('/knowledge/upload') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '加入知识库', exact: true }).click();
  const imported = await ingestion;
  expect(imported.ok()).toBeTruthy();
  const sourceId = (await imported.json()).source.source_id;
  await expect(page).toHaveURL(new RegExp(`/knowledge\\?source_id=${sourceId}`));
  const relationResponse = await api.get(`/api/storage/files/${fid}/relations?workspace_id=default`);
  expect(relationResponse.ok()).toBeTruthy();
  const relations = (await relationResponse.json()).relations;
  expect(relations.file_id).toBe(fid);
  expect(relations.references.some((reference: { owner_type: string; owner_id: string; relation: string }) => reference.owner_type === 'knowledge_source' && reference.owner_id === sourceId && reference.relation === 'source')).toBeTruthy();
  const original = await api.get(`/api/storage/files/${fid}/download?workspace_id=default`);
  expect(Buffer.compare(await original.body(), payload)).toBe(0);
});

test('34. managed originals can be reused and remain isolated between conversations', async ({ page, api }) => {
  const name = `文件复用-${Date.now()}.csv`;
  const uploaded = await api.post('/api/workspaces/default/artifacts/upload', { multipart: { file: { name, mimeType: 'text/csv', buffer: Buffer.from('设备,地址\n测试,192.0.2.1\n') } } });
  expect(uploaded.ok()).toBeTruthy();
  const first = (await (await api.post('/api/sessions', { data: { workspace_id: 'default', title: '文件复用 A' } })).json()).session.session_id;
  const second = (await (await api.post('/api/sessions', { data: { workspace_id: 'default', title: '文件复用 B' } })).json()).session.session_id;
  let extraUploads = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/artifacts/upload')) extraUploads++; });
  await page.goto('/workbench');
  await page.getByTestId(`sess-btn-${first}`).click();
  await page.getByRole('button', { name: '选择已有文件', exact: true }).click();
  await page.getByPlaceholder('搜索文件名或路径').fill(name);
  await page.getByRole('checkbox', { name: new RegExp(name) }).check();
  await page.getByRole('button', { name: '添加 1 个文件', exact: true }).click();
  await expect(page.getByRole('button', { name: `移除 ${name}`, exact: true })).toBeVisible();
  expect(extraUploads).toBe(0);
  await page.getByTestId(`sess-btn-${second}`).click();
  await expect(page.getByRole('button', { name: `移除 ${name}`, exact: true })).toHaveCount(0);
  // No message is sent: this scenario verifies storage and composer behavior only.
});

test('34. file organization and recycling preserve identity and original bytes', async ({ page, api }, testInfo) => {
  const name = `原件核对-${Date.now()}.custom`;
  const payload = Buffer.from([0, 1, 2, 255]);
  const upload = await api.post('/api/workspaces/default/artifacts/upload', { multipart: { file: { name, mimeType: 'application/octet-stream', buffer: payload } } });
  const fid = (await upload.json()).file.file_id;
  await page.goto('/data');
  await page.getByRole('tab', { name: /^文件/ }).click();
  await page.getByPlaceholder('搜索名称、路径或来源').fill(name);
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await page.getByLabel('文件名', { exact: true }).fill('已组织-' + name);
  await page.getByLabel('目录', { exact: true }).fill('核对/资料');
  const organized = page.waitForResponse(response => response.url().includes(`/storage/files/${fid}`) && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  expect((await organized).ok()).toBeTruthy();
  const metadata = (await (await api.get(`/api/storage/files/${fid}?workspace_id=default`)).json()).file;
  expect(metadata.file_id).toBe(fid); expect(metadata.metadata.folder).toBe('核对/资料');
  await page.getByRole('button', { name: new RegExp('已组织-' + name) }).click();
  await page.getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByRole('button', { name: '回收站', exact: true }).click();
  await page.getByRole('button', { name: new RegExp('已组织-' + name) }).click();
  const recovery = page.waitForResponse(response => response.url().includes(`/storage/files/${fid}/restore`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  expect((await recovery).ok()).toBeTruthy();
  const restored = await api.get(`/api/storage/files/${fid}/download?workspace_id=default`);
  expect(Buffer.compare(await restored.body(), payload)).toBe(0);
  await page.getByRole('button', { name: '资料与文件', exact: true }).click();
  await page.getByRole('button', { name: new RegExp('已组织-' + name) }).click();
  await page.screenshot({ path: testInfo.outputPath('file-workspace.png'), fullPage: true });
});
