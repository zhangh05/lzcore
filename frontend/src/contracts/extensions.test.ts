import { describe, expect, it } from "vitest";
import { deriveExtensionMounts, extensionNavItems, registryFromResponse, resolveExtensionRoute, type ExtensionCatalogItem } from "./extensions";
import { CORE_FORBIDDEN_DOMAIN_WORDS } from "./naming";

const ready: ExtensionCatalogItem = {
  extension_id: "demo.notes", name: "演示笔记",
  frontend_routes: [{ path: "/extensions/demo.notes/board", label: "笔记看板", order: 10 }],
  lifecycle: { enabled: true, status: "ready" },
};
const failed: ExtensionCatalogItem = {
  extension_id: "network.operations", name: "网络扩展",
  frontend_routes: [{ path: "/extensions/network.operations/manage", label: "网络 Skill 管理", order: 30 }],
  lifecycle: { enabled: true, status: "failed", last_error: "依赖未就绪" },
};
const disabled: ExtensionCatalogItem = { ...ready, extension_id: "demo.off", name: "已停用", frontend_routes: [{ path: "/extensions/demo.off/x" }], lifecycle: { enabled: false } };

describe("扩展注册表", () => {
  it("按 catalog 动态生成导航；不可用的带原因", () => {
    const mounts = deriveExtensionMounts([failed, ready, disabled]);
    expect(mounts.map((m) => m.path)).toEqual(["/extensions/demo.notes/board", "/extensions/network.operations/manage", "/extensions/demo.off/x"]);
    expect(mounts[1]).toMatchObject({ available: false });
    expect(mounts[1].reason).toContain("依赖未就绪");
    expect(mounts[2].reason).toContain("已停用");
  });
  it("未安装网络扩展时：导航没有网络词", () => {
    const state = registryFromResponse({ extensions: [ready] });
    const text = extensionNavItems(state).map((m) => `${m.label} ${m.description}`).join(" ");
    for (const w of CORE_FORBIDDEN_DOMAIN_WORDS) expect(text).not.toContain(w);
  });
  it("不可用时解析为带原因的说明态，不是 404", () => {
    const state = registryFromResponse({ extensions: [ready, failed] });
    const r = resolveExtensionRoute("/extensions/network.operations/manage", state);
    expect(r.kind).toBe("unavailable");
    if (r.kind === "unavailable") expect(r.reason).toContain("依赖未就绪");
  });
  it("未安装的扩展路径 → not_installed（有原因），目录失败 → registry_error", () => {
    const none = registryFromResponse({ extensions: [] });
    const r = resolveExtensionRoute("/extensions/network.operations/manage", none);
    expect(r.kind).toBe("not_installed");
    if (r.kind === "not_installed") for (const w of CORE_FORBIDDEN_DOMAIN_WORDS) expect(r.reason).not.toContain(w);
    expect(resolveExtensionRoute("/extensions/x", { kind: "error", reason: "HTTP 500" }).kind).toBe("registry_error");
    expect(registryFromResponse({ nope: 1 }).kind).toBe("error");
  });
  it("minimum_role 不满足时不可用", () => {
    const m = deriveExtensionMounts([{ ...ready, metadata: { minimum_role: "admin" } }], "viewer");
    expect(m[0].available).toBe(false);
  });
  it("可用时 mounted", () => {
    expect(resolveExtensionRoute("/extensions/demo.notes/board", registryFromResponse({ extensions: [ready] })).kind).toBe("mounted");
  });
});
