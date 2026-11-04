import { describe, expect, test } from "bun:test";
import {
  connectionsFor,
  endpointId,
  type GraphLink,
  type GraphNode,
  type ResolvedLink,
} from "../src/graph/model.ts";

const node = (id: string, hub = false): GraphNode => ({
  id,
  kind: hub ? "segment" : "pattern",
  label: id,
  description: "",
  radius: 4,
  degree: 0,
  hub,
});

const links: GraphLink[] = [
  { id: "a", source: "hub", target: "leaf", relation: "observed-in" },
  { id: "b", source: "leaf", target: "peer", relation: "similarity", similarity: 0.8 },
];

describe("endpointId", () => {
  test("unwraps ids from strings, numbers and resolved nodes", () => {
    expect(endpointId("leaf")).toBe("leaf");
    expect(endpointId(7)).toBe("7");
    expect(endpointId({ id: "leaf" })).toBe("leaf");
    expect(endpointId({ id: 7 })).toBe("7");
  });

  test("returns an empty id for an object without a usable id", () => {
    expect(endpointId({})).toBe("");
    expect(endpointId({ id: {} })).toBe("");
    expect(endpointId({ id: null })).toBe("");
  });
});

describe("connectionsFor", () => {
  const nodes = [node("hub", true), node("leaf"), node("peer")];

  test("finds relationships from either endpoint", () => {
    const hubConnections = connectionsFor("hub", { nodes, links });
    expect(hubConnections.map((c) => [c.node.id, c.relation])).toEqual([["leaf", "observed-in"]]);

    const peerConnections = connectionsFor("peer", { nodes, links });
    expect(peerConnections.map((c) => [c.node.id, c.relation])).toEqual([["leaf", "similarity"]]);
  });

  test("accepts links whose endpoints the simulation already resolved", () => {
    const resolved: ResolvedLink[] = [
      {
        id: "a",
        relation: "observed-in",
        source: nodes[0]!,
        target: nodes[1]!,
      },
    ];
    expect(connectionsFor("leaf", { nodes, links: resolved }).map((c) => c.node.id)).toEqual([
      "hub",
    ]);
  });

  test("ignores unknown nodes and self-referencing links", () => {
    const graph = {
      nodes,
      links: [
        ...links,
        { id: "ghost", source: "leaf", target: "missing", relation: "observed-in" as const },
        { id: "loop", source: "leaf", target: "leaf", relation: "similarity" as const },
      ],
    };
    expect(connectionsFor("leaf", graph).map((c) => c.node.id)).toEqual(["hub", "peer", "leaf"]);
  });

  test("returns nothing for an isolated node", () => {
    expect(connectionsFor("hub", { nodes: [node("hub")], links: [] })).toEqual([]);
  });
});
