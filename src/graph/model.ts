/**
 * The public graph model shared by the canvas and its callers. It carries only
 * what the renderer needs; application payloads live in `data` and are never
 * read by the renderer.
 */

/** Outline drawn for a node. */
export type NodeShape = "circle" | "square" | "triangle" | "diamond" | "pentagon";

export interface GraphNode<Data = unknown> {
  id: string;
  label?: string;
  data?: Data;
  /** Fixed radius in graph units; defaults to the config value. */
  radius?: number;
  color?: string;
  shape?: NodeShape;
  /** Per-node many-body strength; overrides the configured charge. */
  charge?: number;
  /** Initial position in graph units. */
  x?: number;
  y?: number;
  /** Fixed position; `null` releases the pin. */
  fx?: number | null;
  fy?: number | null;
  /** Anchors keep their labels while the map is zoomed out. */
  hub?: boolean;
}

export interface GraphLink<Data = unknown> {
  id?: string;
  source: string;
  target: string;
  data?: Data;
  color?: string;
  width?: number;
  dashed?: boolean;
  distance?: number;
  strength?: number;
}

export type Endpoint = string | number | { id?: unknown };

/**
 * A link whose endpoints are ids or, after the layout simulation has resolved
 * them, node objects. Kept for the internal force-graph helpers; callers can
 * keep using the plain {@link GraphLink} shape.
 */
export type ResolvedLink<Data = unknown> = Omit<GraphLink<Data>, "source" | "target"> & {
  source: Endpoint;
  target: Endpoint;
};

/** One direct relationship of a node: the other node plus the link that joins them. */
export interface Connection<NodeData = unknown, LinkData = unknown> {
  node: GraphNode<NodeData>;
  link: ResolvedLink<LinkData>;
}

/** Compare an endpoint by id whether or not the simulation resolved it to a node. */
export function endpointId(endpoint: Endpoint): string {
  if (!endpoint || typeof endpoint !== "object") return String(endpoint);
  const id = endpoint.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : "";
}

/**
 * Direct relationships of one node. The force graph rewrites link endpoints to
 * node objects while callers pass unresolved ids, so both forms are accepted
 * and compared by id.
 */
export function connectionsFor<NodeData = unknown, LinkData = unknown>(
  id: string,
  graph: {
    nodes: readonly GraphNode<NodeData>[];
    links: readonly ResolvedLink<LinkData>[];
  },
): Connection<NodeData, LinkData>[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const connections: Connection<NodeData, LinkData>[] = [];
  for (const link of graph.links) {
    const source = endpointId(link.source);
    const target = endpointId(link.target);
    const otherId = source === id ? target : target === id ? source : null;
    if (otherId === null) continue;
    const node = byId.get(otherId);
    if (node) connections.push({ node, link });
  }
  return connections;
}
