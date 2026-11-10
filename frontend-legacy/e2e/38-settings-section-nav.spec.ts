/**
 * E2E 38 — Settings section rail: one scroll/navigation contract at every breakpoint.
 *
 * The rail must follow the element that actually scrolls (.settings-content on
 * desktop, the page body at ≤900px where the rail is a sticky strip), jumps
 * must land below the sticky rail and focus the section heading, and under
 * prefers-reduced-motion the jump is instant.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const SECTIONS = ["模型服务", "长期记忆", "外观", "危险操作"] as const;
const IDS: Record<(typeof SECTIONS)[number], string> = { 模型服务: "providers", 长期记忆: "memory", 外观: "appearance", 危险操作: "danger" };

function navItem(page: Page, name: string) {
  return page.getByRole("navigation", { name: "设置分区" }).getByRole("button", { name: new RegExp(`^${name}`) });
}

/** Geometry of a section relative to the visible top edge of its real scroll container (below a sticky rail). */
async function sectionGeometry(page: Page, id: string) {
  return page.evaluate((sectionId) => {
    const section = document.getElementById(`settings-${sectionId}`)!;
    let scroller: HTMLElement | null = section.parentElement;
    while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight + 1)) scroller = scroller.parentElement;
    const root = (scroller ?? document.scrollingElement) as HTMLElement;
    const nav = document.querySelector<HTMLElement>(".settings-section-nav")!;
    const rootTop = scroller ? root.getBoundingClientRect().top : 0;
    const navRect = nav.getBoundingClientRect();
    const stickyNav = getComputedStyle(nav).position === "sticky" && root.contains(nav);
    const visibleTop = stickyNav ? Math.max(rootTop, navRect.bottom) : rootTop;
    return {
      scroller: root.className || root.tagName,
      offset: section.getBoundingClientRect().top - visibleTop,
      scrollTop: root.scrollTop,
      atEnd: root.scrollTop >= root.scrollHeight - root.clientHeight - 2,
    };
  }, id);
}

async function wheelUntil(page: Page, id: string, predicate: (offset: number, atEnd: boolean) => boolean, dy: number) {
  // A fixed point inside the content column (re-measuring the scrolled content box would leave the viewport).
  const viewport = page.viewportSize()!;
  const column = (await page.locator(".settings-content").boundingBox())!;
  await page.mouse.move(Math.max(column.x + 24, Math.min(column.x + column.width / 2, viewport.width - 24)), Math.round(viewport.height * 0.6));
  for (let i = 0; i < 80; i += 1) {
    const g = await sectionGeometry(page, id);
    if (predicate(g.offset, g.atEnd)) return;
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(60);
  }
  throw new Error(`could not scroll ${id} into place`);
}

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  test.describe(`settings section rail at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto("/settings");
      await expect(page.getByTestId("form-card")).toBeVisible({ timeout: 15_000 });
      await expect(navItem(page, "模型服务")).toHaveAttribute("aria-current", "true");
    });

    test(`38. manual scrolling moves the highlight (${width}px)`, async ({ page }) => {
      await wheelUntil(page, "memory", (offset) => offset <= 40, 120);
      await expect(navItem(page, "长期记忆")).toHaveAttribute("aria-current", "true");
      await expect(navItem(page, "模型服务")).not.toHaveAttribute("aria-current", "true");
      await wheelUntil(page, "danger", (_offset, atEnd) => atEnd, 240);
      await expect(navItem(page, "危险操作")).toHaveAttribute("aria-current", "true");
      await wheelUntil(page, "providers", (offset) => offset >= 0, -400);
      await expect(navItem(page, "模型服务")).toHaveAttribute("aria-current", "true");
    });

    test(`38b. a rail click jumps below the rail, focuses the heading and keeps the highlight (${width}px)`, async ({ page }) => {
      for (const name of ["外观", "长期记忆", "危险操作", "模型服务"] as const) {
        await navItem(page, name).click();
        await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeFocused();
        await expect.poll(async () => {
          const g = await sectionGeometry(page, IDS[name]);
          return (g.offset >= -1 && g.offset <= 24) || (g.atEnd && g.offset > 0);
        }, { timeout: 3_000 }).toBe(true);
        await page.waitForTimeout(400); // let any trailing scroll events settle
        await expect(navItem(page, name)).toHaveAttribute("aria-current", "true");
        const g = await sectionGeometry(page, IDS[name]);
        expect(g.offset, `${name} heading hidden under the sticky rail`).toBeGreaterThanOrEqual(-1);
        await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeInViewport();
      }
    });

    test(`38c. reduced motion jumps instantly and still focuses the heading (${width}px)`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      for (const name of ["危险操作", "长期记忆"] as const) {
        // Click and read geometry in the same task: an instant jump has already landed, a smooth one has not started.
        const before = await sectionGeometry(page, IDS[name]);
        const after = await page.evaluate(({ label, sectionId }) => {
          const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".settings-section-nav button")).find((b) => b.textContent?.startsWith(label))!;
          const section = document.getElementById(`settings-${sectionId}`)!;
          let scroller: HTMLElement | null = section.parentElement;
          while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight + 1)) scroller = scroller.parentElement;
          const root = (scroller ?? document.scrollingElement) as HTMLElement;
          const nav = document.querySelector<HTMLElement>(".settings-section-nav")!;
          button.click();
          const rootTop = scroller ? root.getBoundingClientRect().top : 0;
          const stickyNav = getComputedStyle(nav).position === "sticky" && root.contains(nav);
          const visibleTop = stickyNav ? Math.max(rootTop, nav.getBoundingClientRect().bottom) : rootTop;
          return { offset: section.getBoundingClientRect().top - visibleTop, atEnd: root.scrollTop >= root.scrollHeight - root.clientHeight - 2, scrollTop: root.scrollTop };
        }, { label: name, sectionId: IDS[name] });
        expect(after.scrollTop, `${name}: no scroll happened synchronously (smooth scrolling under reduced motion)`).not.toBe(before.scrollTop);
        expect((after.offset >= -1 && after.offset <= 24) || (after.atEnd && after.offset > 0), `${name}: landed at offset ${after.offset}`).toBe(true);
        await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeFocused();
        await expect(navItem(page, name)).toHaveAttribute("aria-current", "true");
      }
    });
  });
}
