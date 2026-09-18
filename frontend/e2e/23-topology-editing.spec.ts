import { test, expect } from "./fixtures";

/**
 * Topology editing regressions.
 *
 * These four defects were all found by walking the flows rather than by reading
 * code, and none of them was visible to the jsdom suite: the canvas is a bitmap,
 * so selection, dragging and hit areas cannot be exercised there. The API is
 * stubbed so the assertions are about behaviour, not about local data.
 */

const TOPOLOGY = {
  topology_id: "editing-topology",
  name: "编辑验收",
  description: "",
  version: 1,
  nodes: [
    { node_id: "edit-a", display_name: "节点A", device_type: "router", x: 100, y: 100 },
    { node_id: "edit-b", display_name: "节点B", device_type: "switch", x: 400, y: 100 },
  ],
  links: [{ link_id: "edit-link", source_node_id: "edit-a", target_node_id: "edit-b", source_interface: "", target_interface: "", kind: "physical", status: "unknown" }],
  groups: [],
  canvas_items: [{ item_id: "edit-text", kind: "text", text: "说明文字", x: 250, y: 260, width: 180, height: 36 }],
};

/** Serve a fixed drawing and record every save the UI attempts. */
async function stubTopology(page: import("@playwright/test").Page) {
  const saves: Array<Record<string, unknown>> = [];
  await page.route("**/api/extensions/network.operations/topologies**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "PUT") {
      const body = JSON.parse(request.postData() || "{}");
      saves.push(body);
      return route.fulfill({ json: { ok: true, topology: { ...TOPOLOGY, ...body, version: (body.version || 1) + 1 } } });
    }
    if (url.pathname.endsWith("/revisions")) return route.fulfill({ json: { revisions: [] } });
    if (url.pathname.endsWith(`/${TOPOLOGY.topology_id}`)) return route.fulfill({ json: { topology: TOPOLOGY } });
    return route.fulfill({ json: { topologies: [TOPOLOGY] } });
  });
  return saves;
}

/** Locating an object centres it at a fixed 1.1 zoom, which anchors the maths. */
async function locate(page: import("@playwright/test").Page, name: string) {
  await page.locator(".canvas-search-wrap input").first().fill(name);
  await page.locator(".canvas-search-results button").first().click();
  await page.waitForTimeout(1400);
}

async function canvasCentre(page: import("@playwright/test").Page) {
  const box = await page.locator(".netops-cytoscape").first().boundingBox();
  if (!box) throw new Error("canvas not laid out");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

test("23a. dragging an object in the default mode moves and persists it", async ({ page }) => {
  const saves = await stubTopology(page);
  await page.goto(`/topology?topology=${TOPOLOGY.topology_id}`);
  await expect(page.locator(".netops-cytoscape")).toBeVisible();
  await page.waitForTimeout(1500);

  // Select mode is the default; it used to forbid grabbing outright.
  await expect(page.getByRole("button", { name: "选择" })).toHaveAttribute("aria-pressed", "true");
  await locate(page, "节点A");
  const centre = await canvasCentre(page);
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 90, centre.y + 50, { steps: 14 });
  await page.mouse.up();

  await expect.poll(() => saves.length).toBeGreaterThan(0);
  const moved = saves.at(-1)?.nodes as Array<{ node_id: string; x: number; y: number }>;
  const node = moved.find(item => item.node_id === "edit-a");
  expect(node).toBeTruthy();
  expect(node!.x).not.toBe(100);
  expect(node!.y).not.toBe(100);
});

test("23b. a multi-selection opens the batch panel, and Delete removes all of it", async ({ page }) => {
  const saves = await stubTopology(page);
  await page.goto(`/topology?topology=${TOPOLOGY.topology_id}`);
  await expect(page.locator(".netops-cytoscape")).toBeVisible();
  await page.waitForTimeout(1500);

  await page.locator(".netops-cytoscape").first().click({ position: { x: 6, y: 6 } });
  await page.keyboard.press("Control+a");
  await expect(page.locator(".canvas-selection-count")).toContainText("已选");

  // The panel existed but stayed `display: none`, so its controls were unreachable.
  const inspector = page.locator(".topology-inspector");
  await expect(inspector).toBeVisible();
  await expect(page.getByRole("button", { name: "水平居中" })).toBeVisible();

  await page.keyboard.press("Delete");
  const confirm = page.locator('[data-testid="confirm-dialog"]');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("移除选中的对象");
  await confirm.getByRole("button", { name: "移除" }).click();

  await expect.poll(() => saves.length).toBeGreaterThan(0);
  const cleared = saves.at(-1) as { nodes: unknown[]; links: unknown[]; canvas_items: unknown[] };
  expect(cleared.nodes).toHaveLength(0);
  expect(cleared.links).toHaveLength(0);
  expect(cleared.canvas_items).toHaveLength(0);
});

test("23c. locating an object leaves it under the cursor", async ({ page }) => {
  await stubTopology(page);
  await page.goto(`/topology?topology=${TOPOLOGY.topology_id}`);
  await expect(page.locator(".netops-cytoscape")).toBeVisible();
  await page.waitForTimeout(1500);

  // The inspector opens asynchronously and narrows the canvas; a single centring
  // pass used to leave the located node about 150px off centre, so the next
  // click missed it.
  await locate(page, "节点A");
  const centre = await canvasCentre(page);
  await page.mouse.click(centre.x, centre.y);
  await expect(page.locator(".topology-inspector")).toContainText("节点A");
});
