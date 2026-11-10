/** topologyPng responsibilities, independent of the workspace screen. */
import { rgbFromRgba, type RgbImage } from "./topologyPdf";

export async function pngToRgbImage(dataUrl: string): Promise<RgbImage> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("png_decode_failed"));
    element.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext("2d");
  if (!context || !canvas.width || !canvas.height)
    throw new Error("png_decode_failed");
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  return rgbFromRgba(data, canvas.width, canvas.height);
}
