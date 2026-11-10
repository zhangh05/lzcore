import { useEffect, useState } from "react";
import type { TopologyLink } from "./topologyDocument";
import {
  drawingColorHex,
  linkDrawingAppearance,
} from "./topologyDrawingAppearance";

const PRESETS = [
  { label: "中性灰", color: "#66717a" },
  { label: "黑色", color: "#000000" },
  { label: "Cisco蓝", color: "#1262aa" },
  { label: "科技蓝", color: "#2563eb" },
  { label: "绿色", color: "#10b981" },
  { label: "橙色", color: "#f59e0b" },
  { label: "红色", color: "#ef4444" },
  { label: "紫色", color: "#8b5cf6" },
  { label: "青色", color: "#06b6d4" },
];

export function LinkColorControl({
  link,
  onChange,
}: {
  link: TopologyLink;
  onChange: (color?: string) => void;
}) {
  const appearance = linkDrawingAppearance(link);
  const [draft, setDraft] = useState(appearance.color);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(appearance.color);
    setError("");
  }, [link.link_id, appearance.color]);
  const apply = () => {
    const value = draft.trim();
    if (value === appearance.color) {
      setError("");
      return;
    }
    if (!value) {
      onChange(undefined);
      setDraft(linkDrawingAppearance({}).color);
      setError("");
      return;
    }
    if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value)) {
      setError("请输入完整的 Hex 颜色，例如 #000000");
      return;
    }
    onChange(drawingColorHex(value));
    setError("");
  };
  return (
    <div className="inspector-field">
      <div className="link-color-heading">
        <span>连线颜色</span>
        {link.style?.color && (
          <button
            type="button"
            className="link-style-reset-btn"
            onClick={() => onChange(undefined)}
          >
            恢复默认颜色
          </button>
        )}
      </div>
      <span className="inspector-label" data-testid="link-color-source">
        {appearance.source === "custom" ? "自定义" : "默认"} ·{" "}
        {appearance.color}
      </span>
      <div className="link-color-grid">
        {PRESETS.map((preset) => (
          <button
            key={preset.color}
            type="button"
            className={`link-color-swatch ${drawingColorHex(appearance.color) === preset.color ? "active" : ""}`}
            style={{ backgroundColor: preset.color }}
            title={`${preset.label} (${preset.color})`}
            aria-label={preset.label}
            onClick={() => onChange(preset.color)}
          />
        ))}
      </div>
      <div className="link-custom-color-row">
        <input
          type="color"
          className="link-color-picker"
          value={drawingColorHex(appearance.color)}
          aria-label="自定义拾色器"
          onChange={(e) => onChange(e.target.value)}
        />
        <input
          type="text"
          className="link-color-text"
          aria-label="连线 Hex 颜色"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "link-color-error" : undefined}
          placeholder="Hex 颜色如 #000000"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError("");
          }}
          onBlur={apply}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            }
            if (e.key === "Escape") {
              setDraft(appearance.color);
              setError("");
            }
          }}
        />
      </div>
      {error && (
        <span id="link-color-error" className="link-color-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
