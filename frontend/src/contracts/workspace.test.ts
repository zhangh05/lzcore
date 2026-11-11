import { describe, expect, it } from "vitest";
import { pickCurrentWorkspace } from "./workspace";

describe("工作区选择（禁止写死 default）", () => {
  const list = [{ workspace_id: "ws-demo-1" }, { workspace_id: "ws-demo-2" }];
  it("URL → 记忆 → home → 第一项", () => {
    expect(pickCurrentWorkspace(list, { fromUrl: "ws-demo-2" })).toBe("ws-demo-2");
    expect(pickCurrentWorkspace(list, { fromUrl: "nope", remembered: "ws-demo-2" })).toBe("ws-demo-2");
    expect(pickCurrentWorkspace(list, { home: "ws-demo-2" })).toBe("ws-demo-2");
    expect(pickCurrentWorkspace(list, {})).toBe("ws-demo-1");
  });
  it("列表里没有 default 时绝不返回 default", () => {
    expect(pickCurrentWorkspace(list, { fromUrl: "default", remembered: "default", home: "default" })).toBe("ws-demo-1");
    expect(pickCurrentWorkspace([], { home: "default" })).toBeNull();
  });
});
