import { describe, expect, test } from "bun:test";
import {
  connectionsFor,
  endpointId,
  type GraphLink,
  type GraphNode,
  type ResolvedLink,
} from "../src/graph/model.ts";

const node = (id: string, hub = false): GraphNode<{ note: string }> => ({
  id,
  label: id,
  data: { note: id },
  hub,
});

const links: GraphLink<{ kind: string }>[] = [
  { id: "a", source: "hub", target: "leaf", data: { kind: "observed" } },
  { id: "b", source: "leaf", target: "peer", data: { kind: "similarity" } },
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

  test("finds relationships from either endpoint and returns the joining link", () => {
    const hubConnections = connectionsFor("hub", { nodes, links });
    expect(hubConnections.map((c) => [c.node.id, c.link.id])).toEqual([["leaf", "a"]]);
    expect(hubConnections[0]!.link.data).toEqual({ kind: "observed" });

    const peerConnections = connectionsFor("peer", { nodes, links });
    expect(peerConnections.map((c) => [c.node.id, c.link.id])).toEqual([["leaf", "b"]]);
  });

  test("accepts links whose endpoints the simulation already resolved", () => {
    const resolved: ResolvedLink<{ kind: string }>[] = [
      { id: "a", source: nodes[0]!, target: nodes[1]!, data: { kind: "observed" } },
    ];
    expect(connectionsFor("leaf", { nodes, links: resolved }).map((c) => c.node.id)).toEqual([
      "hub",
    ]);
  });

  test("keeps node payloads untouched", () => {
    const connection = connectionsFor("leaf", { nodes, links })[0]!;
    expect(connection.node.data).toEqual({ note: "hub" });
  });

  test("ignores unknown nodes and counts a self-referencing link as one connection", () => {
    const graph: {
      nodes: GraphNode<{ note: string }>[];
      links: GraphLink<{ kind: string }>[];
    } = {
      nodes,
      links: [
        ...links,
        { id: "ghost", source: "leaf", target: "missing" },
        { id: "loop", source: "leaf", target: "leaf" },
      ],
    };
    expect(connectionsFor("leaf", graph).map((c) => c.node.id)).toEqual(["hub", "peer", "leaf"]);
  });

  test("returns nothing for an isolated node", () => {
    expect(connectionsFor("hub", { nodes: [node("hub")], links: [] })).toEqual([]);
  });
});
