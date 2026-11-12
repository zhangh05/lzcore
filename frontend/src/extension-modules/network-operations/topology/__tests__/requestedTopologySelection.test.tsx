import { act, renderHook } from "@testing-library/react";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useRequestedTopologySelection } from "../components/useRequestedTopologySelection";
import { writeTopologyParam } from "../topologyParams";

const list = [{ topology_id: "a" }, { topology_id: "b" }];
const setUrl = (id: string) => window.history.replaceState({}, "", writeTopologyParam(new URL(window.location.href), id).toString());

/** 与 TopologyWorkspace 相同的组合：选择 hook 在前，URL 回写（useTopologyViews）在后。 */
function useWorkspace(topologies: typeof list) {
  const [selected, setSelected] = useRequestedTopologySelection(topologies);
  const [renders, setRenders] = useState(0);
  useEffect(() => { if (selected) setUrl(selected); setRenders((n) => n + 1); }, [selected]);
  return { selected, setSelected, renders };
}

beforeEach(() => setUrl("a"));

describe("useRequestedTopologySelection", () => {
  it("opens the topology named in the URL", () => {
    setUrl("b");
    const { result } = renderHook(() => useWorkspace(list));
    expect(result.current.selected).toBe("b");
  });

  it("switching to another topology does not bounce back to the URL value", () => {
    const { result } = renderHook(() => useWorkspace(list));
    act(() => result.current.setSelected("b"));
    const renders = result.current.renders;
    expect(result.current.selected).toBe("b");
    expect(new URLSearchParams(window.location.search).get("topology")).toBe("b");
    expect(renders).toBeLessThan(5); // 以前在 a/b 之间无限翻转
  });

  it("selects a newly created topology once the list reloads", () => {
    const { result, rerender } = renderHook(({ t }) => useWorkspace(t), { initialProps: { t: list } });
    const next = [...list, { topology_id: "c" }];
    rerender({ t: next });
    act(() => result.current.setSelected("c"));
    rerender({ t: [...next] });
    expect(result.current.selected).toBe("c");
  });

  it("a later in-app navigation to another topology is still honoured", () => {
    const { result, rerender } = renderHook(() => useWorkspace(list));
    act(() => setUrl("b"));
    rerender();
    expect(result.current.selected).toBe("b");
  });

  it("falls back to the first topology when the selected one is deleted", () => {
    const { result, rerender } = renderHook(({ t }) => useWorkspace(t), { initialProps: { t: list } });
    act(() => result.current.setSelected("b"));
    rerender({ t: [list[0]] });
    expect(result.current.selected).toBe("a");
  });
});
