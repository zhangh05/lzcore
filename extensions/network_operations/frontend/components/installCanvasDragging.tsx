import type { AlignGuide, Cy, CyNode, Props } from "./canvasRendererTypes";
import {
  alignmentPreviewTarget,
  nearbySnapTargets,
  resolveDragAxis,
} from "./topologyDragSnap";
import { referenceTargets } from "./TopologyReferenceLines";

export type installCanvasDraggingPorts = {
  cy: Cy;
  grabAnchorRef: import("react").MutableRefObject<{
    id: string;
    x: number;
    y: number;
  } | null>;
  guideSignatureRef: import("react").MutableRefObject<string>;
  host: HTMLDivElement | null;
  lockGroupInitialPositionsRef: import("react").MutableRefObject<
    Map<string, { x: number; y: number }>
  >;
  propsRef: import("react").MutableRefObject<Props>;
  setAlignGuides: import("react").Dispatch<
    import("react").SetStateAction<AlignGuide[]>
  >;
  setViewport: import("react").Dispatch<
    import("react").SetStateAction<{ x: number; y: number; zoom: number }>
  >;
  snapResidualRef: import("react").MutableRefObject<{ x: number; y: number }>;
  snapTargetRef: import("react").MutableRefObject<{
    x: string | null;
    y: string | null;
  }>;
};

export function installCanvasDragging({
  cy,
  grabAnchorRef,
  guideSignatureRef,
  host,
  lockGroupInitialPositionsRef,
  propsRef,
  setAlignGuides,
  setViewport,
  snapResidualRef,
  snapTargetRef,
}: installCanvasDraggingPorts) {
  cy.on("grab", "node", (event) => {
    const node = event.target as CyNode | undefined;
    if (!node || node.id().startsWith("group-") || grabAnchorRef.current)
      return;
    const grabbedId = node.id();
    const currentNodes = propsRef.current.topology.nodes;
    const activeLockGroups = new Set<string>();

    const movingRegions = new Set<string>();
    if (propsRef.current.moveRegionMembers) {
      if (grabbedId.startsWith("canvas-"))
        movingRegions.add(grabbedId.slice(7));
      cy.$("node:selected").forEach((sel) => {
        if (sel.id().startsWith("canvas-"))
          movingRegions.add(sel.id().slice(7));
      });
      currentNodes.forEach((n) => {
        if (n.region_id && movingRegions.has(n.region_id) && n.lock_group)
          activeLockGroups.add(n.lock_group);
      });
    }
    const grabbedNodeData = currentNodes.find((n) => n.node_id === grabbedId);
    if (grabbedNodeData?.lock_group) {
      activeLockGroups.add(grabbedNodeData.lock_group);
    }
    cy.$("node:selected").forEach((sel) => {
      const d = currentNodes.find((n) => n.node_id === sel.id());
      if (d?.lock_group) activeLockGroups.add(d.lock_group);
    });

    const initMap = new Map<string, { x: number; y: number }>();
    if (activeLockGroups.size > 0 || movingRegions.size > 0) {
      currentNodes.forEach((n) => {
        if (
          (n.lock_group && activeLockGroups.has(n.lock_group)) ||
          (n.region_id && movingRegions.has(n.region_id))
        ) {
          const cyElem = cy.getElementById(n.node_id) as CyNode;
          if (cyElem && cyElem.length) {
            const pos = cyElem.position();
            initMap.set(n.node_id, { x: pos.x, y: pos.y });
          }
        }
      });
    }
    lockGroupInitialPositionsRef.current = initMap;
    grabAnchorRef.current = {
      id: grabbedId,
      x: node.position().x,
      y: node.position().y,
    };
  });
  cy.on("drag", "node", (event) => {
    const node = event.target as CyNode | undefined;
    // Dragging an object moves it in every mode. The mode decides what a
    // *click* does, not whether the canvas is editable — a drag that snaps
    // back on release is worse than no drag at all.
    if (!node || node.id().startsWith("group-")) return;
    if (grabAnchorRef.current && grabAnchorRef.current.id !== node.id()) return;
    setViewport({ ...cy.pan(), zoom: cy.zoom() });
    const selectedIds = new Set(cy.$("node:selected").map((item) => item.id()));
    const halfW = node.width() / 2;
    const halfH = node.height() / 2;

    if (!grabAnchorRef.current) {
      const grabbedId = node.id();
      const currentNodes = propsRef.current.topology.nodes;
      const activeLockGroups = new Set<string>();
      const movingRegions = new Set<string>();
      if (propsRef.current.moveRegionMembers) {
        if (grabbedId.startsWith("canvas-"))
          movingRegions.add(grabbedId.slice(7));
        cy.$("node:selected").forEach((sel) => {
          if (sel.id().startsWith("canvas-"))
            movingRegions.add(sel.id().slice(7));
        });
        currentNodes.forEach((n) => {
          if (n.region_id && movingRegions.has(n.region_id) && n.lock_group)
            activeLockGroups.add(n.lock_group);
        });
      }
      const grabbedNodeData = currentNodes.find((n) => n.node_id === grabbedId);
      if (grabbedNodeData?.lock_group)
        activeLockGroups.add(grabbedNodeData.lock_group);
      cy.$("node:selected").forEach((sel) => {
        const d = currentNodes.find((n) => n.node_id === sel.id());
        if (d?.lock_group) activeLockGroups.add(d.lock_group);
      });
      const initMap = new Map<string, { x: number; y: number }>();
      if (activeLockGroups.size > 0 || movingRegions.size > 0) {
        currentNodes.forEach((n) => {
          if (
            (n.lock_group && activeLockGroups.has(n.lock_group)) ||
            (n.region_id && movingRegions.has(n.region_id))
          ) {
            const cyElem = cy.getElementById(n.node_id) as CyNode;
            if (cyElem && cyElem.length) {
              initMap.set(n.node_id, { ...cyElem.position() });
            }
          }
        });
      }
      lockGroupInitialPositionsRef.current = initMap;
      grabAnchorRef.current = {
        id: grabbedId,
        x: node.position().x,
        y: node.position().y,
      };
    }

    const lockedPeerIds = new Set(lockGroupInitialPositionsRef.current.keys());
    // Both ends of a guide use the live renderer's body geometry. Fixed
    // 94x76 target sizes produced guides inside the actual 76x60 icons,
    // and diverged further in compact mode. Labels are not body edges.
    const regionById = new Map(
      propsRef.current.topology.nodes.map((n) => [n.node_id, n.region_id]),
    );
    const dimmed = new Set(propsRef.current.dimmedNodeIds || []);
    const otherIds = [
      ...propsRef.current.topology.nodes.map((item) => item.node_id),
      ...(propsRef.current.topology.canvas_items || []).map(
        (item) => `canvas-${item.item_id}`,
      ),
    ].filter(
      (id) =>
        id !== node.id() &&
        !selectedIds.has(id) &&
        !lockedPeerIds.has(id) &&
        !dimmed.has(id),
    );
    const others = otherIds.flatMap((id) => {
      const other = cy.getElementById(id) as CyNode;
      if (!other.length) return [];
      return [
        {
          id,
          ...other.position(),
          halfW: other.width() / 2,
          halfH: other.height() / 2,
          region: regionById.get(id),
        },
      ];
    });
    const position = node.position();
    // Undo the prior view correction to recover the continuous pointer path.
    const residual = snapResidualRef.current;
    const rawX = position.x - residual.x;
    const rawY = position.y - residual.y;
    const moving = {
      id: node.id(),
      x: rawX,
      y: rawY,
      halfW,
      halfH,
      region: regionById.get(node.id()),
    };
    const visibleOthers = others.filter((other) => {
      const x = other.x * cy.zoom() + cy.pan().x,
        y = other.y * cy.zoom() + cy.pan().y;
      return (
        x >= 0 &&
        x <= (host?.clientWidth || 0) &&
        y >= 0 &&
        y <= (host?.clientHeight || 0)
      );
    });
    const referenceId = propsRef.current.alignmentReferenceId;
    const candidates = referenceId
      ? others.filter((other) => other.id === referenceId)
      : visibleOthers;
    const deviceTargets = (axis: "x" | "y") =>
      propsRef.current.smartGuidesEnabled === false
        ? []
        : nearbySnapTargets(axis, moving, candidates, cy.zoom(), true);
    const devicesX = deviceTargets("x"),
      devicesY = deviceTargets("y");
    const targets = (axis: "x" | "y") => [
      ...referenceTargets(
        propsRef.current.referenceLines || [],
        axis,
        axis === "x" ? halfW : halfH,
      ),
      ...(axis === "x" ? devicesX : devicesY),
    ];
    const snappedX = resolveDragAxis(
      rawX,
      cy.zoom(),
      targets("x"),
      snapTargetRef.current.x,
      Boolean(propsRef.current.gridSnapEnabled),
    );
    const snappedY = resolveDragAxis(
      rawY,
      cy.zoom(),
      targets("y"),
      snapTargetRef.current.y,
      Boolean(propsRef.current.gridSnapEnabled),
    );
    snapTargetRef.current = {
      x: snappedX.target?.key || null,
      y: snappedY.target?.key || null,
    };
    const nextX = snappedX.position;
    const nextY = snappedY.position;
    const correctionX = nextX - position.x;
    const correctionY = nextY - position.y;
    snapResidualRef.current = { x: nextX - rawX, y: nextY - rawY };
    if (nextX !== position.x || nextY !== position.y)
      node.position({ x: nextX, y: nextY });

    // Cytoscape moves selected peers by the pointer delta. Apply the same
    // preview correction so their spacing stays unchanged before release.
    cy.$("node:selected").forEach((peer) => {
      if (peer.id() === node.id() || lockedPeerIds.has(peer.id())) return;
      const pos = (peer as CyNode).position();
      (peer as CyNode).position({
        x: pos.x + correctionX,
        y: pos.y + correctionY,
      });
    });

    // Synchronize all peer nodes in the same lock group with the anchor node's displacement
    if (grabAnchorRef.current && grabAnchorRef.current.id === node.id()) {
      const dx = nextX - grabAnchorRef.current.x;
      const dy = nextY - grabAnchorRef.current.y;
      const initMap = lockGroupInitialPositionsRef.current;
      if (initMap.size > 0) {
        initMap.forEach((initPos, peerId) => {
          if (peerId === node.id()) return;
          const peerCyNode = cy.getElementById(peerId) as CyNode;
          if (peerCyNode && peerCyNode.length) {
            peerCyNode.position({
              x: initPos.x + dx,
              y: initPos.y + dy,
            });
          }
        });
      }
    }

    const lines: AlignGuide[] = [];
    // Manual references and grid attraction need visible feedback too.
    if (snappedX.target?.source === null)
      lines.push({
        x1: snappedX.target.line,
        x2: snappedX.target.line,
        y1: -cy.pan().y / cy.zoom(),
        y2: ((host?.clientHeight || 0) - cy.pan().y) / cy.zoom(),
        aligned: snappedX.aligned,
      });
    if (snappedY.target?.source === null)
      lines.push({
        y1: snappedY.target.line,
        y2: snappedY.target.line,
        x1: -cy.pan().x / cy.zoom(),
        x2: ((host?.clientWidth || 0) - cy.pan().x) / cy.zoom(),
        aligned: snappedY.aligned,
      });
    const previewX = snappedX.target?.source
      ? snappedX.target
      : alignmentPreviewTarget(rawX, cy.zoom(), devicesX, null);
    const previewY = snappedY.target?.source
      ? snappedY.target
      : alignmentPreviewTarget(rawY, cy.zoom(), devicesY, null);
    if (previewX) {
      const near = others.filter((other) => other.id === previewX.source);
      const top =
        Math.min(nextY - halfH, ...near.map((other) => other.y - other.halfH)) -
        12;
      const bottom =
        Math.max(nextY + halfH, ...near.map((other) => other.y + other.halfH)) +
        12;
      lines.push({
        x1: previewX.line,
        y1: top,
        x2: previewX.line,
        y2: bottom,
        aligned: snappedX.target?.key === previewX.key && snappedX.aligned,
        source: "device",
        referenceId: previewX.source || undefined,
        hint:
          previewX.offset === 0
            ? "中心线"
            : previewX.offset < 0
              ? "左边缘"
              : "右边缘",
      });
    }
    if (previewY) {
      const near = others.filter((other) => other.id === previewY.source);
      const leftEdge =
        Math.min(nextX - halfW, ...near.map((other) => other.x - other.halfW)) -
        12;
      const rightEdge =
        Math.max(nextX + halfW, ...near.map((other) => other.x + other.halfW)) +
        12;
      lines.push({
        x1: leftEdge,
        y1: previewY.line,
        x2: rightEdge,
        y2: previewY.line,
        aligned: snappedY.target?.key === previewY.key && snappedY.aligned,
        source: "device",
        referenceId: previewY.source || undefined,
        hint:
          previewY.offset === 0
            ? "中心线"
            : previewY.offset < 0
              ? "上边缘"
              : "下边缘",
      });
    }
    const signature = lines
      .map(
        (line) =>
          `${Math.round(line.x1)}:${Math.round(line.y1)}:${Math.round(line.x2)}:${Math.round(line.y2)}:${line.aligned}:${line.hint}`,
      )
      .join("|");
    if (signature !== guideSignatureRef.current) {
      guideSignatureRef.current = signature;
      setAlignGuides(lines);
    }
  });
  cy.on("free dragfree", "node", () => {
    // The correction only describes an in-progress drag; the next grab
    // starts from a position the pointer agrees with.
    snapResidualRef.current = { x: 0, y: 0 };
    snapTargetRef.current = { x: null, y: null };
    grabAnchorRef.current = null;
    lockGroupInitialPositionsRef.current.clear();
    if (!guideSignatureRef.current) return;
    guideSignatureRef.current = "";
    setAlignGuides([]);
  });
  cy.on("dragfree", "node", (event) => {
    // Persist what was actually dragged, plus the rest of the selection so a
    // multi-selection still moves together. The dragged node is included even
    // when it was not selected first, otherwise grabbing a node and letting
    // go would leave the canvas disagreeing with the renderer.
    const dragged = (event.target as CyNode | undefined)?.id?.() || "";
    const ids = new Set(cy.$("node:selected").map((node) => node.id()));
    if (dragged) ids.add(dragged);

    if (propsRef.current.moveRegionMembers) {
      const regions = new Set(
        [...ids]
          .filter((id) => id.startsWith("canvas-"))
          .map((id) => id.slice(7)),
      );
      for (const n of propsRef.current.topology.nodes)
        if (n.region_id && regions.has(n.region_id)) ids.add(n.node_id);
    }
    // Include all peer nodes from any active lock groups
    const lockGroups = new Set<string>();
    for (const id of ids) {
      const n = propsRef.current.topology.nodes.find(
        (item) => item.node_id === id,
      );
      if (n?.lock_group) lockGroups.add(n.lock_group);
    }
    if (lockGroups.size > 0) {
      for (const n of propsRef.current.topology.nodes) {
        if (n.lock_group && lockGroups.has(n.lock_group)) {
          ids.add(n.node_id);
        }
      }
    }

    // Persist the visible preview verbatim, including fractional positions.
    // Re-snapping here used to shift an already aligned object on mouse-up.
    const positions = cy
      .nodes()
      .filter((node) => ids.has(node.id()) && !node.id().startsWith("group-"))
      .map((node) => ({ element_id: node.id(), ...node.position() }));

    grabAnchorRef.current = null;
    lockGroupInitialPositionsRef.current.clear();

    if (positions.length) propsRef.current.onMoveElements(positions);
  });
}
