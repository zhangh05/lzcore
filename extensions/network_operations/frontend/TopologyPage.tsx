import NetworkOperations from "./NetworkOperations";

/**
 * A first-class route for the shared topology workspace.  The canvas still
 * consumes the canonical device, connection and Skill catalog; only its
 * surrounding chrome differs from the operations-management surface.
 */
export default function TopologyPage() {
  return <NetworkOperations topologyOnly />;
}
