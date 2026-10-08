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
});
