/** TopologyItemControls responsibilities, independent of the workspace screen. */
import { useEffect, useState } from "react";
import {
  IconArrowsX,
  IconBox,
  IconCloud,
  IconLayers,
  IconServer,
  IconShield,
  IconSplit,
  IconWifi,
} from "../../../../frontend/src/components/Icon";
import { netOpsIconForDeviceType } from "./netopsCanvasAssets";
import type { TopologyCanvasItem } from "./topologyDocument";

export function CanvasItemDimensionInputs({
  item,
  onChange,
}: {
  item: TopologyCanvasItem;
  onChange: (patch: { width?: number; height?: number }) => void;
}) {
  const [widthStr, setWidthStr] = useState(() =>
    String(Math.round(item.width)),
  );
  const [heightStr, setHeightStr] = useState(() =>
    String(Math.round(item.height)),
  );

  useEffect(() => {
    setWidthStr(String(Math.round(item.width)));
  }, [item.item_id, item.width]);

  useEffect(() => {
    setHeightStr(String(Math.round(item.height)));
  }, [item.item_id, item.height]);

  const commitWidth = (val: string) => {
    const num = parseInt(val, 10);
    if (!Number.isNaN(num) && num > 0) {
      const clamped = Math.min(10000, Math.max(1, num));
      setWidthStr(String(clamped));
      if (clamped !== Math.round(item.width)) {
        onChange({ width: clamped });
      }
    } else {
      setWidthStr(String(Math.round(item.width)));
    }
  };

  const commitHeight = (val: string) => {
    const num = parseInt(val, 10);
    if (!Number.isNaN(num) && num > 0) {
      const clamped = Math.min(10000, Math.max(1, num));
      setHeightStr(String(clamped));
      if (clamped !== Math.round(item.height)) {
        onChange({ height: clamped });
      }
    } else {
      setHeightStr(String(Math.round(item.height)));
    }
  };

  return (
    <div className="inspector-dimension-grid">
      <label className="inspector-field">
        宽度
        <input
          type="number"
          min="1"
          max="10000"
          value={widthStr}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            const raw = e.target.value;
            setWidthStr(raw);
            const num = parseInt(raw, 10);
            if (!Number.isNaN(num) && num >= 1 && num <= 10000) {
              onChange({ width: num });
            }
          }}
          onBlur={(e) => commitWidth(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitWidth((e.target as HTMLInputElement).value);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </label>
      <label className="inspector-field">
        高度
        <input
          type="number"
          min="1"
          max="10000"
          value={heightStr}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            const raw = e.target.value;
            setHeightStr(raw);
            const num = parseInt(raw, 10);
            if (!Number.isNaN(num) && num >= 1 && num <= 10000) {
              onChange({ height: num });
            }
          }}
          onBlur={(e) => commitHeight(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitHeight((e.target as HTMLInputElement).value);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </label>
    </div>
  );
}

export function DeviceTypeIcon({
  deviceType,
  size = 16,
}: {
  deviceType: string;
  size?: number;
}) {
  const netOpsIcon = netOpsIconForDeviceType(deviceType);
  if (netOpsIcon)
    return (
      <img
        src={netOpsIcon}
        alt=""
        width={size}
        height={size}
        style={{ objectFit: "contain" }}
      />
    );
  const type = deviceType?.toLowerCase() || "";
  if (type.includes("router")) return <IconSplit size={size} />;
  if (type === "l3_switch" || type.includes("layer3"))
    return <IconLayers size={size} />;
  if (type.includes("switch")) return <IconArrowsX size={size} />;
  if (type.includes("firewall") || type.includes("fw") || type.includes("sec"))
    return <IconShield size={size} />;
  if (type.includes("server") || type.includes("host"))
    return <IconServer size={size} />;
  if (type.includes("wireless") || type.includes("ap") || type.includes("wifi"))
    return <IconWifi size={size} />;
  if (type.includes("cloud")) return <IconCloud size={size} />;
  return <IconBox size={size} />;
}
