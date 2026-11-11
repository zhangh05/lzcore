/**
 * 文件预览：按 mime_type 选择呈现方式。
 * - 图片 / 音频 / 视频 / PDF：GET /api/storage/files/<id>/preview（后端只对这些类型、且仅 active 文件提供，
 *   带 nosniff + sandbox CSP）。读取不需要本地写令牌。
 * - 其他：GET /content 文本（最多 20000 字），二进制或读取失败时提示下载，不把乱码当正文。
 */
import { useState } from "react";
import { enc } from "../../api/client";
import { useApi } from "../../kit/useApi";
import { LoadState } from "../../kit/ui";

export type PreviewKind = "image" | "audio" | "video" | "pdf" | "text";

export function previewKind(mime?: string): PreviewKind {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (m === "application/pdf") return "pdf";
  return "text";
}

export function FilePreview({ ws, fileId, mime, name, active }: { ws: string; fileId: string; mime?: string; name: string; active: boolean }) {
  const kind = previewKind(mime);
  const base = `/api/storage/files/${enc(fileId)}`;
  const src = `${base}/preview?workspace_id=${enc(ws)}`;
  const [content] = useApi(kind === "text" ? `${base}/content` : null, { workspace_id: ws, limit: 20000 });
  const [failed, setFailed] = useState(false);
  const download = `${base}/download?workspace_id=${enc(ws)}`;

  if (kind !== "text" && !active) return <p className="muted" data-testid="file-preview-unavailable">回收站中的文件不提供在线预览，请先恢复或下载。</p>;
  if (kind !== "text" && failed) {
    return <p className="inline-alert tone-warn" role="alert" data-testid="file-preview-failed">预览加载失败（文件可能已移除或格式不受支持）。<a href={download}>下载原件</a></p>;
  }
  if (kind === "image") return <figure className="file-preview-media" data-testid="file-preview"><img src={src} alt={name} onError={() => setFailed(true)} /></figure>;
  if (kind === "audio") return <div className="file-preview-media" data-testid="file-preview"><audio src={src} controls preload="metadata" onError={() => setFailed(true)} aria-label={name} /></div>;
  if (kind === "video") return <div className="file-preview-media" data-testid="file-preview"><video src={src} controls preload="metadata" onError={() => setFailed(true)} aria-label={name} /></div>;
  if (kind === "pdf") {
    return (
      <div className="file-preview-media" data-testid="file-preview">
        <object data={src} type="application/pdf" aria-label={name} className="file-preview-pdf">
          <p className="muted">浏览器无法内嵌显示此 PDF。<a href={src} target="_blank" rel="noopener noreferrer">在新标签页打开</a> 或 <a href={download}>下载</a>。</p>
        </object>
      </div>
    );
  }
  return (
    <LoadState value={content}>{(d) => {
      const body = d as { content?: unknown; truncated?: boolean; total_chars?: number; binary?: boolean };
      if (body.binary || typeof body.content !== "string") return <p className="muted" data-testid="file-preview">这是二进制文件，没有可显示的文本内容。<a href={download}>下载原件</a></p>;
      return (
        <>
          <pre className="json-block file-preview-text" data-testid="file-preview">{body.content}</pre>
          {body.truncated ? <p className="muted">只显示了前 {body.content.length} 个字符{typeof body.total_chars === "number" ? `（共 ${body.total_chars}）` : ""}，完整内容请下载。</p> : null}
        </>
      );
    }}</LoadState>
  );
}
