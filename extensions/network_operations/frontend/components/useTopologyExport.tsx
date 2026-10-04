import { useCallback } from "react";
import type { Topology } from "./topologyDocument";
import {
  exportTopologyToSvg,
  nativeSaveBlob,
  svgToPngBlob,
  svgToPngDataUrl,
} from "./topologyExport";
import { buildImagePdf } from "./topologyPdf";
import { pngToRgbImage } from "./topologyPng";

export type useTopologyExportPorts = {
  activeTopology: Topology | null;
  compactMode: boolean;
  setNotice: (notice: string, ok?: boolean) => void;
  showInterfaces: boolean;
};

export function useTopologyExport({
  activeTopology,
  compactMode,
  setNotice,
  showInterfaces,
}: useTopologyExportPorts) {
  const exportCanvas = useCallback(
    async (format: "png" | "svg" | "pdf") => {
      if (!activeTopology) {
        setNotice("画布尚未就绪，请稍后再试", false);
        return;
      }
      const safeName = (activeTopology?.name || "topology").replace(
        /[\\/:*?"<>|\s]+/g,
        "_",
      );

      const getSvg = () => {
        const storageKey = activeTopology?.topology_id
          ? `lzcore_whiteboard_${activeTopology.topology_id}`
          : "lzcore_whiteboard_default";
        let wbData = null;
        try {
          const saved = localStorage.getItem(storageKey);
          if (saved) wbData = JSON.parse(saved);
        } catch {
          // ignore
        }
        return exportTopologyToSvg(activeTopology, {
          whiteboardData: wbData,
          showInterfaces,
          compactMode,
        });
      };

      if (format === "svg") {
        try {
          const svgContent = getSvg();
          const blob = new Blob([svgContent], {
            type: "image/svg+xml;charset=utf-8",
          });
          const savedPath = await nativeSaveBlob(
            blob,
            `${safeName}.svg`,
            "image/svg+xml",
          );
          if (
            savedPath !== null ||
            !(window as unknown as Record<string, unknown>)["pywebview"]
          ) {
            setNotice(
              savedPath ? `已导出至 ${savedPath}` : `已导出 ${safeName}.svg`,
            );
          }
        } catch (e) {
          console.error("SVG export failed:", e);
          setNotice("SVG 导出失败，请稍后重试", false);
        }
        return;
      }

      if (format === "pdf") {
        setNotice("正在生成 PDF…");
        try {
          const svgContent = getSvg();
          const pngDataUrl = await svgToPngDataUrl(svgContent, 2);
          const pixels = await pngToRgbImage(pngDataUrl);
          const pdf = await buildImagePdf(pixels);
          const savedPath = await nativeSaveBlob(
            new Blob([pdf], { type: "application/pdf" }),
            `${safeName}.pdf`,
            "application/pdf",
          );
          if (
            savedPath !== null ||
            !(window as unknown as Record<string, unknown>)["pywebview"]
          ) {
            setNotice(
              savedPath ? `已导出至 ${savedPath}` : `已导出 ${safeName}.pdf`,
            );
          }
        } catch (e) {
          console.error("PDF export failed:", e);
          setNotice("PDF 导出失败，请改用 PNG 或 SVG", false);
        }
        return;
      }

      // format === "png"
      try {
        setNotice("正在生成 PNG…");
        const svgContent = getSvg();
        const blob = await svgToPngBlob(svgContent, 2);
        const savedPath = await nativeSaveBlob(
          blob,
          `${safeName}.png`,
          "image/png",
        );
        if (
          savedPath !== null ||
          !(window as unknown as Record<string, unknown>)["pywebview"]
        ) {
          setNotice(
            savedPath ? `已导出至 ${savedPath}` : `已导出 ${safeName}.png`,
          );
        }
      } catch (e) {
        console.error("PNG export failed:", e);
        setNotice("PNG 导出失败，请改用 SVG", false);
      }
    },
    [activeTopology, compactMode, setNotice, showInterfaces],
  );
  return { exportCanvas };
}
