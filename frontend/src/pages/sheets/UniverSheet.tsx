/**
 * Univer 电子表格宿主（按需加载的独立分包）。
 *
 * 只在挂载时创建一次 Univer 实例；之后父组件的状态变化（保存中 / 已保存 / 冲突）不会让这里重渲染，
 * 父组件通过 handle 取快照或载入新版本。变更以「已执行的 mutation」上报，选区等 operation 不算修改。
 */
import { memo, useEffect, useRef } from "react";
import { LocaleType, createUniver, mergeLocales, type IWorkbookData } from "@univerjs/presets";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import sheetsCoreZhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import { UniverSheetsFilterPreset } from "@univerjs/preset-sheets-filter";
import sheetsFilterZhCN from "@univerjs/preset-sheets-filter/locales/zh-CN";
import { UniverSheetsSortPreset } from "@univerjs/preset-sheets-sort";
import sheetsSortZhCN from "@univerjs/preset-sheets-sort/locales/zh-CN";
import { UniverSheetsConditionalFormattingPreset } from "@univerjs/preset-sheets-conditional-formatting";
import sheetsCfZhCN from "@univerjs/preset-sheets-conditional-formatting/locales/zh-CN";
import { UniverSheetsDataValidationPreset } from "@univerjs/preset-sheets-data-validation";
import sheetsDvZhCN from "@univerjs/preset-sheets-data-validation/locales/zh-CN";
import { UniverSheetsFindReplacePreset } from "@univerjs/preset-sheets-find-replace";
import sheetsFindZhCN from "@univerjs/preset-sheets-find-replace/locales/zh-CN";
import "@univerjs/preset-sheets-core/lib/index.css";
import "@univerjs/preset-sheets-filter/lib/index.css";
import "@univerjs/preset-sheets-sort/lib/index.css";
import "@univerjs/preset-sheets-conditional-formatting/lib/index.css";
import "@univerjs/preset-sheets-data-validation/lib/index.css";
import "@univerjs/preset-sheets-find-replace/lib/index.css";
import type { WorkbookSnapshot } from "./sheetsApi";

export interface SheetHandle {
  /** 当前工作簿快照（含公式的最新计算值）。 */
  snapshot: () => WorkbookSnapshot | null;
  /** 用服务端的新版本替换当前工作簿（不计为本地修改）。 */
  load: (workbook: WorkbookSnapshot) => void;
  /** 当前激活的工作表名称。 */
  activeSheetName: () => string | undefined;
}

const MUTATION = 2;

function isDark(): boolean {
  return document.documentElement.dataset.theme === "dark";
}

function UniverSheetImpl({ workbook, readOnly, onChange, onReady }: {
  workbook: WorkbookSnapshot;
  readOnly: boolean;
  onChange: () => void;
  onReady: (handle: SheetHandle | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  // 回调放进 ref：父组件每次渲染传入的新函数不会触发重建。
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  useEffect(() => {
    const hostEl = host.current;
    if (!hostEl) return;
    let teardown: (() => void) | null = null;
    // 延后一拍创建：React 开发模式会立即「卸载 → 再挂载」一次，被取消的那次不创建实例，
    // 避免两个 Univer 抢同一个容器、在 React 渲染中途卸载 Univer 自己的根节点。
    const start = window.setTimeout(() => { teardown = createSheet(hostEl); }, 0);
    return () => {
      window.clearTimeout(start);
      teardown?.();
    };
    // 只在挂载时创建；换表格时父组件用 key 重新挂载。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function createSheet(container: HTMLDivElement): () => void {
    const { univer, univerAPI } = createUniver({
      locale: LocaleType.ZH_CN,
      locales: { [LocaleType.ZH_CN]: mergeLocales(sheetsCoreZhCN, sheetsFilterZhCN, sheetsSortZhCN, sheetsCfZhCN, sheetsDvZhCN, sheetsFindZhCN) },
      darkMode: isDark(),
      presets: [
        UniverSheetsCorePreset({ container, footer: { menus: false } }),
        UniverSheetsFilterPreset(),
        UniverSheetsSortPreset(),
        UniverSheetsConditionalFormattingPreset(),
        UniverSheetsDataValidationPreset(),
        UniverSheetsFindReplacePreset(),
      ],
    });
    let loading = 0;
    const mount = (data: WorkbookSnapshot) => {
      loading += 1;
      try {
        const current = univerAPI.getActiveWorkbook();
        if (current) univerAPI.disposeUnit(current.getId());
        const book = univerAPI.createWorkbook(data as Partial<IWorkbookData>);
        if (readOnly) book.setEditable(false);
      } finally {
        // 载入后的公式计算等 mutation 在同一轮事件里派发；延后一拍再开始记修改。
        setTimeout(() => { loading -= 1; }, 0);
      }
    };
    mount(workbook);
    const sub = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
      // 只有工作表自身的 mutation 才算修改；内部编辑器文档、公式计算通知等不算。
      if (loading > 0 || event.type !== MUTATION || !event.id.startsWith("sheet.")) return;
      if (event.options?.onlyLocal || event.options?.fromCollab) return;
      changeRef.current();
    });
    const themeWatch = new MutationObserver(() => univerAPI.toggleDarkMode(isDark()));
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    readyRef.current({
      snapshot: () => (univerAPI.getActiveWorkbook()?.save() as WorkbookSnapshot | undefined) ?? null,
      load: mount,
      activeSheetName: () => univerAPI.getActiveWorkbook()?.getActiveSheet().getSheetName(),
    });
    return () => {
      readyRef.current(null);
      themeWatch.disconnect();
      sub.dispose();
      // Univer 卸载自己的 React 根节点必须在当前渲染结束之后。
      setTimeout(() => univer.dispose(), 0);
    };
  }

  return <div ref={host} className="univer-host" data-testid="univer-host" />;
}

/** 永不因父组件重渲染而重渲染（props 只在挂载时使用）。 */
const UniverSheet = memo(UniverSheetImpl, () => true);
export default UniverSheet;
