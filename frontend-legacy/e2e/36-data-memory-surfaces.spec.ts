import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

/*
 * Visual and interaction evidence for the data-management and long-term-memory
 * surfaces. Seeds a known state through the API, then walks every tab in both
 * themes, at desktop and narrow widths, with reduced motion. Screenshots are
 * written to the test output (uploaded by CI as frontend-browser-validation);
 * the assertions hold the layout and keyboard contracts the screenshots show.
 */

const stamp = Date.now();

async function seed(api: APIRequestContext) {
  const files = [
    [`巡检记录-${stamp}.md`, 'text/markdown', '# 巡检记录\n核心交换机端口状态正常。\n'],
    [`设备清单-${stamp}.csv`, 'text/csv', '设备,地址\n核心-01,192.0.2.1\n汇聚-02,192.0.2.2\n'],
    [`原始抓包-${stamp}.bin`, 'application/octet-stream', '\u0000\u0001\u0002'],
  ] as const;
  for (const [name, mimeType, body] of files) {
    const response = await api.post('/api/workspaces/default/artifacts/upload', { multipart: { file: { name, mimeType, buffer: Buffer.from(body) } } });
    expect(response.ok()).toBeTruthy();
  }
  const write = (data: Record<string, unknown>) => api.post('/api/memory/write', { data: { workspace_id: 'default', ...data } });
  const active = await write({ title: `变更窗口约定-${stamp}`, content: '生产变更只在周二、周四 22:00 后执行，执行前核对工单。', memory_type: 'core_rule', user_confirmed: true });
  expect(active.ok()).toBeTruthy();
  const original = (await active.json()).memory_id;
  await write({ title: `变更窗口约定候选-${stamp}`, content: '生产变更窗口调整为每晚 23:00 后。', memory_type: 'core_rule', supersedes_memory_id: original });
  await write({ title: `个人偏好-${stamp}`, content: '回答使用中文，先给结论。', memory_type: 'semantic_fact', scope: 'global', user_confirmed: true });
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  if (await page.locator('html').getAttribute('data-theme') !== theme) {
    await page.getByRole('button', { name: '切换主题', exact: true }).click();
  }
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function noHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
}

test.describe.configure({ mode: 'serial' });

test('36. data management tabs hold layout in both themes and at narrow width', async ({ page, api }, testInfo) => {
  await seed(api);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/data');
  await expect(page.getByTestId('page-data-center')).toBeVisible();
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    for (const tab of ['overview', 'files', 'artifacts', 'relations', 'lifecycle']) {
      await page.getByTestId(`data-tab-${tab}`).click();
      await expect(page.getByTestId(`data-tab-${tab}`)).toHaveAttribute('aria-selected', 'true');
      await noHorizontalOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`data-${tab}-${theme}-1440.png`) });
    }
  }
  await setTheme(page, 'light');
  await page.getByTestId('data-tab-files').click();
  await page.getByRole('button', { name: new RegExp(`设备清单-${stamp}`) }).click();
  await expect(page.getByRole('link', { name: '下载原件' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('data-files-detail-light-1440.png') });
  const selectAll = page.getByRole('checkbox', { name: '选择当前页全部文件' });
  await selectAll.check();
  const bulk = page.getByRole('group', { name: '批量操作' });
  await expect(bulk).toContainText('将移入回收站，可恢复');
  await expect(bulk.getByRole('button', { name: /^处理已选 \d+ 项$/ })).toBeEnabled();
  await bulk.getByRole('button', { name: '清除选择' }).click();
  await expect(bulk).toHaveCount(0);
  await expect(selectAll).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await noHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('data-files-detail-light-390.png'), fullPage: true });
  await page.getByTestId('data-tab-overview').click();
  await noHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('data-overview-light-390.png'), fullPage: true });
});

test('36. memory list, detail disclosure and selection hold layout in both themes', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/memory');
  await expect(page.locator('.memory-page')).toBeVisible();
  const row = page.getByRole('button', { name: `变更窗口约定-${stamp}`, exact: true });
  await expect(row).toBeVisible();
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    await noHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`memory-list-${theme}-1440.png`) });
  }
  await setTheme(page, 'light');
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await page.screenshot({ path: testInfo.outputPath('memory-detail-light-1440.png') });
  await page.getByRole('checkbox', { name: `选择记忆：个人偏好-${stamp}` }).check();
  await page.screenshot({ path: testInfo.outputPath('memory-selection-light-1440.png') });
  const deleteSelected = page.getByRole('button', { name: '删除 1 条', exact: true });
  await deleteSelected.click();
  const dialog = page.getByRole('dialog', { name: '永久删除选中的 1 条记忆？' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('memory-confirm-light-1440.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(deleteSelected).toBeFocused();
  await expect(page.getByRole('button', { name: `个人偏好-${stamp}`, exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: `选择记忆：个人偏好-${stamp}` }).uncheck();
  await page.setViewportSize({ width: 390, height: 844 });
  await noHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('memory-list-light-390.png'), fullPage: true });
});
