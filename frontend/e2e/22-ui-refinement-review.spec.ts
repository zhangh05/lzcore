import { test, expect } from "./fixtures";

test("22. memory disclosure is keyboard accessible and survives extension navigation", async ({ page, api }, testInfo) => {
  const created = await api.post("/api/memory/write", { data: {
    workspace_id: "default", title: "UI 审核记忆", content: "设备操作前核对范围。",
    memory_type: "knowledge_note", user_confirmed: true,
  } });
  expect(created.ok()).toBeTruthy();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/memory");
  const toggle = page.getByRole("button", { name: "UI 审核记忆", exact: true });
  await expect(toggle).toBeVisible();
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.locator(".memory-card-detail pre").filter({ hasText: "设备操作前核对范围。" }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({ path: testInfo.outputPath("memory-keyboard-light.png") });
  await page.getByRole("button", { name: "切换主题", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("memory-keyboard-dark.png") });

  // A generic product modal must not pick up extension CSS after SPA navigation.
  const probe = () => page.evaluate(() => {
    const element = document.createElement("div");
    element.className = "modal-header";
    document.body.append(element);
    const css = getComputedStyle(element);
    const value = [css.marginBottom, css.paddingBottom, css.borderBottomWidth, css.justifyContent];
    element.remove();
    return value;
  });
  const before = await probe();
  await page.getByTestId("nav-group-topology").click();
  await expect(page.locator(".network-admin")).toBeVisible();
  expect(await probe()).toEqual(before);
  expect(errors).toEqual([]);
});

test("22b. topology page is a drawing canvas and does not load device state", async ({ page }, testInfo) => {
  const topology = { topology_id: "review-topology", name: "图纸验收", description: "", version: 1,
    nodes: [{ node_id: "review-node", display_name: "审核节点", x: 100, y: 100 }],
    links: [], groups: [], canvas_items: [],
  };
  const deviceHits: string[] = [];
  await page.route("**/api/extensions/network.operations/devices**", route => {
    deviceHits.push(route.request().url());
    return route.fulfill({ json: { devices: [] } });
  });
  await page.route("**/api/extensions/network.operations/topologies**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/state") || url.pathname.endsWith("/compare")) {
      return route.fulfill({ status: 404, json: { error: "not_found" } });
    }
    const body = url.pathname.endsWith("/topologies") ? { topologies: [topology] } : { topology };
    await route.fulfill({ json: body });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/topology");
  await expect(page.getByLabel("NetOps 网络画布")).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新状态", exact: true })).toHaveCount(0);
  expect(deviceHits).toEqual([]);
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) {
      await page.getByRole("button", { name: "切换主题", exact: true }).click();
    }
    const surfaces = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.background = "var(--surface)";
      document.body.append(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { expected, actual: [".topology-canvas-toolbar", ".topology-editbar", ".studio-statusbar", ".canvas-search-wrap"].map(selector => getComputedStyle(document.querySelector(selector)!).backgroundColor) };
    });
    expect(surfaces.actual).toEqual(Array(4).fill(surfaces.expected));
    await page.screenshot({ path: testInfo.outputPath(`topology-drawing-${theme}.png`) });
  }
});
