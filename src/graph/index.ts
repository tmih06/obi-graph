// Public entry: the canvas component and the model it consumes. It renders an
// Obsidian-style force-directed graph view on a single canvas. Import the
// stylesheet once per app: `import "obi-graph/styles.css"` (or the local path
// `./graph/graph.css`).

export { GraphCanvas, type GraphCanvasProps, type Theme } from "./graph-canvas.tsx";
export {
  connectionsFor,
  endpointId,
  type Connection,
  type Endpoint,
  type GraphLink,
  type GraphNode,
  type NodeShape,
  type ResolvedLink,
} from "./model.ts";
export type { GraphConfig, GraphValue } from "./config.ts";
export type { GraphMetrics } from "./metrics.ts";
