import { useEffect } from "react";
import { canvasLinkDescription, compactInterfaceLabel } from "./canvasLabels";
import type { CanvasElementSpec, Cy, Props } from "./canvasRendererTypes";
import { applyElements, canvasItemDefaults } from "./canvasSceneProjection";
import { netOpsIconForDeviceType } from "./netopsCanvasAssets";
import type { Topology } from "./topologyDocument";
import {
  drawingContrastUnderlay,
  linkDrawingAppearance,
} from "./topologyDrawingAppearance";
import { CANVAS_ACCENT } from "./topologyPalette";

export type useCanvasScenePorts = {
  connectingFromRef: import("react").MutableRefObject<string | null>;
  cyRef: import("react").MutableRefObject<Cy | null>;
  initialTopologyIdRef: import("react").MutableRefObject<string | null>;
  props: Props;
  reconciledTopologyRef: import("react").MutableRefObject<Topology | null>;
  rendererReady: boolean;
  setViewport: import("react").Dispatch<
    import("react").SetStateAction<{ x: number; y: number; zoom: number }>
  >;
  theme: string;
  viewport: { x: number; y: number; zoom: number };
};

export function useCanvasScene({
  connectingFromRef,
  cyRef,
  initialTopologyIdRef,
  props,
  reconciledTopologyRef,
  rendererReady,
  setViewport,
  theme,
  viewport,
}: useCanvasScenePorts) {
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const dimmed = new Set(props.dimmedNodeIds || []);
    const nodeIds = new Set(props.topology.nodes.map((node) => node.node_id));
    const dimClass = (id: string, base: string) =>
      dimmed.has(id) ? `${base} filtered-out`.trim() : base;
    const elements: CanvasElementSpec[] = [
      ...props.topology.nodes.map((node) => {
        const type = node.device_type || "switch";
        const observationStatus =
          props.nodeObservationStatus?.[node.node_id] || null;
        const vendorTint = "#fbfcfd";
        const caption = props.nodeOverlayLines?.[node.node_id] || "";
        const name = node.display_name || "未命名设备";
        const ipAlreadyInName =
          Boolean(node.ip) && name.includes(String(node.ip));
        const subtitle = caption || (ipAlreadyInName ? "" : node.ip || "");
        const label = subtitle ? `${name}\n${subtitle}` : name;
        const isLocked = Boolean(node.lock_group);
        const classes = [
          subtitle ? "drawing-node has-overlay" : "drawing-node",
          isLocked ? "is-locked" : "",
          props.compactMode ? "compact" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return {
          group: "nodes",
          classes: dimClass(node.node_id, classes),
          data: {
            id: node.node_id,
            label,
            observationStatus,
            vendorTint,
            icon: netOpsIconForDeviceType(type),
            lock_group: node.lock_group,
          },
          position: { x: node.x, y: node.y },
        };
      }),
      ...(props.topology.canvas_items || []).map((item) => {
        const style = { ...canvasItemDefaults[item.kind], ...item.style };
        const isText = item.kind === "text";
        return {
          group: "nodes",
          classes: dimClass(
            `canvas-${item.item_id}`,
            `canvas-item canvas-item-${item.kind}`,
          ),
          data: {
            id: `canvas-${item.item_id}`,
            label: item.text,
            shape: item.kind === "ellipse" ? "ellipse" : "roundrectangle",
            width: item.width,
            height: item.height,
            fill: isText ? "transparent" : style.fill,
            border: isText
              ? theme === "dark"
                ? "#64748b"
                : "#94a3b8"
              : style.border,
            textColor: isText
              ? theme === "dark"
                ? "#f1f5f9"
                : "#0f172a"
              : style.color,
            fillOpacity: isText ? 0 : 0.28,
            borderWidth: isText
              ? 1.5
              : Math.max(2, (style as any).borderWidth || 2),
            fontSize: isText ? 14 : 13,
            labelOpacity: 1,
            textMaxWidth: Math.max(24, item.width - 16),
          },
          position: { x: item.x, y: item.y },
        };
      }),
      // Do not let stale/imported links with a missing endpoint reach the
      // renderer. Cytoscape rejects those elements and can otherwise leave a
      // blank canvas even though the surviving drawing is valid.
      //
      // `label`, `srcPort` and `tgtPort` are deliberately absent: they are owned
      // by the interface-label effect below, which is the only thing that knows
      // the zoom and the 接口标签 switch. Listing them here made reconciliation
      // write them back as empty strings, and that effect only re-runs when
      // `props.topology.links` changes identity — so any reconciliation that
      // left `links` alone silently blanked every interface label until the
      // next zoom. Measured: idling on the page, the labels vanished on their
      // own after 6.4s and never returned.
      ...props.topology.links
        .filter(
          (link) =>
            nodeIds.has(link.source_node_id) &&
            nodeIds.has(link.target_node_id),
        )
        .map((link) => {
          const appearance = linkDrawingAppearance(link);
          const contrast = drawingContrastUnderlay(
            appearance.color,
            theme === "dark",
          );
          const edgeWidth = appearance.width;
          return {
            group: "edges",
            // A link is only as visible as its endpoints; dimming one end and
            // leaving the edge bright would draw attention to nothing.
            classes:
              dimmed.has(link.source_node_id) || dimmed.has(link.target_node_id)
                ? "filtered-out"
                : "",
            data: {
              id: link.link_id,
              source: link.source_node_id,
              target: link.target_node_id,
              visible: 1,
              edgeColor: appearance.color,
              contrastColor: contrast.color,
              contrastOpacity: contrast.opacity,
              contrastPadding: edgeWidth / 2 + 1,
              selectedContrastPadding: Math.max(4, edgeWidth + 1.5) / 2 + 1,
              // The state is carried by shape and weight as well as colour, so a
              // down link is still identifiable when the red is not — colour-blind
              // readers, greyscale prints, and screenshots pasted into a report.
              edgeStyle: appearance.lineStyle,
              edgeWidth,
              curveStyle: link.style?.curve_style || "auto",
              bezierDist: link.style?.curve_reverse ? -45 : 45,
              selectedEdgeWidth: Math.max(4, edgeWidth + 1.5),
            },
          };
        }),
    ];
    applyElements(
      cy,
      elements,
      connectingFromRef.current,
      reconciledTopologyRef.current !== props.topology,
    );
    reconciledTopologyRef.current = props.topology;
    if (initialTopologyIdRef.current !== props.topology.topology_id) {
      initialTopologyIdRef.current = props.topology.topology_id;
      window.setTimeout(() => {
        cy.resize();
        cy.fit(undefined, 48);
        if (cy.zoom() > 1.0) {
          cy.zoom(1.0);
          cy.center();
        }
        setViewport({ ...cy.pan(), zoom: cy.zoom() });
      }, 0);
    }
  }, [
    rendererReady,
    props.topology,
    props.dimmedNodeIds,
    props.nodeObservationStatus,
    props.nodeOverlayLines,
    props.compactMode,
    theme,
  ]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.batch(() => {
      cy.$(".collaboration-change").forEach((element) =>
        element.removeClass("collaboration-change"),
      );
      for (const id of props.highlightedIds || [])
        cy.getElementById(id).addClass("collaboration-change");
    });
  }, [rendererReady, props.highlightedIds, props.topology]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.style()
      .selector("node.collaboration-change")
      .style({
        "underlay-color": CANVAS_ACCENT[theme === "dark" ? "dark" : "light"],
        "underlay-opacity": 0.22,
        "underlay-padding": 10,
      })
      .selector("edge.collaboration-change")
      .style({
        "underlay-color": CANVAS_ACCENT[theme === "dark" ? "dark" : "light"],
        "underlay-opacity": 0.25,
        "underlay-padding": 5,
      })
      .update();
  }, [rendererReady, theme]);

  // Interface labels are display-only controls. Updating edge data in place
  // keeps positions, selection, and the fixed sheet intact.
  const portsVisible = props.showInterfaces && viewport.zoom >= 0.55;
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const linksById = new Map(
      props.topology.links.map((link) => [link.link_id, link]),
    );
    // Zoomed far out, interface names are noise: they overlap and hide the
    // shape of the network. Level of detail is driven by the viewport.
    cy.batch(() => {
      cy.$("edge").forEach((edge) => {
        const link = linksById.get(edge.id());
        if (!link) return;
        const values = {
          label: canvasLinkDescription(link),
          srcPort:
            portsVisible && link.source_interface
              ? compactInterfaceLabel(link.source_interface)
              : "",
          tgtPort:
            portsVisible && link.target_interface
              ? compactInterfaceLabel(link.target_interface)
              : "",
          visible: 1,
        };
        for (const [key, value] of Object.entries(values))
          if (edge.data(key) !== value) edge.data(key, value);
      });
    });
  }, [rendererReady, props.topology.links, portsVisible]);

  // Level of detail: past a zoom-out threshold, labels stop being readable
  // and start being the reason the diagram looks like a mess.
  //
  // `props.topology` is a dependency on purpose. `labelOpacity` is owned here
  // rather than in the element spec, so this effect has to re-assert it after
  // every reconciliation — otherwise a reconcile that happens to run while the
  // view is zoomed out puts the labels straight back on. It is declared after
  // the elements effect, so within one commit it has the last word.
  const labelsVisible = viewport.zoom >= 0.32;
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !rendererReady) return;
    const opacity = labelsVisible ? 1 : 0;
    cy.batch(() => {
      cy.$("node").forEach((node) => {
        if (node.data("labelOpacity") !== opacity)
          node.data("labelOpacity", opacity);
      });
    });
  }, [rendererReady, labelsVisible, props.topology]);
}
