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
async function stubTopology(page: import("@playwright/test").Page, source = TOPOLOGY) {
  const saves: Array<Record<string, unknown>> = [];
  await page.route("**/api/extensions/network.operations/topologies**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "PUT") {
      const body = JSON.parse(request.postData() || "{}");
      saves.push(body);
      return route.fulfill({ json: { ok: true, topology: { ...source, ...body, version: (body.version || 1) + 1 } } });
    }
    if (url.pathname.endsWith("/revisions")) return route.fulfill({ json: { revisions: [] } });
    if (url.pathname.endsWith(`/${source.topology_id}`)) return route.fulfill({ json: { topology: source } });
    return route.fulfill({ json: { topologies: [source] } });
  });
  return saves;
}

/** Read the painted node location; interactions use actual mouse input. */
async function nodeScreenPoint(page: import("@playwright/test").Page, id: string) {
  const host = page.locator(".netops-cytoscape").first();
  await expect.poll(() => host.evaluate((el: any, id) => el._cyreg?.cy?.getElementById(id).length, id)).toBe(1);
  const box = await host.boundingBox();
  if (!box) throw new Error("canvas not laid out");
  const point = await host.evaluate((el: any, id) => el._cyreg.cy.getElementById(id).renderedPosition(), id);
  return { x: box.x + point.x, y: box.y + point.y };
}

test("23a. dragging an object in the default mode moves and persists it", async ({ page }) => {
  const saves = await stubTopology(page);
  await page.goto(`/topology?topology=${TOPOLOGY.topology_id}`);
  await expect(page.locator(".netops-cytoscape")).toBeVisible();
  await page.waitForTimeout(1500);

  // Select mode is the default; it used to forbid grabbing outright.
  await expect(page.getByRole("button", { name: "选择" })).toHaveAttribute("aria-pressed", "true");
  const centre = await nodeScreenPoint(page, "edit-a");
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 90, centre.y + 50, { steps: 14 });
  await page.mouse.up();
  await page.getByRole("button", { name: "保存" }).click();

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
  await page.getByRole("button", { name: "保存" }).click();

  await expect.poll(() => saves.length).toBeGreaterThan(0);
  const cleared = saves.at(-1) as { nodes: unknown[]; links: unknown[]; canvas_items: unknown[] };
  expect(cleared.nodes).toHaveLength(0);
  expect(cleared.links).toHaveLength(0);
  expect(cleared.canvas_items).toHaveLength(0);
});

test("23c. selecting a painted node opens its inspector without moving it", async ({ page }) => {
  await stubTopology(page);
  await page.goto(`/topology?topology=${TOPOLOGY.topology_id}`);
  await expect(page.locator(".netops-cytoscape")).toBeVisible();
  await page.waitForTimeout(1500);

  const centre = await nodeScreenPoint(page, "edit-a");
  await page.mouse.click(centre.x, centre.y);
  await expect(page.locator(".topology-inspector")).toContainText("节点A");
  const after = await nodeScreenPoint(page, "edit-a");
  expect(after.x).toBeCloseTo(centre.x, 1);
  expect(after.y).toBeCloseTo(centre.y, 1);
});

for (const scenario of ['node', 'region', 'free', 'selection', 'lock'] as const) {
  test(`23d. ${scenario} drag retains the visible landing position on release and reload`, async ({ page }) => {
    const region = scenario === 'region';
    let drawing: any = {
      topology_id: 'release-alignment', name: '松手落点验收', version: 1, groups: [], links: [],
      nodes: region ? [{ node_id: 'member', display_name: '成员', device_type: 'switch', region_id: 'moving', x: 200, y: 350 }]
        : [
          { node_id: 'moving', display_name: '移动设备', device_type: 'switch', x: 200, y: 310 },
          { node_id: 'reference', display_name: '参考设备', device_type: 'switch', x: 480, y: 113.5 },
        ],
      canvas_items: region ? [
        { item_id: 'moving', kind: 'rect', text: '移动区域', x: 200, y: 300, width: 240, height: 180 },
        { item_id: 'reference', kind: 'rect', text: '参考区域', x: 650, y: 173.5, width: 240, height: 180 },
      ] : [],
    };
    if (scenario === 'selection' || scenario === 'lock') {
      drawing.nodes.push({ node_id: 'peer', display_name: '同步设备', device_type: 'switch', x: 200, y: 430 });
      if (scenario === 'lock') for (const n of drawing.nodes) if (n.node_id !== 'reference') n.lock_group = 'locked-pair';
    }
    const saves: any[] = [];
    await page.route('**/api/extensions/network.operations/topologies**', route => {
      const req = route.request(); const url = new URL(req.url());
      if (req.method() === 'PUT') { drawing = { ...drawing, ...JSON.parse(req.postData() || '{}') }; saves.push(drawing); return route.fulfill({ json: { ok: true, topology: drawing } }); }
      return route.fulfill({ json: url.pathname.endsWith('/overlay') ? { overlays: [] } : url.pathname.endsWith('/revisions') ? { revisions: [] }
        : url.pathname.endsWith('/release-alignment') ? { topology: drawing } : { topologies: [drawing] } });
    });
    await page.goto('/topology?topology=release-alignment');
    const host = page.locator('.netops-cytoscape').first();
    const id = region ? 'canvas-moving' : 'moving';
    await expect.poll(() => host.evaluate((el: any) => Boolean(el._cyreg?.cy?.nodes().length))).toBe(true);
    if (scenario === 'free') { await page.locator('.studio-display-menu summary').click(); await page.getByRole('checkbox', { name: '网格', exact: true }).uncheck(); }
    await host.evaluate((el: any, id) => {
      const cy = el._cyreg.cy; cy.stop(); cy.zoom(1); cy.pan({ x: 20, y: 30 });
      cy.elements().unselect(); cy.getElementById(id).select();
    }, id);
    if (scenario === 'selection') await host.evaluate((el: any) => { el._cyreg.cy.getElementById('peer').select(); });
    // Selection can open the inspector and resize the canvas. Read the actual
    // rendered coordinates after that, then drive native pointer events.
    await expect(page.locator('.topology-inspector')).toBeVisible();
    const box = (await host.boundingBox())!;
    const from = await host.evaluate((el: any, id) => el._cyreg.cy.getElementById(id).renderedPosition(), id);
    const target = scenario === 'free' ? { x: 363.25, y: 237.75 } : { x: 352, y: region ? 173.5 : 113.5 };
    const to = await host.evaluate((el: any, point) => {
      const cy = el._cyreg.cy; return { x: point.x * cy.zoom() + cy.pan().x, y: point.y * cy.zoom() + cy.pan().y };
    }, target);
    await page.mouse.move(box.x + from.x, box.y + from.y);
    await page.mouse.down();
    await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 18 });
    const positions = () => host.evaluate((el: any) => el._cyreg?.cy?.nodes().map((n: any) => ({ id: n.id(), ...n.position() })) || []);
    const preview = await positions();
    const anchor = preview.find((p: any) => p.id === id)!;
    if (scenario !== 'free') {
      expect(anchor.y).toBeCloseTo(target.y, 4);
      await expect(page.locator('.netops-align-guides')).toBeVisible();
    }
    if (region) {
      const member = preview.find((p: any) => p.id === 'member')!;
      expect(member.x - anchor.x).toBeCloseTo(0, 4);
      expect(member.y - anchor.y).toBeCloseTo(50, 4);
    }
    if (scenario === 'selection' || scenario === 'lock') {
      const peer = preview.find((p: any) => p.id === 'peer')!;
      expect(peer.x - anchor.x).toBeCloseTo(0, 4);
      expect(peer.y - anchor.y).toBeCloseTo(120, 4);
    }
    await page.mouse.up();
    await expect.poll(positions).toEqual(preview);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(() => saves.length).toBe(1);
    const stored = region ? saves[0].canvas_items.find((item: any) => item.item_id === 'moving') : saves[0].nodes.find((n: any) => n.node_id === 'moving');
    expect(stored.x).toBeCloseTo(anchor.x, 4); expect(stored.y).toBeCloseTo(anchor.y, 4);
    await page.reload();
    await expect.poll(positions).toEqual(preview);
  });
}

for (const compact of [false, true]) for (const zoom of [0.6, 1.3]) for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
  test(`23e. ${edge} guide uses actual icon edges at zoom ${zoom}, compact ${compact}`, async ({ page }, testInfo) => {
    const saves = await stubTopology(page, { ...TOPOLOGY, canvas_items: [] });
    await page.goto(`/topology?topology=${TOPOLOGY.topology_id}`);
    const host = page.locator('.netops-cytoscape').first();
    await expect.poll(() => host.evaluate((el: any) => el._cyreg?.cy?.nodes().length)).toBe(2);
    await page.locator('.studio-display-menu summary').click();
    await page.getByRole('checkbox', { name: '网格', exact: true }).uncheck();
    await page.getByRole('checkbox', { name: '紧凑模式', exact: true }).setChecked(compact);
    await host.evaluate((el: any) => { el._cyreg.cy.getElementById('edit-a').select(); });
    await expect(page.locator('.topology-inspector')).toBeVisible();
    await host.evaluate((el: any, zoom) => { const cy = el._cyreg.cy; cy.stop(); cy.zoom(zoom); cy.pan({ x: 30, y: 30 }); }, zoom);
    const geometry = () => host.evaluate((el: any) => {
      const cy = el._cyreg.cy;
      return ['edit-a', 'edit-b'].map(id => { const n = cy.getElementById(id); return { ...n.position(), width: n.width(), height: n.height() }; });
    });
    const [moving, reference] = await geometry();
    expect(reference.width).toBe(compact ? 52 : 76);
    expect(reference.height).toBe(compact ? 42 : 60);
    const horizontal = edge === 'top' || edge === 'bottom';
    const direction = edge === 'top' || edge === 'left' ? -1 : 1;
    const half = horizontal ? moving.height / 2 : moving.width / 2;
    const legacyHalf = horizontal ? 38 : 47;
    const ref = horizontal ? reference.y : reference.x;
    const point = (axis: number) => horizontal ? { x: 240, y: axis } : { x: axis, y: 240 };
    const box = (await host.boundingBox())!;
    const moveTo = async (target: { x: number; y: number }, steps = 1) => {
      const p = await host.evaluate((el: any, target) => { const cy = el._cyreg.cy; return { x: target.x * cy.zoom() + cy.pan().x, y: target.y * cy.zoom() + cy.pan().y }; }, target);
      await page.mouse.move(box.x + p.x, box.y + p.y, { steps });
    };
    await moveTo(moving);
    await page.mouse.down();
    // This position used to snap to a fictional 94x76 target edge, producing
    // exactly the guide-through-an-icon shown in the user's screenshot.
    await moveTo(point(ref + direction * (legacyHalf - half)), 12);
    const verifyVisibleGuides = async () => {
      const [a, b] = await geometry();
      const lines = await page.locator('.netops-align-guides line[data-aligned="true"]').evaluateAll(lines => lines.map(line => ({ x1: Number(line.getAttribute('x1')), x2: Number(line.getAttribute('x2')), y1: Number(line.getAttribute('y1')), y2: Number(line.getAttribute('y2')) })));
      for (const line of lines) {
        const isHorizontal = line.y1 === line.y2;
        const coordinate = ((isHorizontal ? line.y1 : line.x1) - 30) / zoom;
        for (const node of [a, b]) {
          const centre = isHorizontal ? node.y : node.x;
          const half = (isHorizontal ? node.height : node.width) / 2;
          expect(Math.min(...[centre - half, centre, centre + half].map(v => Math.abs(v - coordinate)))).toBeLessThan(0.001);
        }
      }
      return lines;
    };
    await verifyVisibleGuides();
    // Now approach the real edge from within two screen pixels. The line,
    // both icon bodies, mouse-up position and saved coordinates must agree.
    await moveTo(point(ref + direction * .5 / zoom), 12);
    const lines = await verifyVisibleGuides();
    expect(lines.some(line => horizontal ? line.y1 === line.y2 : line.x1 === line.x2)).toBe(true);
    if (edge === 'top' && zoom === 1.3) await host.screenshot({ path: testInfo.outputPath('actual-edge-alignment.png') });
    const [preview] = await geometry();
    expect(horizontal ? preview.y : preview.x).toBeCloseTo(ref, 4);
    await page.mouse.up();
    await expect.poll(geometry).toEqual([preview, reference]);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(() => saves.length).toBe(1);
    const saved = (saves[0].nodes as any[]).find(n => n.node_id === 'edit-a');
    expect(saved.x).toBeCloseTo(preview.x, 4); expect(saved.y).toBeCloseTo(preview.y, 4);
  });
}
