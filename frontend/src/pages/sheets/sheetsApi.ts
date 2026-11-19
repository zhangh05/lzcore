import { apiPath, enc } from "../../api/client";
import { localAuthHeaders } from "../../api/localAuth";

export interface SheetSummary {
  spreadsheet_id: string;
  name: string;
  revision: number;
  created_at?: string;
  updated_at?: string;
  updated_by?: string;
  sheets?: string[];
}

/** 浏览器里的工作簿快照（Univer IWorkbookData）。后端原样保存，只理解 sheets / sheetOrder / cellData。 */
export type WorkbookSnapshot = Record<string, unknown> & { sheetOrder?: string[]; sheets?: Record<string, unknown> };

export interface SheetRecord extends SheetSummary {
  workbook: WorkbookSnapshot;
}

export const SHEET_ACCEPT = ".xlsx,.xlsm,.csv,.tsv";

/** 谁最后改的：智能体写入显示「智能体」，其他显示用户名。 */
export function updatedByLabel(value?: string): string {
  if (!value) return "";
  return value.startsWith("agent") ? "智能体" : value;
}

/** 下载导出文件：带上本地令牌请求，再交给浏览器保存，避免直接链接在需要令牌时 401。 */
export async function downloadExport(ws: string, sheet: SheetSummary, format: "xlsx" | "csv", sheetName?: string): Promise<string | null> {
  const path = apiPath(`/api/spreadsheets/${enc(sheet.spreadsheet_id)}/export`, { workspace_id: ws, format, sheet: sheetName });
  try {
    const res = await fetch(path, { credentials: "same-origin", headers: await localAuthHeaders() });
    if (!res.ok) return `导出失败（HTTP ${res.status}）`;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sheet.name || "表格"}${format === "csv" && sheetName ? `-${sheetName}` : ""}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return null;
  } catch (e) {
    return `导出失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 由表头和行生成单工作表的工作簿快照：表头加粗、浅色底并冻结首行，列宽按内容估算。 */
export function workbookFromRows(name: string, sheetName: string, header: string[], rows: (string | number | null)[][]): WorkbookSnapshot {
  const cellData: Record<string, Record<string, Record<string, unknown>>> = {};
  const all = [header, ...rows];
  all.forEach((row, r) => {
    row.forEach((value, c) => {
      if (value === null || value === "") return;
      const cell: Record<string, unknown> = typeof value === "number" ? { v: value, t: 2 } : { v: String(value), t: 1 };
      if (r === 0) cell.s = "hdr";
      (cellData[String(r)] ??= {})[String(c)] = cell;
    });
  });
  const columnData: Record<string, { w: number }> = {};
  header.forEach((_, c) => {
    const longest = Math.max(...all.map((row) => [...String(row[c] ?? "")].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
    columnData[String(c)] = { w: Math.min(320, Math.max(72, longest * 8 + 16)) };
  });
  return {
    id: "", name, locale: "zhCN", styles: { hdr: { bl: 1, bg: { rgb: "#EEF2F7" } } }, sheetOrder: ["s1"], resources: [],
    sheets: { s1: {
      id: "s1", name: sheetName, rowCount: Math.max(1000, all.length + 50), columnCount: Math.max(26, header.length + 5),
      cellData, columnData, rowData: {}, mergeData: [], freeze: { xSplit: 0, ySplit: 1, startRow: 1, startColumn: 0 },
    } },
  };
}
