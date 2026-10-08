/** E2E 37 — global shell: framed workspace, keyboard jump list, header menus, density and the phone shell. */
import { test, expect } from "./fixtures";

test("37. desktop shell stays keyboard reachable in both themes", async ({ page, api }) => {
  const created = await api.post("/api/sessions", { data: { workspace_id: "default", title: "全局外壳跳转检查" } });
  const sessionId = String((await created.json()).session.session_id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/data");
  await expect(page.getByTestId("page-data-center")).toBeVisible();
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) await page.getByRole("button", { name: "切换主题", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    // The routed page is one sheet inside the frame; header and sidebar sit on the frame.
    const frame = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>("#main")!;
      const css = getComputedStyle(main);
      return { radius: parseFloat(css.borderTopLeftRadius), overflow: document.documentElement.scrollWidth - innerWidth };
    });
    expect(frame.radius).toBeGreaterThan(0);
    expect(frame.overflow).toBeLessThanOrEqual(1);
  }

  // Ctrl+K opens the jump list from anywhere; it only navigates.
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "快速跳转" });
  await expect(palette).toBeVisible();
  const input = page.getByRole("combobox", { name: "搜索页面、会话或偏好" });
  await expect(input).toBeFocused();
  await input.fill("全局外壳");
  await expect(page.getByRole("option", { name: /全局外壳跳转检查/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/workbench/);
  await expect(page.getByTestId(`sess-${sessionId}`)).toHaveClass(/active/);
  // Opened from its trigger, Escape returns focus to that trigger.
  await page.getByTestId("btn-command-palette").click();
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
  await expect(page.getByTestId("btn-command-palette")).toBeFocused();

  // Account menu: density preference, closes on Escape back to its trigger.
  const account = page.getByTestId("btn-account-menu");
  await account.click();
  await page.getByRole("button", { name: "紧凑", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  await page.keyboard.press("Escape");
  await expect(page.locator(".app-account")).not.toHaveAttribute("open", "");
  await expect(account).toBeFocused();
  await account.click();
  await page.getByRole("button", { name: "舒适", exact: true }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-density", "compact");
  // An outside press closes the open header menu.
  await page.locator("#main").click({ position: { x: 300, y: 300 } });
  await expect(page.locator(".app-account")).not.toHaveAttribute("open", "");
});

test("37b. phone shell keeps every route reachable from the drawer", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/workbench");
  await expect(page.getByTestId("btn-mobile-nav")).toBeVisible();
  for (const label of ["切换主题", "功能描述", "退出登录"]) await expect(page.getByRole("button", { name: label, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.getByTestId("btn-mobile-nav").click();
  const drawer = page.getByTestId("layout-left");
  await expect(drawer.getByRole("navigation", { name: "页面导航", exact: true })).toBeVisible();
  for (const label of ["工作台", "任务", "网络拓扑"]) await expect(drawer.getByRole("link", { name: label }).first()).toBeVisible();
  await expect(drawer.getByRole("navigation", { name: "设置页面导航" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("btn-mobile-nav")).toHaveAttribute("aria-expanded", "false");
  // Reduced motion: shell transitions collapse to (near) zero.
  const duration = await page.locator(".app-sidebar").evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
  expect(duration).toBeLessThanOrEqual(0.01);
});
