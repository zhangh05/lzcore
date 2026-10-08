import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { FormDialogHost } from "../components/FormDialog";
import { useTopologyViews } from "../../../extensions/network_operations/frontend/components/useTopologyViews";

function setup() {
  const viewport = { x: 10, y: 20, zoom: 1.5 };
  const canvasApiRef = { current: { getViewport: () => viewport, setViewport: vi.fn(), focusIds: vi.fn() } } as never;
  const setNotice = vi.fn();
  const hook = renderHook(() =>
    useTopologyViews({
      activeTopology: null,
      canvasApiRef,
      selectedElement: null as never,
      selectedTopologyId: "topo-1",
      setNotice,
      setSelectedElement: vi.fn(),
      setSelectedTopologyId: vi.fn(),
      topologies: [],
      workspaceId: "ws-a",
    }),
  );
  render(<FormDialogHost />);
  return { hook, setNotice };
}

describe("topology view bookmarks use the in-app form dialog", () => {
  const nativePrompt = vi.fn(() => "native");
  beforeEach(() => {
    localStorage.clear();
    nativePrompt.mockClear();
    vi.stubGlobal("prompt", nativePrompt);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("saves the viewport under the entered name and never calls window.prompt", async () => {
    const { hook, setNotice } = setup();
    let pending: Promise<void> | undefined;
    act(() => { pending = hook.result.current.saveBookmark(); });
    const field = await screen.findByLabelText("视图名称");
    expect((field as HTMLInputElement).value).toBe("视图 1");
    fireEvent.change(field, { target: { value: "核心层" } });
    fireEvent.click(screen.getByRole("button", { name: "保存视图" }));
    await act(async () => { await pending; });
    expect(hook.result.current.bookmarks).toEqual([{ name: "核心层", x: 10, y: 20, zoom: 1.5 }]);
    expect(JSON.parse(localStorage.getItem("lzcore.topology.views.ws-a.topo-1")!)).toHaveLength(1);
    expect(setNotice).toHaveBeenCalledWith("已保存视图「核心层」");
    expect(nativePrompt).not.toHaveBeenCalled();
  });

  it("cancelling stores nothing", async () => {
    const { hook, setNotice } = setup();
    let pending: Promise<void> | undefined;
    act(() => { pending = hook.result.current.saveBookmark(); });
    await screen.findByLabelText("视图名称");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await act(async () => { await pending; });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(hook.result.current.bookmarks).toEqual([]);
    expect(localStorage.getItem("lzcore.topology.views.ws-a.topo-1")).toBeNull();
    expect(setNotice).not.toHaveBeenCalled();
    expect(nativePrompt).not.toHaveBeenCalled();
  });

  describe("the naming dialog belongs to the graph + workspace it was opened for", () => {
    function scoped() {
      const canvasApiRef = { current: { getViewport: () => ({ x: 1, y: 2, zoom: 1 }), setViewport: vi.fn(), focusIds: vi.fn() } } as never;
      const setNotice = vi.fn();
      const hook = renderHook((props: { workspaceId: string; topologyId: string }) =>
        useTopologyViews({
          activeTopology: null, canvasApiRef, selectedElement: null as never,
          selectedTopologyId: props.topologyId, setNotice, setSelectedElement: vi.fn(), setSelectedTopologyId: vi.fn(),
          topologies: [], workspaceId: props.workspaceId,
        }), { initialProps: { workspaceId: "ws-a", topologyId: "topo-a" } });
      render(<FormDialogHost />);
      return { hook, setNotice };
    }
    const A_KEY = "lzcore.topology.views.ws-a.topo-a";
    const A_LIST = [{ name: "A 核心层", x: 0, y: 0, zoom: 1 }];
    const B_LIST = [{ name: "B 接入层", x: 5, y: 5, zoom: 2 }];

    for (const [label, next, bKey] of [
      ["switching graph", { workspaceId: "ws-a", topologyId: "topo-b" }, "lzcore.topology.views.ws-a.topo-b"],
      ["switching workspace", { workspaceId: "ws-b", topologyId: "topo-a" }, "lzcore.topology.views.ws-b.topo-a"],
    ] as const) {
      it(`${label} during the dialog: the stale submit commits nothing`, async () => {
        localStorage.setItem(A_KEY, JSON.stringify(A_LIST));
        localStorage.setItem(bKey, JSON.stringify(B_LIST));
        const { hook, setNotice } = scoped();
        let pending: Promise<void> | undefined;
        act(() => { pending = hook.result.current.saveBookmark(); });
        const field = await screen.findByLabelText("视图名称");
        fireEvent.change(field, { target: { value: "A 新视图" } });
        hook.rerender(next);
        // The scope change aborts the dialog; a late submit has nothing to commit.
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        const stale = screen.queryByRole("button", { name: "保存视图" });
        if (stale) fireEvent.click(stale);
        await act(async () => { await pending; });
        expect(hook.result.current.bookmarks).toEqual(B_LIST);
        expect(hook.result.current.currentBookmarkName).toBe("B 接入层");
        expect(JSON.parse(localStorage.getItem(A_KEY)!)).toEqual(A_LIST);
        expect(JSON.parse(localStorage.getItem(bKey)!)).toEqual(B_LIST);
        expect(setNotice).not.toHaveBeenCalled();
      });
    }

    it("unmount aborts the open dialog without writing", async () => {
      localStorage.setItem(A_KEY, JSON.stringify(A_LIST));
      const { hook, setNotice } = scoped();
      let pending: Promise<void> | undefined;
      act(() => { pending = hook.result.current.saveBookmark(); });
      await screen.findByLabelText("视图名称");
      hook.unmount();
      await act(async () => { await pending; });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(JSON.parse(localStorage.getItem(A_KEY)!)).toEqual(A_LIST);
      expect(setNotice).not.toHaveBeenCalled();
    });
  });
});

