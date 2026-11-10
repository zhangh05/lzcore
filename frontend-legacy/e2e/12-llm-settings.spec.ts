/**
 * E2E 12 — LLM Settings page (v1.0.3 redesign).
 *
 * Validates: page loads + shows provider sidebar + form,
 * preset card click auto-fills base_url/model, enabled toggle,
 * save flow updates health bar.
 */
import { test, expect } from "./fixtures";

test("12. llm settings page — provider cards + enabled toggle", async ({ page }) => {
  await page.goto("/settings");

  // provider sidebar
  await expect(page.getByTestId("provider-sidebar")).toBeVisible({ timeout: 15_000 });
  for (const id of ["minimax", "deepseek", "ark", "openai", "anthropic", "ollama", "custom"]) {
    await expect(page.getByTestId(`provider-${id}`)).toBeVisible();
  }

  // form
  await expect(page.getByTestId("field-base_url")).toBeVisible();
  await expect(page.getByTestId("field-model")).toBeVisible();
  await expect(page.getByTestId("field-api_key")).toBeVisible();
  await expect(page.getByTestId("toggle-enabled")).toBeVisible();
  await expect(page.getByTestId("toggle-safe_mode")).toBeVisible();

  await expect(page.getByTestId("btn-test-llm")).toBeVisible();
  await expect(page.getByTestId("btn-save-llm")).toBeVisible();
  await expect(page.getByTestId("btn-apply-llm")).toBeVisible();
});

test("12b. openai preset click auto-fills base_url + model", async ({ page }) => {
  await page.goto("/settings");
  // 等表单 ready
  await expect(page.getByTestId("field-base_url")).toBeVisible({ timeout: 15_000 });

  // 清空 base_url 然后点 openai
  await page.getByTestId("field-base_url").fill("");
  await page.getByTestId("provider-openai").click();
  await expect(page.getByTestId("field-base_url")).toHaveValue("https://api.openai.com/v1");
  await expect(page.getByTestId("field-model")).toHaveValue("gpt-4o-mini");
});

test("12c. add named vendors with explicit protocols, reload, apply and delete", async ({ page, api }) => {
  test.setTimeout(60_000);
  await page.goto("/settings");
  const ids: string[] = [];
  for (const [protocol, name] of [["openai_compatible", "公司 OpenAI 网关"], ["anthropic_messages", "公司 Anthropic 网关"]]) {
    await page.getByTestId("btn-add-provider").click();
    await page.getByTestId("field-provider-label").fill(name);
    await page.getByTestId("field-provider-type").selectOption(protocol);
    await page.getByTestId("field-base_url").fill("https://gateway.example/v1");
    await page.getByTestId("field-model").fill("company-model");
    await page.getByTestId("field-api_key").fill("sk-isolated-e2e-catalog-key");
    const created = page.waitForResponse(response => response.url().endsWith("/api/agent/llm/providers") && response.request().method() === "POST");
    await page.getByTestId("btn-save-llm").click();
    const response = await created;
    expect(response.status()).toBe(201);
    const config = (await response.json()).config;
    expect(config.api_key).toBeNull();
    ids.push(config.provider);
    await expect(page.getByTestId(`provider-${config.provider}`)).toContainText(name);
  }
  await page.reload();
  await page.getByTestId(`provider-${ids[1]}`).click();
  await expect(page.getByTestId("field-provider-type")).toHaveValue("anthropic_messages");
  await expect(page.getByTestId("field-api_key")).toHaveValue("");
  await expect(page.getByTestId("field-model")).toHaveValue("company-model");
  await page.getByTestId("btn-apply-llm").click();
  await expect(page.getByTestId(`provider-${ids[1]}`)).toContainText("当前");
  await expect(page.getByTestId("btn-reset-llm")).toBeDisabled();
  // Saving another configuration never marks it active until explicitly applied.
  await page.getByTestId(`provider-${ids[0]}`).click();
  await page.getByTestId("btn-apply-llm").click();
  await expect(page.getByTestId(`provider-${ids[0]}`)).toContainText("当前");
  await page.getByTestId(`provider-${ids[1]}`).click();
  await page.getByTestId("btn-reset-llm").click();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByTestId(`provider-${ids[1]}`)).toHaveCount(0);
  expect((await api.get(`/api/agent/llm/providers/${ids[1]}`)).status()).toBe(404);
  await api.post("/api/agent/llm/activate", { data: { provider: "openai" } });
  await api.delete(`/api/agent/llm/providers/${ids[0]}`);
});

test("12d. adding a vendor stays usable in narrow light and dark settings", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto("/settings");
  await page.getByTestId("btn-add-provider").click();
  await page.getByTestId("field-provider-label").fill("窄窗口草稿");
  await page.getByTestId("field-provider-type").selectOption("anthropic_messages");
  for (const theme of ["light", "dark"]) {
    if (await page.locator("html").getAttribute("data-theme") !== theme) {
      await page.getByRole("button", { name: "切换主题", exact: true }).click();
    }
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.getByTestId("field-provider-type")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `/tmp/lzcore-settings-vendor-${theme}.png`, fullPage: true, animations: "disabled" });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("field-provider-label")).toHaveValue("窄窗口草稿");
  await expect(page.getByTestId("field-provider-type")).toHaveValue("anthropic_messages");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
