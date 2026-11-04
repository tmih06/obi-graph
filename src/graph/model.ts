/**
 * The graph model shared by the canvas and its callers. It carries only what
 * the renderer needs: identity, kind, size, degree, and whether the node
 * anchors the map. Domain payloads (scores, evidence, timestamps) stay in the
 * caller and are not read by the renderer.
 */

/**
 * The renderer's node vocabulary. `segment` and `pool` are anchor kinds that
 * hold a fixed position and keep their labels; `pattern` nodes are the moving
 * leaves sized by the caller's own measure.
 */
export type GraphNodeKind = "segment" | "pattern" | "pool";

/** Edges are either a collected observation or a measured centroid similarity. */
export type GraphRelation = "observed-in" | "similarity";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  description: string;
  radius: number;
  degree: number;
  /** Pattern content type; drives the node shape. */
  media?: string;
  /** Fixed anchors (audience hubs) that must not drift and keep their labels. */
  hub?: boolean;
}

export interface GraphLink {
  id: string;
  source: string;
  target: string;
  relation: GraphRelation;
  /** Cosine similarity for `similarity` edges; absent on observations. */
  similarity?: number;
}

export interface Connection {
  node: GraphNode;
  relation: GraphRelation;
}

/** A link whose endpoints are ids or, after the simulation resolves them, nodes. */
export type ResolvedLink = Omit<GraphLink, "source" | "target"> & {
  source: Endpoint;
  target: Endpoint;
};

export type Endpoint = string | number | { id?: unknown };

/** Compare an endpoint by id whether or not d3 has resolved it to a node. */
export function endpointId(endpoint: Endpoint): string {
  if (!endpoint || typeof endpoint !== "object") return String(endpoint);
  const id = endpoint.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : "";
}

/**
 * Direct relationships of one node. The force graph rewrites link endpoints to
 * node objects, and callers pass unresolved string endpoints, so both are
 * accepted and compared by id.
 */
export function connectionsFor(
  id: string,
  graph: { nodes: readonly GraphNode[]; links: readonly ResolvedLink[] },
): Connection[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const connections: Connection[] = [];
  for (const link of graph.links) {
    const source = endpointId(link.source);
    const target = endpointId(link.target);
    const otherId = source === id ? target : target === id ? source : null;
    if (otherId === null) continue;
    const node = byId.get(otherId);
    if (node) connections.push({ node, relation: link.relation });
  }
  return connections;
}
