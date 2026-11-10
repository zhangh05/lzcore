import { describe, expect, it } from "vitest";
import {
  nextFreeInterface,
  occupiedInterfaces,
  type TopologyLink,
} from "../../../extensions/network_operations/frontend/components/TopologyWorkspace";

const link = (over: Partial<TopologyLink> = {}): TopologyLink => ({
  link_id: "l1",
  source_node_id: "a",
  target_node_id: "b",
  source_interface: "GE0/1",
  target_interface: "GE0/0",
  kind: "physical",
  source: "manual",
  status: "unknown",
  ...over,
});

/* The bug this covers: interface defaults were hardcoded `GE0/1` / `GE0/0`, so
   a second link between the same pair of devices came pre-filled with the same
   port the first one took. On the drawing that reads as one device wearing two
   identical labels — which looks like a rendering fault and is not. */
describe("interface auto-assignment", () => {
  it("starts the source end at GE0/1 and the far end at GE0/0", () => {
    expect(nextFreeInterface([], "a")).toBe("GE0/1");
    expect(nextFreeInterface([], "b", 0)).toBe("GE0/0");
  });

  it("moves both ends along when a second link is added between the same pair", () => {
    const links = [link()];
    expect(nextFreeInterface(links, "a")).toBe("GE0/2");
    expect(nextFreeInterface(links, "b", 0)).toBe("GE0/1");
  });

  it("only counts the device it is asked about", () => {
    const links = [link()];
    // A third device has taken nothing, so it still starts at GE0/1 even though
    // both ends of the existing link use ports in that range.
    expect(nextFreeInterface(links, "c")).toBe("GE0/1");
  });

  it("counts a port as taken whichever end of the link the device sits on", () => {
    const links = [link({ source_node_id: "x", target_node_id: "a", target_interface: "GE0/1" })];
    expect(occupiedInterfaces(links, "a").has("GE0/1")).toBe(true);
    expect(nextFreeInterface(links, "a")).toBe("GE0/2");
  });

  it("skips a gap rather than reusing a port that is already spoken for", () => {
    const links = [
      link({ link_id: "l1", source_interface: "GE0/1" }),
      link({ link_id: "l2", source_interface: "GE0/2" }),
      link({ link_id: "l3", source_interface: "GE0/3" }),
    ];
    expect(nextFreeInterface(links, "a")).toBe("GE0/4");
  });

  it("treats blank interface names as not occupying anything", () => {
    const links = [link({ source_interface: "" })];
    expect(nextFreeInterface(links, "a")).toBe("GE0/1");
  });
});
