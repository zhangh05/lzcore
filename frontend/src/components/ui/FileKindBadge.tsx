const TONES: Record<string, string> = {
  md: "doc", markdown: "doc", txt: "doc", text: "doc", docx: "doc", doc: "doc", pdf: "pdf", pptx: "doc", html: "doc",
  csv: "data", xlsx: "data", xls: "data", json: "data", yaml: "data", yml: "data", xml: "data", log: "data",
  zip: "archive", tar: "archive", gz: "archive",
  png: "media", jpg: "media", jpeg: "media", gif: "media", webp: "media", svg: "media", mp3: "media", mp4: "media", wav: "media",
};

const SHORT: Record<string, string> = { markdown: "MD", text: "TXT", binary: "BIN", jpeg: "JPG" };

/** Extension mark for file rows. Decorative: the row text already names the kind. */
export function FileKindBadge({ kind, name }: { kind?: string; name?: string }) {
  const fromName = name && name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const key = String(kind || fromName || "").toLowerCase();
  const label = (SHORT[key] || key || "FILE").slice(0, 4).toUpperCase();
  const tone = TONES[key] || TONES[fromName.toLowerCase()] || "other";
  return <span className={`ui-file-kind is-${tone}`} aria-hidden="true">{label}</span>;
}
