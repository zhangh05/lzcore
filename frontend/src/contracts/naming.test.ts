import { describe, expect, it } from "vitest";
import { CORE_FORBIDDEN_DOMAIN_WORDS, CORE_NAV_AFTER_EXTENSIONS, CORE_NAV_BEFORE_EXTENSIONS, extensionRouteTitle, FORBIDDEN_ALIASES, NAMES } from "./naming";

const allCore = [...CORE_NAV_BEFORE_EXTENSIONS, ...CORE_NAV_AFTER_EXTENSIONS].flatMap((s) => [s, ...(s.children ?? [])]);

describe("命名表", () => {
  it("一级导航顺序与名称固定", () => {
    expect(CORE_NAV_BEFORE_EXTENSIONS.map((s) => s.label)).toEqual(["工作台", "任务", "资料", "工作流"]);
    expect(CORE_NAV_AFTER_EXTENSIONS.map((s) => s.label)).toEqual(["系统"]);
    expect(CORE_NAV_BEFORE_EXTENSIONS.find((s) => s.key === "library")?.children?.map((c) => c.label)).toEqual(["文件", "知识", "记忆"]);
  });
  it("一个概念一个名字：导航不使用旧别名", () => {
    for (const item of allCore) for (const alias of FORBIDDEN_ALIASES) expect(item.label).not.toBe(alias);
    expect(new Set(allCore.map((i) => i.label)).size).toBe(allCore.length);
  });
  it("系统状态单独指系统状态子页；核心 Skill 不带网络", () => {
    expect(NAMES.systemStatus).toBe("系统状态");
    expect(NAMES.system).toBe("系统");
    expect(NAMES.skill).toBe("Skill");
  });
  it("核心导航没有网络 / 运维领域词", () => {
    const text = allCore.map((i) => i.label).join(" ") + Object.values(NAMES).join(" ");
    for (const w of CORE_FORBIDDEN_DOMAIN_WORDS) expect(text).not.toContain(w);
  });
  it("扩展页标题挂在扩展名下，和核心 Skill 区分", () => {
    expect(extensionRouteTitle("某扩展", "网络 Skill 管理")).toBe("某扩展 · 网络 Skill 管理");
    expect(extensionRouteTitle("某扩展", "某扩展")).toBe("某扩展");
  });
});
