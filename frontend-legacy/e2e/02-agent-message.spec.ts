/**
 * E2E 2 — Agent message full closed loop.
 *
 * Verifies the explicit-session boundary and one UI message round trip.
 */
import { test, expect, selectWorkspace } from "./fixtures";

test("2. agent message closed loop", async ({ page, workspaceId }) => {
  await page.addInitScript(() => {
    class UnavailableWebSocket { constructor() { throw new Error("e2e websocket unavailable"); } }
    Object.defineProperty(window, "WebSocket", { value: UnavailableWebSocket, configurable: true });
  });
  await page.route("**/api/agent/message**", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true, final_response: "hello received", events: [],
        trace_id: "trace-e2e", session_id: body.session_id,
        turn_id: "turn-e2e", tool_calls: [
          {tool_id:"agent.manage",call_id:"spawn-e2e",ok:true,duration_ms:2,result:{subtask_id:"sub-e2e",profile_id:"data_agent",instruction:"统计订单",task_status:"running",observation_revision:1}},
          {tool_id:"agent.manage",call_id:"wait-e2e",ok:true,duration_ms:3,result:{subtask_id:"sub-e2e",profile_id:"data_agent",instruction:"统计订单",task_status:"succeeded",observation_revision:2,started_at:"2026-10-13T00:00:00Z",finished_at:"2026-10-13T00:00:20Z",progress:{model_responses:2,tool_results:1},content_complete:true}},
        ], warnings: [], errors: [],
        metadata: { execution_outcome: "complete", tool_execution_outcome: "complete" },
      }),
    });
  });
  await page.goto("/workbench");

  // Pick a workspace if Sidebar hasn't auto-selected one.
  // Wait for sidebar workspace list to load.
  await selectWorkspace(page, workspaceId);

  const input = page.getByTestId("chat-input");
  await expect(input).toBeDisabled();
  await page.getByTestId("btn-new-session").click();
  await expect(input).toBeEnabled();
  await input.fill("hello");
  await page.getByTestId("btn-send").click();

  await expect(page.getByTestId("chat-user").filter({ hasText: "hello" })).toBeVisible();
  await expect(page.getByTestId("chat-assistant").filter({ hasText: "hello received" })).toBeVisible();
  const task = page.getByTestId("chat-assistant").getByTestId("subagent-task-card");
  await expect(task).toHaveCount(1);
  await expect(page.locator(".task-footprint-card")).toHaveCount(1);
  await expect(page.locator(".task-footprint-card")).toContainText("子任务");
  await page.locator(".task-footprint-card").click();
  await expect(page.locator("#tool-call-subagent-sub-e2e")).toBeVisible();
  await expect(task).toContainText("子任务已完成");
  await expect(task).toContainText("运行 20s");
  await task.getByText("观察记录 · 2 次").click();
  await expect(task).toContainText("运行中");
  await expect(task).toContainText("读取成功");
  await page.screenshot({path:test.info().outputPath("subagent-task-card.png"),fullPage:true});
});
