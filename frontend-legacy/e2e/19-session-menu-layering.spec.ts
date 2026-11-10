/** E2E 19 — Session action menu must remain above following sidebar panels. */
import { test, expect } from "./fixtures";

test("19. session delete action stays topmost and clickable above recent runs", async ({ page, api }) => {
  const created = await api.post("/api/sessions", {
    data: { workspace_id: "default", title: "menu layering regression" },
  });
  expect(created.ok()).toBeTruthy();
  const sessionId = String((await created.json()).session?.session_id ?? "");
  expect(sessionId).toBeTruthy();

  await page.goto("/workbench");

  const trigger = page.getByTestId(`session-menu-trigger-${sessionId}`);
  await expect(trigger).toBeVisible();
  await trigger.click();

  const deleteAction = page.getByRole("menuitem", { name: "永久删除" });
  await expect(deleteAction).toBeVisible();
  await expect(deleteAction).toBeEnabled();

  const isTopmostHitTarget = await deleteAction.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return hit === element || element.contains(hit);
  });
  expect(isTopmostHitTarget).toBe(true);

  // Deletion is confirmed in the product's own dialog; cancelling keeps the session.
  await deleteAction.click();
  const confirmDialog = page.getByTestId("confirm-dialog");
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText("永久删除会话");
  await expect(confirmDialog).toContainText("menu layering regression");
  await confirmDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirmDialog).toBeHidden();
  await expect(page.getByTestId(`sess-btn-${sessionId}`)).toBeVisible();
});
