import { test, expect } from "./fixtures";

const resources = Array.from({ length: 300 }, (_, i) => ({ resource_id: `resource-${i}`, name: `测试设备 ${i}`, kind: "device", description: "测试范围" }));

test("25. scope disclosure preserves selection and explicit progress preference at window sizes", async ({ page, api }, testInfo) => {
  const session = await api.post("/api/sessions", { data: { workspace_id: "default", title: "输入资源范围验收" } });
  const id = (await session.json()).session.session_id;
  await page.route("**/api/workbench/skills**", route => route.fulfill({ json: { skills: [{
    extension_id: "network.operations", skill_id: "hierarchy-test", name: "范围验收", description: "",
    resources, default_resource_ids: [], selection_mode: "multiple",
  }] } }));
  await page.goto("/workbench");
  await page.getByTestId(`sess-btn-${id}`).click();
  await page.getByRole("combobox", { name: "Skill" }).selectOption("network.operations:hierarchy-test");
  const toggle = page.getByRole("button", { name: "选择资源", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "测试设备 299", exact: true })).toHaveCount(0);
  await toggle.press("Enter");
  await page.getByRole("searchbox", { name: "搜索 Skill 资源" }).fill("测试设备 299");
  const device = page.getByRole("button", { name: "测试设备 299", exact: true });
  await device.click();
  await expect(device).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("chat-input").fill("保留选择和草稿");

  // Explicit expansion remains expanded at every width. Content must scroll,
  // never silently close or squeeze the Stop/send controls out of the window.
  const panel = page.getByTestId("task-progress-panel");
  if (await panel.getAttribute("class").then(value => value?.includes("is-collapsed"))) {
    await page.getByTestId("btn-toggle-task-progress").click();
  }
  for (const width of [1440, 1068, 900, 760, 390]) {
    await page.setViewportSize({ width, height: 700 });
    await expect(device).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "已选 1 个资源", exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(panel).not.toHaveClass(/is-collapsed/);
    await expect(page.getByTestId("chat-input")).toHaveValue("保留选择和草稿");
    await expect(page.getByTestId("btn-send")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    const bounds = await page.getByTestId("btn-send").boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`scope-${width}.png`) });
  }
  await page.getByRole("searchbox").press("Escape");
  const summary = page.getByRole("button", { name: "已选 1 个资源", exact: true });
  await expect(summary).toBeFocused();
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await page.getByTestId("btn-toggle-task-progress").click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(panel).toHaveClass(/is-collapsed/);
  await page.getByRole("button", { name: "会话信息与导出" }).press("Enter");
  await expect(page.locator(".wb-session-details-content")).toContainText(id);
  await page.getByRole("button", { name: "会话信息与导出" }).press("Escape");
  await expect(page.locator(".wb-session-details")).not.toHaveAttribute("open");
});

test("25b. live and failed turns keep controls reachable in short Windows windows", async ({ page, api }, testInfo) => {
  const session = await api.post("/api/sessions", { data: { workspace_id: "default", title: "执行状态验收" } });
  const id = (await session.json()).session.session_id;
  let failTurn: (() => void) | undefined;
  await page.route("**/api/agent/llm/status", route => route.fulfill({ json: { enabled: true, connected: true, model: "UI Test", provider: "test" } }));
  await page.routeWebSocket("**/ws/agent", socket => {
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      if (frame.type === "message") {
        const context = { session_id: id, client_request_id: frame.metadata.client_request_id };
        socket.send(JSON.stringify({ ...context, type: "token", seq: 1, content: "正在检查区域成员与连线。" }));
        failTurn = () => socket.send(JSON.stringify({ ...context, type: "error", seq: 2, error: "测试连接失败，请检查后重试" }));
      }
    });
  });
  await page.goto("/workbench");
  await page.getByTestId(`sess-btn-${id}`).click();
  await page.getByTestId("chat-input").fill("检查图纸");
  await page.getByTestId("btn-send").click();
  await expect.poll(() => Boolean(failTurn)).toBe(true);
  for (const width of [1200, 900, 760, 390]) {
    await page.setViewportSize({ width, height: 600 });
    await expect(page.getByTestId("btn-stop")).toBeVisible();
    const stop = await page.getByTestId("btn-stop").boundingBox();
    expect(stop!.y + stop!.height).toBeLessThanOrEqual(600);
    await expect(page.locator(".wb-meta-security")).toContainText("任务正在运行");
    await page.screenshot({ path: testInfo.outputPath(`live-${width}.png`) });
  }
  failTurn!();
  await expect(page.getByTestId("btn-stop")).toHaveCount(0);
  await expect(page.getByTestId("chat-input")).toBeEnabled();
  await expect(page.locator(".wb-retry-bar")).toContainText("测试连接失败");
  await page.screenshot({ path: testInfo.outputPath("failed-turn.png") });
});
