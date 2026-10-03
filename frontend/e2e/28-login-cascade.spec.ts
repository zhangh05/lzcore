import { test, expect } from './fixtures';

test.use({ storageState: { cookies: [], origins: [] } });

test('28. login retains panel padding, readable controls and keyboard submission in the production cascade', async ({ page }, testInfo) => {
  await page.goto('/');
  const account = page.getByRole('textbox', { name: '账户', exact: true });
  const password = page.getByLabel('密码', { exact: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(account).toBeVisible();
      const panel = await page.locator('.login-panel').boundingBox();
      const input = await account.boundingBox();
      expect(input!.x - panel!.x).toBeGreaterThanOrEqual(24);
      expect(panel!.x + panel!.width - input!.x - input!.width).toBeGreaterThanOrEqual(24);
      expect(input!.height).toBeLessThanOrEqual(44);
      expect(panel!.width).toBeLessThanOrEqual(440);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      await page.screenshot({ path: testInfo.outputPath(`login-${theme}-${width}.png`) });
    }
  }
  await account.fill('invalid-user');
  await password.fill('invalid-password');
  await password.press('Tab');
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(account).toBeEnabled();
});
