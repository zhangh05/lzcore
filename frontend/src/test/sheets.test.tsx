import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthGateView } from "../app/AuthGate";
import { BrowserRouter } from "../router";
import { installFixture } from "./backendFixture";
import type { FakeHandler } from "./fakeBackend";

// Univer 依赖 canvas，测试里换成可控的替身：记录载入的工作簿，按钮模拟一次编辑。
const fake = vi.hoisted(() => ({ loads: [] as unknown[], edits: 0 }));
vi.mock("../pages/sheets/UniverSheet", async () => {
  const { useEffect, useRef } = await import("react");
  function FakeSheet({ workbook, onChange, onReady }: { workbook: unknown; onChange: () => void; onReady: (h: unknown) => void }) {
    const current = useRef(workbook);
    useEffect(() => {
      fake.loads.push(workbook);
      onReady({
        snapshot: () => ({ ...(current.current as object), edits: fake.edits }),
        load: (w: unknown) => { current.current = w; fake.loads.push(w); },
        activeSheetName: () => "Sheet1",
      });
      return () => onReady(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <button type="button" data-testid="fake-edit" onClick={() => { fake.edits += 1; onChange(); }}>编辑</button>;
  }
  return { default: FakeSheet };
});

interface Logged { method: string; path: string; body: unknown }

function serve(opts: { conflictOnce?: boolean } = {}) {
  const log: Logged[] = [];
  const sheet = { spreadsheet_id: "sheet_aaaaaaaaaaaa", name: "巡检记录", revision: 3, updated_at: new Date().toISOString(), updated_by: "agent:s1", sheets: ["Sheet1"] };
  const workbook = { id: "wb", sheetOrder: ["s1"], sheets: { s1: { id: "s1", name: "Sheet1", cellData: {} } } };
  let conflict = !!opts.conflictOnce;
  const handler: FakeHandler = (method, path, body) => {
    const url = new URL(path, "http://fixture.local");
    const p = url.pathname;
    if (!p.startsWith("/api/spreadsheets")) return undefined;
    log.push({ method, path: p + url.search, body });
    if (p === "/api/spreadsheets" && method === "GET") return { status: 200, body: { ok: true, spreadsheets: [sheet] } };
    if (p === "/api/spreadsheets" && method === "POST") {
      return { status: 201, body: { ok: true, spreadsheet: { ...sheet, spreadsheet_id: "sheet_bbbbbbbbbbbb", name: (body as { name: string }).name, revision: 1, workbook } } };
    }
    if (p.startsWith("/api/spreadsheets/sheet_") && method === "GET") {
      return { status: 200, body: { ok: true, spreadsheet: url.searchParams.get("summary") ? sheet : { ...sheet, workbook } } };
    }
    if (p.startsWith("/api/spreadsheets/sheet_") && method === "PUT") {
      const b = body as { base_revision: number };
      if (conflict || b.base_revision !== sheet.revision) {
        conflict = false;
        return { status: 409, body: { ok: false, error: "spreadsheet_revision_conflict", current_revision: sheet.revision } };
      }
      sheet.revision += 1;
      sheet.updated_by = "user";
      return { status: 200, body: { ok: true, spreadsheet: sheet } };
    }
    return undefined;
  };
  return { log, sheet, handler };
}

function renderAt(url: string, handler: FakeHandler) {
  window.history.replaceState({}, "", url);
  installFixture({}, handler);
  render(<BrowserRouter><AuthGateView /></BrowserRouter>);
}

describe("表格", () => {
  it("列表显示表格与最后修改者；新建后直接打开编辑页", async () => {
    const { handler, log } = serve();
    renderAt("/sheets?ws=ws-demo-1", handler);
    const table = await screen.findByTestId("sheets-table", {}, { timeout: 4000 });
    expect(within(table).getByText("巡检记录")).toBeInTheDocument();
    expect(within(table).getByText(/智能体/)).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "主导航" })).getByText("表格")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("sheets-new"));
    fireEvent.change(screen.getByTestId("sheets-name-input"), { target: { value: "采购清单" } });
    fireEvent.click(screen.getByTestId("sheets-name-submit"));
    await waitFor(() => expect(window.location.pathname).toBe("/sheets/sheet_bbbbbbbbbbbb"));
    expect(log.find((l) => l.method === "POST")?.body).toMatchObject({ workspace_id: "ws-demo-1", name: "采购清单" });
  });

  it("编辑后自动保存并带上版本号；版本冲突时停下等用户选择，可载入最新版本", async () => {
    const { handler, log } = serve({ conflictOnce: true });
    fake.loads = [];
    renderAt("/sheets/sheet_aaaaaaaaaaaa?ws=ws-demo-1", handler);
    fireEvent.click(await screen.findByTestId("fake-edit", {}, { timeout: 4000 }));
    expect(screen.getByTestId("sheet-status")).toHaveTextContent("有未保存的修改");

    // 第一次保存被服务端以 409 拒绝：不覆盖，显示冲突选项，不再自动重试。
    const banner = await screen.findByTestId("sheet-conflict", {}, { timeout: 4000 });
    expect(screen.getByTestId("sheet-status")).toHaveTextContent("版本冲突");
    const puts = () => log.filter((l) => l.method === "PUT");
    expect(puts()).toHaveLength(1);
    expect(puts()[0].body).toMatchObject({ workspace_id: "ws-demo-1", base_revision: 3 });

    fireEvent.click(within(banner).getByTestId("sheet-conflict-reload"));
    await waitFor(() => expect(screen.getByTestId("sheet-status")).toHaveTextContent("已保存 · 第 3 版"));
    expect(fake.loads).toHaveLength(2);
    expect(screen.getByTestId("sheet-notice")).toHaveTextContent("已载入智能体的版本");

    // 之后的编辑正常保存，版本号递增。
    fireEvent.click(screen.getByTestId("fake-edit"));
    await waitFor(() => expect(screen.getByTestId("sheet-status")).toHaveTextContent("已保存 · 第 4 版"), { timeout: 4000 });
    expect(puts()).toHaveLength(2);
    expect(puts()[1].body).toMatchObject({ base_revision: 3, workbook: { edits: 2 } });
  });

  it("别处写入新版本时，没有本地修改就自动载入", async () => {
    const { handler, sheet } = serve();
    fake.loads = [];
    renderAt("/sheets/sheet_aaaaaaaaaaaa?ws=ws-demo-1", handler);
    await screen.findByTestId("fake-edit", {}, { timeout: 4000 });
    await act(async () => { sheet.revision = 7; sheet.updated_by = "agent:s2"; });
    await waitFor(() => expect(screen.getByTestId("sheet-notice")).toHaveTextContent("已载入智能体刚才的修改"), { timeout: 7000 });
    expect(screen.getByTestId("sheet-status")).toHaveTextContent("第 7 版");
    expect(fake.loads).toHaveLength(2);
  }, 10000);
});
