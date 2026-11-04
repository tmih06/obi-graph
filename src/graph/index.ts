// Graph render engine.
//
// Public entry: the canvas component and the model it consumes. Import the
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
  type GraphNodeKind,
  type GraphRelation,
  type ResolvedLink,
} from "./model.ts";
