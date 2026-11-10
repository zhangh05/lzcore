import { isDesktop } from '../desktop/bridge';

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Save through the native dialog on desktop; cancellation is not a failure. */
export async function saveBlob(blob: Blob, filename: string, mime = blob.type): Promise<string | null> {
  const host = window as Window & {pywebview?: {api?: {save_file?: (name: string, data: string, mime: string) => Promise<{ok: boolean; path?: string; error?: string}>}}};
  const save = host.pywebview?.api?.save_file;
  if (!save && !isDesktop()) { downloadBlob(blob, filename); return null; }
  if (!save) throw new Error('桌面连接尚未就绪，请稍后重试');
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('文件读取失败，请重试导出'));
    reader.readAsDataURL(blob);
  });
  const result = await save(filename, data, mime);
  if (result.error === 'cancelled') return null;
  if (!result.ok || !result.path) throw new Error(result.error || '文件保存失败，请重试');
  return result.path;
}
