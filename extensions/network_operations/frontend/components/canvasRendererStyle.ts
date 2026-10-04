import { DRAWING_DEFAULTS } from "./topologyDrawingAppearance";
import { CANVAS_ACCENT, CANVAS_GROUP } from "./topologyPalette";

export type canvasRendererStylePorts = {};

export function canvasRendererStyle({}: canvasRendererStylePorts) {
  return [
    {
      selector: "node",
      style: {
        label: "data(label)",
        "text-valign": "bottom",
        "text-halign": "center",
        "text-margin-y": "8px",
        "font-family":
          'Inter, system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, sans-serif',
        "font-size": 12,
        "font-weight": 600,
        color: "#0f172a",
        "text-wrap": "wrap",
        "text-max-width": 128,
        "text-background-opacity": 0,
        "text-border-width": 0,
        width: 76,
        height: 60,
        shape: "roundrectangle",
        "border-width": DRAWING_DEFAULTS.nodeBorderWidth,
        "border-color": DRAWING_DEFAULTS.nodeBorder,
        "text-opacity": "data(labelOpacity)",
        "z-index": 10,
      },
    },
    {
      selector: "node.compact",
      style: {
        width: 52,
        height: 42,
        "font-size": 11,
        "text-max-width": 96,
        "text-margin-y": "6px",
      },
    },
    // Drawing items deliberately have no vendor field. Keeping this data
    // mapping on asset nodes prevents Cytoscape from warning on every
    // canvas refresh when it encounters a text box or an ellipse.
    {
      selector: "node[vendorTint]",
      style: { "background-color": "data(vendorTint)" },
    },
    // Canvas items and groups deliberately have no device icon. Apply
    // image mappings only to asset nodes so Cytoscape stays warning-free.
    {
      selector: "node[icon]",
      style: {
        "background-image": "data(icon)",
        "background-fit": "cover",
        "background-clip": "node",
        "background-position-x": "50%",
        "background-position-y": "50%",
      },
    },
    {
      selector: "node.has-overlay",
      style: {
        "text-wrap": "wrap",
        "text-max-width": 148,
        "font-size": 11,
        "font-weight": 500,
      },
    },
    {
      selector: "node:active",
      style: { "overlay-opacity": 0, "underlay-opacity": 0 },
    },
    {
      selector: "edge",
      style: {
        width: "data(edgeWidth)",
        opacity: "data(visible)",
        "line-color": "data(edgeColor)",
        "line-style": "data(edgeStyle)",
        "line-cap": "round",
        "line-opacity": 1,
        "underlay-color": "data(contrastColor)",
        "underlay-opacity": "data(contrastOpacity)",
        "underlay-padding": "data(contrastPadding)",
        "curve-style": "bezier",
        "control-point-step-size": 144,
        // Port connection terminal socket points (RJ45 modular socket block)
        "source-arrow-shape": "square",
        "target-arrow-shape": "square",
        "source-arrow-color": "data(edgeColor)",
        "target-arrow-color": "data(edgeColor)",
        "source-arrow-fill": "filled",
        "target-arrow-fill": "filled",
        "arrow-scale": 0.65,
        label: "data(label)",
        "font-family":
          'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
        "font-size": 10,
        "font-weight": 600,
        "min-zoomed-font-size": 0,
        color: "#0f172a",
        "text-background-shape": "roundrectangle",
        "text-background-color": "#ffffff",
        "text-background-opacity": 0.95,
        "text-border-width": 1,
        "text-border-color": "#cbd5e1",
        "text-border-opacity": 0.9,
        "text-background-padding": "2px 5px",
        "text-margin-y": "-14px",
        "source-label": "data(srcPort)",
        "target-label": "data(tgtPort)",
        "source-text-offset": 22,
        "target-text-offset": 22,
        "source-text-margin-y": 0,
        "target-text-margin-y": 0,
      },
    },
    {
      selector: "edge[edgeStyle = 'dotted']",
      style: {
        "line-style": "dashed",
        "line-dash-pattern": [0.1, 7],
        "line-cap": "round",
      },
    },
    {
      selector: "edge[edgeStyle = 'dashed']",
      style: {
        "line-style": "dashed",
        "line-dash-pattern": [8, 5],
        "line-cap": "butt",
      },
    },
    {
      selector: "edge[edgeStyle = 'solid']",
      style: {
        "line-style": "solid",
        "line-cap": "round",
      },
    },
    {
      selector: "edge[curveStyle = 'straight']",
      style: { "curve-style": "straight" },
    },
    {
      selector: "edge[curveStyle = 'taxi']",
      style: {
        "curve-style": "taxi",
        "taxi-direction": "auto",
        "taxi-turn": "50%",
        "taxi-turn-min-distance": 10,
      },
    },
    {
      selector: "edge[curveStyle = 'bezier']",
      style: {
        "curve-style": "unbundled-bezier",
        "control-point-distances": "data(bezierDist)",
        "control-point-weights": 0.5,
      },
    },
    {
      selector: "edge[curveStyle = 'unbundled-bezier']",
      style: {
        "curve-style": "unbundled-bezier",
        "control-point-distances": "data(bezierDist)",
        "control-point-weights": 0.5,
      },
    },
    {
      selector: ".canvas-item",
      style: {
        label: "data(label)",
        shape: "data(shape)",
        width: "data(width)",
        height: "data(height)",
        "background-color": "data(fill)",
        "background-opacity": "data(fillOpacity)",
        "border-color": "data(border)",
        "border-width": "data(borderWidth)",
        color: "data(textColor)",
        "font-family":
          '-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, sans-serif',
        "font-size": "data(fontSize)",
        "font-weight": 600,
        "text-wrap": "wrap",
        "text-max-width": "data(textMaxWidth)",
        "text-margin-y": 0,
        "text-valign": "center",
        "text-halign": "center",
        "text-opacity": "data(labelOpacity)",
        "z-index": 1,
      },
    },
    // A text box with no border and no fill is an invisible hit area: the
    // user sees blank canvas, right-clicks it, and gets item actions they
    // cannot explain — or aims at the glyphs and misses the box. A faint
    // dashed outline makes the box look like a text box and makes its
    // bounds honest, without the weight of a filled plate.
    //
    // `text-halign` names the side of the node the label hangs off, not the
    // alignment of the text within it. `left` therefore put the whole label
    // outside the box, flush against its left edge — a dashed rectangle with
    // its caption floating beside it. A canvas item *is* its own bound, so
    // the label belongs inside; `text-justification` is the property that
    // left-aligns a wrapped multi-line note within its block.
    {
      selector: ".canvas-item-text",
      style: {
        "background-opacity": 0,
        "border-width": 1.5,
        "border-style": "dashed",
        "border-color": "#94a3b8",
        "border-opacity": 0.65,
        "text-valign": "center",
        "text-halign": "center",
        "text-justification": "left",
        "font-family":
          '-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, sans-serif',
        "font-size": 14,
        "font-weight": 600,
        "text-max-width": "data(textMaxWidth)",
      },
    },
    {
      selector: ".canvas-item-text:selected",
      style: {
        "border-style": "solid",
        "border-width": 2,
        "border-color": CANVAS_ACCENT.light,
        "border-opacity": 1,
      },
    },
    // Selection is transient; the neutral drawing border keeps its own colour.
    {
      selector: "node:selected",
      style: {
        "border-width": 3,
        "underlay-color": CANVAS_ACCENT.light,
        "underlay-opacity": 0.16,
        "underlay-padding": 7,
      },
    },
    {
      selector: ".node-connecting",
      style: { "border-width": 3, "border-color": CANVAS_ACCENT.light },
    },
    // Filtered-out elements stay visible but recede, so the filtered view
    // keeps its context instead of looking like a different diagram.
    // One opacity value only — stacking a second one on the item fill
    // would make a filtered rectangle indistinguishable from empty space.
    {
      selector: ".filtered-out",
      style: { opacity: 0.16, "text-opacity": 0.16 },
    },
    // Selection increases width without hiding status or custom link colours.
    {
      selector: "edge:selected",
      style: {
        width: "data(selectedEdgeWidth)",
        "underlay-padding": "data(selectedContrastPadding)",
        "z-index": 20,
      },
    },
    {
      selector: ".lz-group",
      style: {
        shape: "roundrectangle",
        label: "data(label)",
        "text-valign": "top",
        "text-halign": "left",
        "text-margin-x": 14,
        "text-margin-y": 12,
        color: CANVAS_GROUP.light.text,
        "font-family":
          'Inter, system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, sans-serif',
        "font-size": 12,
        "font-weight": 600,
        width: "data(width)",
        height: "data(height)",
        "background-color": CANVAS_GROUP.light.fill,
        "background-opacity": 0.55,
        "border-color": CANVAS_GROUP.light.border,
        "border-style": "dashed",
        "border-width": 1.5,
        "background-image": "none",
        events: "no",
      },
    },
  ];
}
