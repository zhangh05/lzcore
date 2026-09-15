/**
 * Minimal, dependency-free PDF writer for canvas exports.
 *
 * A topology export needs one thing a browser already gives us — the rendered
 * pixels — and one thing it does not: a PDF container. Pulling in a full PDF
 * stack for "wrap an image in a page" would add more code than this whole
 * module, so the container is assembled by hand: one page, one image XObject,
 * Flate-compressed with the platform's own CompressionStream.
 *
 * Kept free of React and DOM APIs on purpose so it can be tested directly.
 */

export type RgbImage = {
  width: number;
  height: number;
  /**
   * Raw RGB samples, 3 bytes per pixel, rows top-to-bottom.
   *
   * Pinned to a non-shared ArrayBuffer: the pixels are handed straight to a
   * Blob and to the compressor, and a SharedArrayBuffer-backed view is not a
   * valid input for either.
   */
  data: Uint8Array<ArrayBuffer>;
};

export type PdfPageOptions = {
  /** Points of white space around the drawing. */
  margin?: number;
  /** Longest page edge in points; bigger exports are scaled down to fit. */
  maxLongSide?: number;
};

const DEFAULT_MARGIN = 24;
const DEFAULT_MAX_LONG_SIDE = 1600;

const encoder = new TextEncoder();
const ascii = (value: string) => encoder.encode(value);

/** Flate-compress, falling back to stored bytes where CompressionStream is absent. */
export async function deflateBytes(data: Uint8Array<ArrayBuffer>): Promise<{ bytes: Uint8Array<ArrayBuffer>; compressed: boolean }> {
  if (typeof CompressionStream !== "function") {
    return { bytes: data, compressed: false };
  }
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  const buffer = await new Response(stream).arrayBuffer();
  return { bytes: new Uint8Array(buffer), compressed: true };
}

/** Drop the alpha channel, compositing onto white so nothing turns black. */
export function rgbFromRgba(rgba: Uint8ClampedArray, width: number, height: number): RgbImage {
  const data = new Uint8Array(width * height * 3);
  for (let pixel = 0, out = 0; pixel < width * height; pixel += 1) {
    const at = pixel * 4;
    const alpha = rgba[at + 3] / 255;
    for (let channel = 0; channel < 3; channel += 1) {
      const value = rgba[at + channel];
      data[out + channel] = alpha >= 1 ? value : Math.round(value * alpha + 255 * (1 - alpha));
    }
    out += 3;
  }
  return { width, height, data };
}

function pageGeometry(image: RgbImage, options: PdfPageOptions) {
  const margin = options.margin ?? DEFAULT_MARGIN;
  const maxLongSide = options.maxLongSide ?? DEFAULT_MAX_LONG_SIDE;
  const longSide = Math.max(image.width, image.height) || 1;
  const scale = Math.min(1, maxLongSide / longSide);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  return {
    margin,
    drawWidth,
    drawHeight,
    pageWidth: drawWidth + margin * 2,
    pageHeight: drawHeight + margin * 2,
  };
}

export async function buildImagePdf(image: RgbImage, options: PdfPageOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  if (image.width <= 0 || image.height <= 0) {
    throw new Error("pdf_export_requires_pixels");
  }
  const expected = image.width * image.height * 3;
  if (image.data.length !== expected) {
    throw new Error("pdf_export_pixel_mismatch");
  }

  const { margin, drawWidth, drawHeight, pageWidth, pageHeight } = pageGeometry(image, options);
  const { bytes: pixelBytes, compressed } = await deflateBytes(image.data);

  // PDF image data is stored top-down, matching what a canvas gives us, so the
  // placement matrix keeps a positive height and the drawing stays upright.
  const content = `q\n${round(drawWidth)} 0 0 ${round(drawHeight)} ${round(margin)} ${round(margin)} cm\n/Im0 Do\nQ\n`;
  const contentBytes = ascii(content);

  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: Uint8Array<ArrayBuffer>) => {
    chunks.push(chunk);
    length += chunk.length;
  };
  const mark = (objectNumber: number) => {
    offsets[objectNumber] = length;
  };

  // Binary marker: tells transfer tools this file is not plain text.
  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  mark(1);
  push(ascii("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"));
  mark(2);
  push(ascii("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"));
  mark(3);
  push(ascii(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${round(pageWidth)} ${round(pageHeight)}] ` +
    `/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj\n`,
  ));

  mark(4);
  push(ascii(`4 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`));
  push(contentBytes);
  push(ascii("endstream\nendobj\n"));

  mark(5);
  push(ascii(
    `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
    `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ${compressed ? "/FlateDecode" : "[ ]"} ` +
    `/Length ${pixelBytes.length} >>\nstream\n`,
  ));
  push(pixelBytes);
  push(ascii("\nendstream\nendobj\n"));

  const xrefStart = length;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let objectNumber = 1; objectNumber <= 5; objectNumber += 1) {
    xref += `${String(offsets[objectNumber]).padStart(10, "0")} 00000 n \n`;
  }
  push(ascii(xref));
  push(ascii(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`));

  const output = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return output;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
