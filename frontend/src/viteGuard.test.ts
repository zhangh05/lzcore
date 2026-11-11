import { describe, expect, it } from "vitest";
import { assertLoopbackListenHost, resolveDevApiTarget } from "../vite.guard";

describe("VITE_DEV_API_TARGET 守卫：没有默认后端", () => {
  it("未设置时报错退出（不回退到任何默认后端，包括 8011）", () => {
    expect(() => resolveDevApiTarget(undefined)).toThrow(/未设置/);
    expect(() => resolveDevApiTarget("")).toThrow(/未设置/);
    expect(() => resolveDevApiTarget("   ")).toThrow(/未设置/);
  });
  it("拒绝非 http://127.0.0.1:<port> 的目标", () => {
    expect(() => resolveDevApiTarget("http://localhost:8011")).toThrow(/127\.0\.0\.1/);
    expect(() => resolveDevApiTarget("http://0.0.0.0:8011")).toThrow(/127\.0\.0\.1/);
    expect(() => resolveDevApiTarget("http://192.168.1.10:8011")).toThrow(/127\.0\.0\.1/);
    expect(() => resolveDevApiTarget("https://127.0.0.1:8011")).toThrow(/http/);
    expect(() => resolveDevApiTarget("https://example.com")).toThrow();
    expect(() => resolveDevApiTarget("http://127.0.0.1")).toThrow(/端口/);
    expect(() => resolveDevApiTarget("http://127.0.0.1:8011/api")).toThrow(/路径/);
    expect(() => resolveDevApiTarget("http://u:p@127.0.0.1:8011")).toThrow(/凭据/);
    expect(() => resolveDevApiTarget("not a url")).toThrow(/合法/);
  });
  it("切流后允许显式的产品后端 8011（start.sh 设置）与本地 mock", () => {
    expect(resolveDevApiTarget("http://127.0.0.1:8011")).toBe("http://127.0.0.1:8011");
    expect(resolveDevApiTarget("http://127.0.0.1:8011/")).toBe("http://127.0.0.1:8011");
    expect(resolveDevApiTarget("http://127.0.0.1:19001")).toBe("http://127.0.0.1:19001");
  });
});

describe("Vite 监听地址守卫：只绑 127.0.0.1", () => {
  it("允许 127.0.0.1 与未覆盖（使用配置默认 127.0.0.1）", () => {
    expect(assertLoopbackListenHost("127.0.0.1")).toBe("127.0.0.1");
    expect(assertLoopbackListenHost(undefined)).toBe("127.0.0.1");
  });
  it("拒绝 0.0.0.0 / :: / 局域网地址 / 不带值的 --host", () => {
    const off = {};
    expect(() => assertLoopbackListenHost("0.0.0.0", "server", off)).toThrow(/0\.0\.0\.0/);
    expect(() => assertLoopbackListenHost("::", "server", off)).toThrow(/127\.0\.0\.1/);
    expect(() => assertLoopbackListenHost("192.168.1.10", "server", off)).toThrow(/127\.0\.0\.1/);
    expect(() => assertLoopbackListenHost(true, "server", off)).toThrow(/127\.0\.0\.1/);
  });

  it("部署方显式开启局域网访问时接受显式地址，但仍拒绝不带值的 --host", () => {
    for (const env of [{ LZCORE_ALLOW_LAN: "true" }, { LZCORE_ALLOW_UNAUTHENTICATED_NETWORK: "1" }]) {
      expect(assertLoopbackListenHost("0.0.0.0", "server", env)).toBe("0.0.0.0");
      expect(assertLoopbackListenHost("192.168.1.10", "server", env)).toBe("192.168.1.10");
      expect(() => assertLoopbackListenHost(true, "server", env)).toThrow(/127\.0\.0\.1/);
    }
    expect(() => assertLoopbackListenHost("0.0.0.0", "server", { LZCORE_ALLOW_LAN: "false" })).toThrow();
  });
});
