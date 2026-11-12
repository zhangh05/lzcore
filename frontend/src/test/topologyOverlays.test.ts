import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// 拓扑画布的 ConfirmHost / FormDialogHost 走 PortalModal（.modal-backdrop / .modal）。
// 新壳不带这些类，缺样式时确认框会渲染到页面最底部看不见，「删除拓扑」看起来就是点了没反应。
const dir = resolve(__dirname, "../extension-modules/network-operations/topology");

describe("拓扑模态框样式", () => {
  it("TopologyMount 引入了 overlays.css", () => {
    expect(readFileSync(resolve(dir, "TopologyMount.tsx"), "utf8")).toContain('import "./platform/overlays.css"');
  });
  it("overlays.css 把 backdrop 固定在视口上并给出确认框样式", () => {
    const css = readFileSync(resolve(dir, "platform/overlays.css"), "utf8");
    expect(css).toMatch(/\.modal-backdrop\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/);
    expect(css).toMatch(/\.modal\s*\{/);
    expect(css).toMatch(/\.confirm-dialog-actions\s*\{/);
    expect(css).toMatch(/\.form-dialog-control\s*\{/);
  });
});
