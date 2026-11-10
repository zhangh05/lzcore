import { describe, expect, it } from "vitest";
import { NAV_ITEMS, buildNavGroups } from "../config/nav";

describe("navigation simplification", () => {
  it("keeps daily product areas in the default grouped navigation", () => {
    const primary = NAV_ITEMS.filter((item) => !item.utility);
    const groups = buildNavGroups(primary);
    expect(primary.map((item) => item.to)).toEqual([
      "/workbench", "/runs", "/knowledge", "/data",
      "/memory", "/extensions/network.operations/manage?tab=devices", "/extensions/network.operations/manage?tab=skills", "/topology", "/diagnostics",
    ]);
    expect(groups.find((group) => group.id === "tasks")?.items.map((item) => item.to)).toEqual(["/runs"]);
    expect(groups.find((group) => group.id === "network_devices")?.items.map((item) => item.to)).toEqual(["/extensions/network.operations/manage?tab=devices"]);
    expect(groups.find((group) => group.id === "network_skills")?.items.map((item) => item.to)).toEqual(["/extensions/network.operations/manage?tab=skills"]);
    expect(groups.find((group) => group.id === "topology")?.items.map((item) => item.to)).toEqual(["/topology"]);
    expect(groups.find((group) => group.id === "system")?.items.map((item) => item.to)).toEqual(["/diagnostics"]);
    expect(groups.some((group: any) => group.id === "capabilities")).toBe(false);
  });

  it("removes the obsolete advanced product surface", () => {
    expect(NAV_ITEMS.map((item) => item.to)).not.toEqual(expect.arrayContaining([
      "/reviews", "/extensions", "/workflows", "/advanced",
    ]));
  });
  it("keeps settings and user access together in the compact settings menu", () => {
    expect(NAV_ITEMS.filter((item) => item.utility === "settings").map((item) => item.to)).toEqual([
      "/settings", "/users",
    ]);
  });
});
