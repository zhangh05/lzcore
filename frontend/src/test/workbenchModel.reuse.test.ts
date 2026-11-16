import { describe, expect, it } from "vitest";
import { reuseIfSame, reuseUnchanged } from "../pages/workbench/model";

describe("回读后的结构共享", () => {
  it("内容没变的条目沿用旧对象，变化和新增的才换", () => {
    const a = { id: 1, t: "x" }, b = { id: 2, t: "y" };
    const prev = [a, b];
    const next = reuseUnchanged(prev, [{ id: 1, t: "x" }, { id: 2, t: "y2" }, { id: 3, t: "z" }]);
    expect(next[0]).toBe(a);
    expect(next[1]).not.toBe(b);
    expect(next).toHaveLength(3);
  });
  it("完全没变时返回原数组，不触发重新渲染", () => {
    const prev = [{ id: 1 }, { id: 2 }];
    expect(reuseUnchanged(prev, [{ id: 1 }, { id: 2 }])).toBe(prev);
    const s = { title: "a" };
    expect(reuseIfSame(s, { title: "a" })).toBe(s);
    expect(reuseIfSame(s, { title: "b" })).toEqual({ title: "b" });
  });
});
