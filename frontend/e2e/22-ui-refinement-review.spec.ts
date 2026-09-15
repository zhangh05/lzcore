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

test("22b. topology status-only refresh repaints the actual renderer without moving nodes", async ({ page }, testInfo) => {
  let verified = false;
  const topology = { topology_id: "review-topology", name: "状态刷新验收", description: "", version: 1,
    nodes: [{ node_id: "review-node", linked_device_id: "review-device", display_name: "审核节点", x: 100, y: 100 }],
    links: [], groups: [], canvas_items: [],
  };
  await page.route("**/api/extensions/network.operations/devices?**", route => route.fulfill({ json: { devices: [{
    device_id: "review-device", name: "审核节点", host: "192.0.2.1", vendor: "h3c", device_type: "switch", region_id: "",
  }] } }));
  await page.route("**/api/extensions/network.operations/topologies**", async route => {
    const url = new URL(route.request().url());
    const body = url.pathname.endsWith("/state") ? { state: {
      topology_id: topology.topology_id, version: 1, refreshed_at: "2026-09-16T00:00:00Z",
      nodes: [{ node_id: "review-node", device_id: "review-device", observation: null,
        connections: [{ connection_id: "review-connection", device_id: "review-device", protocol: "ssh", port: 22, verified }],
      }],
    } } : url.pathname.endsWith("/topologies") ? { topologies: [topology] } : { topology };
    await route.fulfill({ json: body });
  });
  // Capture the renderer constructed by the application; do not replace it.
  await page.addInitScript(() => {
    let factory: unknown;
    Object.defineProperty(window, "cytoscape", {
      configurable: true,
      get: () => factory,
      set: value => { factory = (options: unknown) => {
        const canvas = value(options);
        (window as unknown as { reviewCanvas: unknown }).reviewCanvas = canvas;
        return canvas;
      }; },
    });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/topology");
  await expect(page.getByLabel("NetOps 网络画布")).toBeVisible();
  const status = () => page.evaluate(() => {
    const canvas = (window as unknown as { reviewCanvas?: { getElementById: (id: string) => { data: (key: string) => unknown } } }).reviewCanvas;
    return canvas?.getElementById("review-node").data("status");
  });
  await expect.poll(status).toBe("error");
  const moved = await page.evaluate(() => {
    const canvas = (window as unknown as { reviewCanvas: { getElementById: (id: string) => { position: (value?: { x: number; y: number }) => { x: number; y: number } } } }).reviewCanvas;
    const node = canvas.getElementById("review-node");
    node.position({ x: 180, y: 160 });
    return node.position();
  });
  verified = true;
  await page.getByRole("button", { name: "刷新状态", exact: true }).click();
  await expect.poll(status).toBe("ok");
  expect(await page.evaluate(() => {
    const canvas = (window as unknown as { reviewCanvas: { getElementById: (id: string) => { position: () => { x: number; y: number } } } }).reviewCanvas;
    return canvas.getElementById("review-node").position();
  })).toEqual(moved);
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) {
      await page.getByRole("button", { name: "切换主题", exact: true }).click();
    }
    const color = await page.evaluate(() => {
      const canvas = (window as unknown as { reviewCanvas: { getElementById: (id: string) => { data: (key: string) => unknown } } }).reviewCanvas;
      return canvas.getElementById("review-node").data("statusColor");
    });
    expect(color).toBe(theme === "dark" ? "#77ca9c" : "#147a55");
    const surfaces = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.background = "var(--surface)";
      document.body.append(probe);
      const expected = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { expected, actual: [".topology-canvas-toolbar", ".topology-editbar", ".studio-statusbar", ".canvas-search-wrap"].map(selector => getComputedStyle(document.querySelector(selector)!).backgroundColor) };
    });
    expect(surfaces.actual).toEqual(Array(4).fill(surfaces.expected));
    await page.screenshot({ path: testInfo.outputPath(`topology-status-${theme}.png`) });
  }
});
