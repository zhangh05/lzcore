/**
 * The PDF writer is hand-rolled, so the contract that matters is not "it looks
 * right" but "a reader can actually parse it": header, object offsets in the
 * xref table, and a stream whose declared length matches reality.
 */

import { describe, expect, it } from "vitest";
import { buildImagePdf, deflateBytes, rgbFromRgba, type RgbImage } from "../../../extensions/network_operations/frontend/components/topologyPdf";

const text = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);

function sampleImage(width = 4, height = 3): RgbImage {
  const data = new Uint8Array(width * height * 3);
  for (let index = 0; index < data.length; index += 3) {
    data[index] = 200;
    data[index + 1] = 40;
    data[index + 2] = 90;
  }
  return { width, height, data };
}

describe("topology PDF export", () => {
  it("writes a parseable single-page document", async () => {
    const pdf = await buildImagePdf(sampleImage());
    const raw = text(pdf);

    expect(raw.startsWith("%PDF-1.4")).toBe(true);
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(raw).toContain("/Type /Catalog");
    expect(raw).toContain("/Type /Page");
    expect(raw).toContain("/Subtype /Image");
    expect(raw).toContain("/Filter /FlateDecode");
    expect(raw).toContain("/ColorSpace /DeviceRGB");
  });

  it("records xref offsets that point at each object", async () => {
    const pdf = await buildImagePdf(sampleImage(6, 5));
    const raw = text(pdf);
    const startxref = Number(raw.slice(raw.lastIndexOf("startxref") + 9).trim().split("\n")[0]);
    expect(raw.slice(startxref, startxref + 4)).toBe("xref");

    // Lines: "xref", "0 6", the free entry, then one entry per object.
    const table = raw.slice(startxref).split("\n").slice(3, 8);
    expect(table.length).toBe(5);
    table.forEach((entry, index) => {
      const offset = Number(entry.slice(0, 10));
      expect(raw.slice(offset)).toMatch(new RegExp(`^${index + 1} 0 obj`));
    });
  });

  it("declares stream lengths that match the bytes written", async () => {
    const pdf = await buildImagePdf(sampleImage(5, 4));
    const raw = text(pdf);
    const declared = [...raw.matchAll(/\/Length (\d+) >>\nstream\n/g)].map((match) => Number(match[1]));
    expect(declared.length).toBe(2);
    for (const length of declared) {
      const marker = `/Length ${length} >>\nstream\n`;
      const at = raw.indexOf(marker) + marker.length;
      // The EOL before "endstream" is a separator and is not part of /Length.
      expect(raw.slice(at + length)).toMatch(/^\n?endstream/);
    }
  });

  it("keeps the drawing inside the page and scales oversized exports down", async () => {
    // Under the cap the drawing stays 1:1, so 1px == 1pt and nothing is resampled.
    const small = await buildImagePdf(sampleImage(400, 300), { maxLongSide: 1600 });
    expect(text(small)).toContain("/MediaBox [0 0 448 348]");
    expect(text(small)).toContain("400 0 0 300 24 24 cm");

    // Over the cap the long side is clamped, keeping the aspect ratio.
    const large = await buildImagePdf(sampleImage(4000, 2000), { maxLongSide: 1600 });
    expect(text(large)).toContain("/MediaBox [0 0 1648 848]");
    expect(text(large)).toContain("1600 0 0 800 24 24 cm");
  });

  it("rejects pixel buffers that disagree with the declared size", async () => {
    await expect(buildImagePdf({ width: 2, height: 2, data: new Uint8Array(5) })).rejects.toThrow("pdf_export_pixel_mismatch");
    await expect(buildImagePdf({ width: 0, height: 0, data: new Uint8Array(0) })).rejects.toThrow("pdf_export_requires_pixels");
  });

  it("compresses, and falls back to stored bytes when unavailable", async () => {
    const image = sampleImage(32, 32);
    const result = await deflateBytes(image.data);
    expect(result.compressed).toBe(true);
    expect(result.bytes.length).toBeLessThan(image.data.length);

    const original = globalThis.CompressionStream;
    // @ts-expect-error deliberately removing a platform API to exercise the fallback
    delete globalThis.CompressionStream;
    try {
      const fallback = await deflateBytes(image.data);
      expect(fallback.compressed).toBe(false);
      expect(fallback.bytes).toEqual(image.data);
      const pdf = await buildImagePdf(image);
      // Uncompressed samples need no filter entry. An empty filter array is
      // accepted by some readers but rejected by stricter PDF consumers.
      expect(text(pdf)).not.toContain("/Filter");
    } finally {
      globalThis.CompressionStream = original;
    }
  });

  it("composites transparent pixels onto white instead of black", () => {
    const rgba = new Uint8ClampedArray([
      10, 20, 30, 255,
      10, 20, 30, 0,
      200, 200, 200, 128,
      0, 0, 0, 255,
    ]);
    const image = rgbFromRgba(rgba, 2, 2);
    expect(Array.from(image.data.slice(0, 3))).toEqual([10, 20, 30]);
    expect(Array.from(image.data.slice(3, 6))).toEqual([255, 255, 255]);
    // half-transparent light grey over white stays light
    expect(image.data[6]).toBeGreaterThan(200);
    expect(Array.from(image.data.slice(9, 12))).toEqual([0, 0, 0]);
  });
});
