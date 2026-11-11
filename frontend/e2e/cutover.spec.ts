import { test, expect, type Page } from "@playwright/test";

// Real isolated backend for auth, workspace/session and byte identity. No model/device calls.
async function login(page: Page) {
  await page.goto("/workbench");
  await page.getByRole("textbox", { name: "账户", exact: true }).fill("E2EAdmin");
  await page.getByLabel("密码", { exact: true }).fill(process.env.E2E_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByTestId("workspace-switcher")).toBeVisible();
}
async function newSession(page: Page) {
  await page.getByTestId("header-new-session").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  const sid = new URL(page.url()).searchParams.get("session");
  expect(sid).toBeTruthy();
  return { sid: sid!, ws: new URL(page.url()).searchParams.get("ws")! };
}

test("real login, workspace ownership and newly created session read back", async ({ page }) => {
  await login(page);
  const { sid, ws } = await newSession(page);
  await expect(page.locator(`[data-session="${sid}"]`)).toBeVisible();
  const read = await page.request.get(`/api/sessions/${sid}?workspace_id=${encodeURIComponent(ws)}`);
  expect(read.ok()).toBeTruthy();
  expect((await read.json()).session.session_id).toBe(sid);
  await page.reload();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("session")).toBe(sid);
});

test("original bytes and filename survive actual upload, UI listing and download", async ({ page }) => {
  await login(page);
  const { sid, ws } = await newSession(page);
  const bytes = Buffer.from([0xff, 0xfe, 0x41, 0, 0x0d, 0, 0x0a, 0]);
  const uploaded = await page.request.post(`/api/workspaces/${ws}/artifacts/upload`, {
    multipart: { workspace_id: ws, session_id: sid, artifact_type: "chat_attachment", file: { name: "cutover-original.txt", mimeType: "text/plain", buffer: bytes } },
  });
  expect(uploaded.ok()).toBeTruthy();
  const body = await uploaded.json();
  expect(body.file.file_id).toBeTruthy();
  await page.goto(`/library/files?ws=${encodeURIComponent(ws)}`);
  await expect(page.getByRole("cell", { name: "cutover-original.txt", exact: true })).toBeVisible();
  const downloaded = await page.request.get(`/api/storage/files/${body.file.file_id}/download?workspace_id=${encodeURIComponent(ws)}`);
  expect(downloaded.ok()).toBeTruthy();
  expect(await downloaded.body()).toEqual(bytes);
});

test("unknown tool write remains unknown and assistant Markdown is safe", async ({ page }) => {
  await login(page);
  const { sid, ws } = await newSession(page);
  await page.route(`**/api/sessions/${sid}/messages?*`, (route) => route.fulfill({ json: { messages: [{ role: "assistant", content: "| 项目 | 状态 |\n| --- | --- |\n| 原件 | 待核对 |\n\n<script>alert(1)</script>", ok: true, errors: [], metadata: { execution_outcome: "unknown", tool_calls: [{ tool_id: "workspace.file.write", call_id: "synthetic-write", execution_outcome: "unknown", result: { execution_outcome: "unknown" } }] } }] } }));
  await page.goto(`/workbench?ws=${encodeURIComponent(ws)}&session=${sid}`);
  await expect(page.getByTestId("goal-label")).toHaveText("结果未知 · 需核对");
  await expect(page.getByRole("table")).toContainText("待核对");
  await expect(page.locator(".message-body script")).toHaveCount(0);
  await expect(page.getByTestId("outcome-bar")).not.toContainText("已完成");
});

for (const width of [1366, 390]) test(`layout stays inside ${width}px and auxiliary panels remain reachable`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await login(page);
  if (width < 761) {
    await page.getByRole("button", { name: "会话列表", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "会话列表", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "关闭", exact: true }).press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } else {
    // 宽屏：有进度内容时常驻辅助栏；空会话不占位，通过「进度与证据」打开抽屉。两种情况都必须可达。
    const rail = page.getByTestId("progress-panel");
    if (!(await rail.isVisible())) {
      await page.getByTestId("open-progress").click();
      await expect(page.getByRole("dialog")).toBeVisible();
    }
    await expect(page.getByTestId("progress-panel")).toBeVisible();
  }
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  expect(geometry.content).toBeLessThanOrEqual(geometry.viewport);
});
